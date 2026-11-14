#!/usr/bin/env python3
"""Wizard Factory - a retro dashboard that shows every coding agent as a pixel wizard.

Polls local and mage-tower agent transcripts, infers what each agent is doing, and serves
the tower at http://127.0.0.1:7777. No registration needed.

  python3 server.py                  # the real tower
  python3 server.py --demo           # a busy fake tower (for trying the UI)
  python3 server.py --install-hooks  # optional: instant permission/stop events via hooks
"""
import argparse
import atexit
import base64
import bisect
import ctypes
import hashlib
import json
import os
import random
import re
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter, defaultdict, deque, namedtuple
from datetime import datetime
from fnmatch import fnmatchcase
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from auto_continue import resume_limited

ROOT = Path(__file__).resolve().parent
PROJECTS = Path.home() / '.claude' / 'projects'
CODEX = Path.home() / '.codex' / 'sessions'
SETTINGS = Path.home() / '.claude' / 'settings.json'
HOOK_MARK = '#wizard-factory'
HOOK_EVENTS = ['Notification', 'Stop', 'UserPromptSubmit', 'SessionStart', 'SessionEnd']
SCAN_SEC, FRESH_SEC, TAIL_BYTES = 1.0, 3 * 3600, 512 * 1024
REMOTE_SCAN_SEC, REMOTE_USAGE_SEC, REMOTE_EMIT_SEC = 3.0, 60, 1.5
PROC_SEC, CI_SEC, ANNALS_SEC = 5, 60, 30
QUOTA_TIMEOUT = 600
SSH = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']
REMOTE_PYTHON = ['env', 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"', 'python3', '-']
RESPONDING_SEC, IDLE_SEC, GONE_SEC = 6, 15 * 60, 45 * 60
ABANDON_SEC, SUB_GONE_SEC = 2 * 3600, 150
CHAT_TURNS, CHAT_CHARS = 30, 700
LONG_RUN_SEC, MISSIVE_SEC, CLASH_SEC, BAND_SEC = 600, 15 * 60, 30 * 60, 3 * 3600
CLAUDE_WINDOW = 1_000_000  # Opus and Fable 5.x sessions routinely pass 200k tokens before compacting
BUSY_BEATS = {'tool_use', 'tool_result', 'user_text', 'thinking'}
STATUS_BEATS = BUSY_BEATS | {'assistant_text', 'interrupted'}
TITLE_PROMPT = 'Name this coding task in 2-4 lowercase words joined by underscores'
MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
        '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json'}

FILES = {}      # path -> FileState
CODEX_TITLES = (None, {})
PR_STATES = {}  # 'owner/repo#n' -> CI summary from gh
OVERRIDES = {}  # session_id -> latest hook event {event, ts, msg}
DEAD = {}       # session_id -> epoch of SessionEnd hook
HOSTS, REMOTES, STREAMS = [], {}, []  # remote hosts in faction order; host -> latest snapshot; live ssh processes
LOCAL_QUOTAS = None  # until the first usage read
TIMER_PROMPTS = []
CPU_USAGE, CPU_TIMES = None, None
LOCAL_RESOURCES = {}
CLAUDE_SESSIONS, PROCS, ORPHANS, LINEAGE = [], {}, [], {}  # session files, agent id -> load, strays, pid -> origin
ANNALS = {'stamp': 0, 'seen': {}, 'shelved': set(), 'days': {}}  # change counter, main agents last seen, books written
LOCK = threading.Lock()
MACH = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True) if sys.platform == 'darwin' else None
if MACH:
    MACH.mach_host_self.restype = ctypes.c_uint
    MACH.host_statistics.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
    MACH_HOST = MACH.mach_host_self()
BULK_STAT = getattr(MACH, 'getattrlistbulk', None) if MACH else None
if BULK_STAT:
    BULK_STAT.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint64]
    BULK_STAT.restype = ctypes.c_int


def epoch(ts):
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
    except Exception:
        return None


def clean(s, n=160):
    s = ' '.join(s.split())
    return s[:n] + ('…' if len(s) > n else '')


def snip(s, n=CHAT_CHARS):
    """Like clean, but keeps the paragraph breaks a chat log is worth reading with."""
    s = '\n'.join(line.rstrip() for line in s.strip().splitlines())
    while '\n\n\n' in s:
        s = s.replace('\n\n\n', '\n\n')
    return s[:n] + ('…' if len(s) > n else '')


def title_task(text):
    if not text.startswith(TITLE_PROMPT):
        return None
    return text.split('Task:', 1)[1].strip() if 'Task:' in text else ''


def generated_title(text):
    words = text.strip().splitlines()[0].split('_')
    return ' '.join(words) if 2 <= len(words) <= 4 and all(w.isalnum() and w.lower() == w for w in words) else None


def message_texts(content):
    return [content] if isinstance(content, str) else [b.get('text') or '' for b in content
        if isinstance(b, dict) and b.get('type') == 'text'] if isinstance(content, list) else []


PROMPT_WRAPPER = re.compile(r'\s*<(task|send_user_message_question_reply)>(.*?)(?:</\1>|$)', re.S)
SEALED = re.compile(r'\s*gAAAAA[\w-]{20,}=*\s*')  # a Fernet token: Codex encrypts messages between its agents


def text_of(value, default):
    return value if isinstance(value, str) and value else default


def answers(body):
    """A Codex question reply is a JSON list of {question, answer}; keep what was answered."""
    try:
        replies = json.loads(body)
        return '\n'.join(str(r['answer']) for r in replies if isinstance(r, dict) and r.get('answer'))
    except (ValueError, TypeError):
        return body.strip()


def peer_text(text):
    """The message itself, without the wrapper Claude puts around messages from other sessions."""
    text = re.sub(r'^Another Claude session sent a message:\s*', '', text)
    text = re.split(r'\n\s*This came from another Claude session', text)[0]
    return re.sub(r'</?[\w-]+(?:\s[^>]*)?>', '', text).strip()


def codex_texts(item):
    return [c.get('text') for c in item.get('content') or [] if isinstance(c, dict)]


def subagent_title(text):
    scope = next((line.removeprefix('## Your scope:').strip() for line in text.splitlines()
                  if line.startswith('## Your scope:')), '')
    if not scope and 'read-only ' in text:
        scope = text.split('read-only ', 1)[1].split(' of Black Lotus', 1)[0]
    return clean(scope, 90) or None


def tool_detail(name, inp):
    if not isinstance(inp, dict):
        return ''
    n = name.lower()
    get = lambda *ks: next((inp[k] for k in ks if isinstance(inp.get(k), str) and inp[k]), '')
    if n == 'bash':
        d = get('command')
    elif n in ('read', 'edit', 'write', 'notebookedit'):
        d = Path(get('file_path') or '?').name
    elif n in ('grep', 'glob'):
        d = get('pattern')
    elif n.startswith('web'):
        d = get('url', 'query')
    elif n in ('task', 'agent'):
        d = get('description', 'prompt')
    else:
        d = get('skill', 'name', 'description', 'query', 'url', 'command')
    return clean(d, 70)


# What a shell command is for, judged by its most significant command head.
CODEX_SHELLS = {'exec_command', 'shell', 'local_shell', 'container.exec'}
QUOTED = re.compile(r'"(?:\\.|[^"\\])*"|\'[^\']*\'')
HEREDOC = re.compile(r'<<-?\s*([\'"]?)(\w+)\1[^\n]*\n.*?(?:\n\s*\2\b|\Z)', re.S)
SEGMENT = re.compile(r'&&|\|\||[;|&\n()`]|\$\(|\b(?:do|then|else)\b')
ASSIGN, PYTHON = re.compile(r'[A-Za-z_]\w*='), re.compile(r'python[\d.]*|py|pypy3?')
PREFIXES = {'sudo', 'time', 'nohup', 'env', 'command', 'exec', 'nice', 'caffeinate', 'stdbuf', 'builtin', 'xargs',
            'npx', 'bunx', 'uvx', 'if', 'elif', 'while', 'until', '!', '{'}
RUNNERS = {('uv', 'run'), ('poetry', 'run'), ('pipenv', 'run'), ('pdm', 'run'), ('hatch', 'run'), ('bundle', 'exec'),
           ('npm', 'exec'), ('pnpm', 'exec'), ('pnpm', 'dlx'), ('yarn', 'dlx')}
VALUE_OPTIONS = {'--with', '--python', '-p', '--project', '--directory', '--from', '-w', '--extra', '--group',
                 '--env-file', '--package', '-C', '-u', '-n'}
QUIET = {'cd', 'pushd', 'popd', 'export', 'set', 'source', '.', 'true', 'false', ':', 'unset', 'local', 'echo',
         'printf', 'trap', 'wait', 'shopt', 'ulimit', 'alias', 'clear', 'test', '[', '[[', 'fi', 'done', 'esac', '}',
         'for', 'case', 'read', 'exit', 'return', 'eval', 'break', 'continue'}
HEADS = {head: act for act, heads in {
    'search': 'rg grep egrep fgrep ag ack fd find locate',
    'read': 'cat head tail sed awk less more bat nl jq yq wc diff cmp file stat readlink realpath du df xxd od '
            'hexdump strings sort uniq cut tr column ls tree pwd which whereis type basename dirname date printenv '
            'uname whoami hostname man otool nm plutil defaults sw_vers sysctl',
    'test': 'pytest jest vitest mocha tox nox rspec ctest phpunit',
    'lint': 'ruff eslint prettier black mypy pyright ty flake8 pylint shellcheck tsc biome isort stylelint '
            'golangci-lint rubocop clang-format rustfmt gofmt actionlint markdownlint yamllint hadolint',
    'build': 'cmake ninja gcc g++ clang clang++ rustc javac webpack vite esbuild rollup xcodebuild brew apt apt-get '
             'conda elan nix',
    'cloud': 'aws gcloud gsutil az kubectl helm terraform tofu pulumi ssh scp rsync docker podman flyctl vercel heroku',
    'query': 'psql mysql sqlite3 duckdb snowsql snow bq clickhouse redis-cli mongosh',
    'web': 'curl wget http https xh',
    'proc': 'ps top htop lsof pgrep kill pkill killall vm_stat iostat netstat ss pstree launchctl systemctl',
    'profile': 'py-spy perf valgrind hyperfine instruments dtrace sample heaptrack samply',
    'files': 'mkdir cp mv rm rmdir touch chmod chown ln tar zip unzip gzip gunzip tee install trash',
    'serve': 'uvicorn gunicorn flask rails nodemon http-server',
    'wait': 'watch',
}.items() for head in heads.split()}
BUILDERS = set('cargo go pants dotnet swift mix zig bazel bazelisk gradle gradlew mvn lake make just npm pnpm yarn bun '
               'deno uv poetry pip pip3'.split())
TASKS = [(re.compile(r'test|spec|e2e'), 'test'), (re.compile(r'lint|fmt|format|clippy|check|vet|tidy|typecheck'), 'lint'),
         (re.compile(r'^(?:dev|start|serve|preview|watch|up)$'), 'serve'), (re.compile(r'^(?:run|exec|x)$'), 'script')]
MODULES = {**dict.fromkeys(('pytest', 'unittest', 'tox', 'nox'), 'test'), 'pip': 'build', 'build': 'build', 'venv': 'build',
           **dict.fromkeys(('ruff', 'mypy', 'black', 'pyright', 'flake8', 'pylint', 'isort'), 'lint'),
           **dict.fromkeys(('cProfile', 'profile', 'pyinstrument'), 'profile'),
           **dict.fromkeys(('http.server', 'uvicorn', 'flask'), 'serve')}
GIT_COMMITS = set('commit merge rebase cherry-pick revert am tag'.split())  # these write history; the rest tend the tree
GIT_CHANGES = set('add rm mv restore reset stash checkout switch pull fetch worktree clean apply branch'.split())
GT_WRITES = set('submit create modify restack merge squash fold move split absorb reorder'.split())
JJ_WRITES = set('commit describe new squash rebase abandon split'.split())
GH_WRITES = set('create merge edit ready comment review close reopen'.split())
ACT_RANK = ['files', 'script', 'read', 'search', 'proc', 'git', 'tree', 'ci', 'web', 'query', 'cloud', 'profile', 'build',
            'serve', 'lint', 'test', 'commit', 'jujutsu', 'graphite', 'pr', 'push', 'wait']
FEAT_COMMANDS = [('rebase', re.compile(r'\bgit\s+(?:-\S+\s+)*rebase\b(?!\s+--abort)|\bgt\s+restack\b')),
                 ('merge', re.compile(r'\bgh\s+pr\s+merge\b|\bgt\s+merge\b|\bgit\s+merge\b(?!\s+--abort)'))]
PATCH_FILE = re.compile(r'^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$', re.M)
# Codex code mode runs JavaScript cells that call its tools: tools.exec_command({cmd: "..."}), and so on.
JS_STRING = r'"((?:\\.|[^"\\])*)"'
EXEC_CMD = re.compile(r'exec_command\(\s*\{\s*"?cmd"?\s*:\s*' + JS_STRING)
THREAD_MESSAGE = re.compile(r'send_message_to_thread\(\s*\{\s*"?threadId"?\s*:\s*' + JS_STRING + r'\s*,\s*"?prompt"?\s*:\s*' + JS_STRING)


def js_string(body):
    try:
        return json.loads(f'"{body}"')
    except ValueError:
        return body.replace('\\"', '"').replace('\\n', '\n')
PR_URL = re.compile(r'https://(?:github\.com/([\w.-]+/[\w.-]+)/pull|app\.graphite\.(?:com|dev)/github/pr/([\w.-]+/[\w.-]+))/(\d+)')


def shell_words(segment):
    words = segment.split()
    while words:
        if words[0] in PREFIXES or ASSIGN.match(words[0]):
            words = words[1:]
        elif words[0] == 'timeout' or (words[0].startswith('-') and words[0] in VALUE_OPTIONS):
            words = words[2:]
        elif tuple(words[:2]) in RUNNERS:
            words = words[2:]
        elif words[0].startswith('-'):  # options of a stripped prefix or runner
            words = words[1:]
        else:
            break
    return words


def act_of(words):
    head, rest = (Path(words[0]).name, words[1:]) if words else ('', [])
    sub = next((w for w in rest if not w.startswith('-')), '')
    if not head or head in QUIET:
        return None
    if head == 'sleep':
        return 'wait' if re.fullmatch(r'\d+(?:\.\d*)?', sub) and float(sub) >= 3 else None
    if head == 'tail' and {'-f', '-F', '--follow'} & set(rest):
        return 'wait'
    if head == 'git':
        i = 0
        while i < len(rest) and rest[i].startswith('-'):
            i += 2 if rest[i] in ('-C', '-c') else 1
        sub = rest[i] if i < len(rest) else ''
        return 'push' if sub == 'push' else 'search' if sub == 'grep' else 'commit' if sub in GIT_COMMITS else \
            'tree' if sub in GIT_CHANGES else 'git'
    if head == 'gh':
        return 'wait' if '--watch' in rest or 'watch' in rest else \
            'pr' if sub == 'pr' and len(rest) > 1 and rest[1] in GH_WRITES else 'ci'
    if head == 'jj' and sub == 'git':  # jj git push / fetch
        return 'jujutsu' if 'push' in rest else 'tree'
    if head in ('gt', 'jj'):
        return ('graphite' if head == 'gt' else 'jujutsu') if sub in (GT_WRITES if head == 'gt' else JJ_WRITES) else 'tree'
    if PYTHON.fullmatch(head):
        return MODULES.get(rest[rest.index('-m') + 1], 'script') if '-m' in rest[:-1] else 'script'
    if head == 'node':
        return 'test' if '--test' in rest else 'script'
    if head in BUILDERS:
        if head in ('npm', 'pnpm', 'yarn', 'bun', 'deno') and sub == 'run':
            sub = next((w for w in rest[rest.index('run') + 1:] if not w.startswith('-')), sub)
        return next((act for pattern, act in TASKS if pattern.search(sub)), 'build') if sub else 'build'
    return HEADS.get(head, 'script')


def shell_act(cmd):
    """Classify a shell command (read, search, test, build, push, wait, ...) by its most significant step."""
    cmd = re.sub(r'(?m)^\s*#.*$|\d?[<>]&\d|&>>?', ' ', HEREDOC.sub('', cmd))
    if wrapped := re.match(r'\s*(?:\S*/)?(?:ba|z)?sh\s+-\w*c\s+([\'"])(.*)\1\s*$', cmd, re.S):
        cmd = wrapped.group(2)
    acts = [act_of(shell_words(segment)) for segment in SEGMENT.split(QUOTED.sub('""', cmd))]
    return max(filter(None, acts), key=ACT_RANK.index, default=None)


def project_of(cwd):
    if not cwd:
        return '?'
    if '/.claude/worktrees/' in cwd:
        repo, wt = cwd.split('/.claude/worktrees/', 1)
        return Path(repo).name + '/' + wt.split('/')[0]
    return Path(cwd).name or '/'


def active_home():
    return Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex').expanduser().resolve()


def account_id(home):
    try:
        tokens = json.loads((home / 'auth.json').read_text()).get('tokens') or {}
        token = tokens['id_token'].split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(token + '=' * (-len(token) % 4)))
        identity = [tokens['account_id'], claims['sub']]
        return hashlib.sha256(json.dumps(identity).encode()).hexdigest()
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        return None


def claude_home():
    return Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude').expanduser().resolve()


def login_key(account, organization):
    return hashlib.sha256(json.dumps([account, organization]).encode()).hexdigest() if account and organization else None


def claude_id(home):
    config = Path.home() / '.claude.json' if home == (Path.home() / '.claude').resolve() else home / '.claude.json'
    try:
        account = json.loads(config.read_text())['oauthAccount']
        return login_key(account['accountUuid'], account['organizationUuid'])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def run_quota(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=QUOTA_TIMEOUT)
    if result.returncode == 2 and 'unrecognized arguments: --detailed-reset-timing' in result.stderr:
        result = subprocess.run([arg for arg in args if arg != '--detailed-reset-timing'],
                                capture_output=True, text=True, timeout=QUOTA_TIMEOUT)
    return result


def quota_label(name, provider):
    account, model = re.fullmatch(r'(.*?)\s*(Claude|Fable)?', name.strip()).groups()
    return {'name': ' '.join(filter(None, (account, model))) or 'Claude', 'account': account,
            'model': (model or 'Claude') if provider == 'claude' else None}


def account_quotas(listed):
    config = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'codex-quota/accounts.json'
    accounts = json.loads(config.read_text()) if listed and config.exists() else {}
    claude_accounts = {}
    if accounts and all(isinstance(v, dict) for v in accounts.values()):
        claude_accounts = accounts.get('claude') or {}
        accounts = accounts.get('codex') or {}
    homes = {name: (config.parent / Path(home).expanduser()).resolve() for name, home in accounts.items()}
    claude_homes = {name: (config.parent / Path(home).expanduser()).resolve()
                    for name, home in claude_accounts.items()}
    active_claude = claude_id(claude_home())
    active = account_id(active_home())
    if not listed and not active:
        return []
    identities = {name: account_id(home) for name, home in homes.items()}
    if not listed:
        name = 'In use'
        while name in homes:
            name += ' (active)'
        homes[name], identities[name] = active_home(), active
    args = ['token-quota', '--json', '--detailed-reset-timing']
    if listed:
        if not homes:
            args.append('--claude-only')
        else:
            args += ['--config', str(config)]
    else:
        args.append('--codex-only')
        # The local login may differ from the accounts configured on the remote host.
        with tempfile.TemporaryDirectory(prefix='wizard-quota-') as directory:
            path = Path(directory) / 'accounts.json'
            path.write_text(json.dumps({name: str(home) for name, home in homes.items()}))
            args += ['--config', str(path)]
            result = run_quota(args)
    if listed:
        result = run_quota(args)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr.strip() or 'token-quota failed')
    cli_accounts = json.loads(result.stdout)['accounts']
    readings = [{**r, 'id': identities[r['name']] or 'unknown:' + r['name'],
                 'provider': 'codex',
                 'origins': ['local'] if homes[r['name']] == active_home() or
                            (active and identities[r['name']] == active) else []}
                for r in cli_accounts if r.get('provider') != 'claude']
    if listed:
        for r in cli_accounts:
            if r.get('provider') != 'claude':
                continue
            label = quota_label(r['name'], 'claude')
            home = claude_homes.get(re.sub(r'\s+Fable$', '', r['name'])) if claude_homes else claude_home()
            identity = claude_id(home) if home else None
            readings.append({**r, 'loginId': identity,
                             'id': f'claude:{identity}:{label["model"]}' if identity else
                                   'claude:active' if r['name'] == 'Claude' else 'claude:' + r.get('id', r['name']),
                             'origins': ['local'] if home == claude_home() or
                                        (active_claude and identity == active_claude) else []})
    return [{'id': r['id'], **quota_label(r['name'], r['provider']),
             'tier': r.get('planTier'), 'provider': r['provider'],
             'period': 'weekly', 'origins': r['origins'],
             'left': max(0, min(100, 100 - r['weeklyUsedPercent'])) if r['weeklyUsedPercent'] is not None else None,
             'resets_at': r['weeklyResetsAt'], 'reset_detail': r.get('weeklyResetDetail'),
             'resets_left': r['availableResets'], 'error': r['error'],
             'reset_expirations': r.get('resetExpirations'),
             **{key: r[key] for key in ('loginId', 'updatedAt', 'cached', 'stale', 'retryAt', 'timerPrompt', 'loginExpired') if key in r}}
            for r in readings]


def record_timer_prompts(quotas):
    with LOCK:
        seen = {(p['id'], p['fact']) for p in TIMER_PROMPTS}
        for quota in quotas:
            prompt = quota.get('timerPrompt') or {}
            if prompt.get('status') != 'sent' or not prompt.get('fact'):
                continue
            key = (quota['id'], prompt['fact'])
            if key not in seen:
                TIMER_PROMPTS.append({'id': quota['id'], 'name': quota['name'],
                                      'provider': quota['provider'], 'fact': prompt['fact']})
                seen.add(key)


def merge_quotas(remote, local):
    accounts = {q['id']: {**q, 'origins': list(q['origins'])} for q in remote}
    for q in local:
        if q['id'] in accounts:
            existing = accounts[q['id']]
            accounts[q['id']] = {**(existing if q.get('error') else q), 'name': existing['name'],
                                 'origins': list(dict.fromkeys(existing['origins'] + q['origins']))}
        else:
            accounts[q['id']] = q
    return list(accounts.values())


def read_cpu_usage():
    global CPU_TIMES
    if sys.platform == 'darwin':
        ticks, count = (ctypes.c_uint * 4)(), ctypes.c_uint(4)
        if error := MACH.host_statistics(MACH_HOST, 3, ticks, ctypes.byref(count)):
            raise OSError(f'host_statistics failed: {error}')
        current = sum(ticks), ticks[2]
    else:
        fields = [int(n) for n in Path('/proc/stat').read_text().splitlines()[0].split()[1:]]
        current = sum(fields[:8]), fields[3] + (fields[4] if len(fields) > 4 else 0)
    previous, CPU_TIMES = CPU_TIMES, current
    if previous is None or current[0] <= previous[0]:
        return None
    return max(0, min(100, 100 * (1 - (current[1] - previous[1]) / (current[0] - previous[0]))))


def read_resources():
    cpu = read_cpu_usage()
    if cpu is None:
        time.sleep(.2)
        cpu = read_cpu_usage()
    if sys.platform == 'darwin':
        proc = subprocess.run(['sysctl', '-n', 'hw.memsize'], capture_output=True, text=True, timeout=5)
        proc.check_returncode()
        total = int(proc.stdout)
        proc = subprocess.run(['vm_stat'], capture_output=True, text=True, timeout=5)
        proc.check_returncode()
        lines = proc.stdout.splitlines()
        page = int(lines[0].split('page size of ')[1].split()[0])
        pages = {k: int(v.strip().rstrip('.')) for k, v in (line.split(':', 1) for line in lines[1:] if ':' in line)}
        used = page * (pages['Anonymous pages'] + pages['Pages wired down'] +
                       pages['Pages occupied by compressor'] - pages['Pages purgeable'])
    else:
        mem = {k: int(v.split()[0]) * 1024 for k, v in
               (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
        total, used = mem['MemTotal'], mem['MemTotal'] - mem['MemAvailable']
    disk = shutil.disk_usage(Path.home())
    return {'cpu': cpu, 'cores': os.cpu_count(), 'memoryUsed': max(0, min(total, used)),
            'memoryTotal': total, 'diskUsed': disk.used, 'diskTotal': disk.total, 'host': os.uname().nodename}


def lsof(args):
    try:
        return subprocess.run(['lsof', '-nP', *args], capture_output=True, text=True, timeout=10).stdout.splitlines()
    except (OSError, subprocess.SubprocessError):
        return []


def read_processes():
    """Load and listening ports of each Claude session's process tree, and processes that outlived their session."""
    sessions = []
    for path in (claude_home() / 'sessions').glob('*.json'):
        try:
            d = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and isinstance(d.get('pid'), int) and isinstance(d.get('sessionId'), str):
            sessions.append(d)
    procs, kids = {}, defaultdict(list)
    for line in subprocess.run(['ps', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pcpu=', '-o', 'rss=', '-o', 'command='],
                               capture_output=True, text=True, timeout=10).stdout.splitlines():
        if len(parts := line.split(None, 4)) == 5:
            procs[int(parts[0])] = (int(parts[1]), float(parts[2]), int(parts[3]) * 1024, parts[4])
            kids[int(parts[1])].append(int(parts[0]))
    owners = {s['sessionId']: (s['pid'], project_of(s.get('cwd'))) for s in sessions if s['pid'] in procs}
    ports, pid = defaultdict(set), None
    for line in lsof(['-iTCP', '-sTCP:LISTEN', '-F', 'pn']):
        if line[:1] == 'p':
            pid = int(line[1:])
        elif line[:1] == 'n' and line.rsplit(':', 1)[-1].isdigit():
            ports[pid].add(int(line.rsplit(':', 1)[1]))
    loads = {}
    for sid, (top, project) in owners.items():
        tree, stack = [], [top]
        while stack:
            tree.append(stack.pop())
            stack.extend(kids[tree[-1]])
        loads[sid] = {'cpu': round(sum(procs[p][1] for p in tree), 1), 'rss': sum(procs[p][2] for p in tree),
                      'procs': len(tree), 'ports': sorted({port for p in tree[1:] for port in ports[p]})}  # the agent's own are not portals
        LINEAGE.update({p: (sid, procs[p][3], project) for p in tree[1:]})
    for p in [p for p, (_, cmd, _) in LINEAGE.items() if procs.get(p, (0, 0, 0, None))[3] != cmd]:
        del LINEAGE[p]  # exited, or the pid now belongs to someone else
    strays = [{'pid': p, 'cmd': clean(cmd, 80), 'cpu': procs[p][1], 'rss': procs[p][2], 'project': project}
              for p, (sid, cmd, project) in LINEAGE.items() if sid not in owners]
    return sessions, loads, strays


CI_FAILED = {'FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'}


def read_ci(key):
    repo, number = key.rsplit('#', 1)
    proc = subprocess.run(['gh', 'pr', 'view', number, '--repo', repo, '--json',
                           'state,isDraft,reviewDecision,statusCheckRollup'], capture_output=True, text=True, timeout=30)
    if proc.returncode:
        return None
    d = json.loads(proc.stdout)
    checks = [c for c in d.get('statusCheckRollup') or [] if isinstance(c, dict)]
    running = any(c.get('status') not in (None, 'COMPLETED') or c.get('state') in ('PENDING', 'EXPECTED') for c in checks)
    failed = any((c.get('conclusion') or c.get('state')) in CI_FAILED for c in checks)
    return {'state': {'MERGED': 'merged', 'CLOSED': 'closed'}.get(d.get('state')) or
                     ('failing' if failed else 'pending' if running else 'passing' if checks else 'none'),
            'draft': bool(d.get('isDraft')), 'review': (d.get('reviewDecision') or '').lower() or None, 'checked': time.time()}


class FileState:
    def __init__(self, path):
        self.path, self.offset, self.rem, self.skip_first = path, 0, b'', False
        self.ino, self.mtime, self.retailed = 0, 0.0, 0.0
        self.engine = 'codex' if path.name.startswith('rollout-') else 'claude'
        self.oneshot = False  # fire-and-forget runs finish instead of awaiting counsel
        sub = path.parent.name == 'subagents'
        self.kind = 'sub' if sub else 'main'
        self.parent = path.parent.parent.name if sub else None
        self.id = '-'.join(path.stem.split('-')[6:]) or path.stem if self.engine == 'codex' else path.stem
        self.sid = self.parent or self.id  # session whose hook events apply
        self.cwd = self.branch = self.model = self.title = self.quest = None
        self.custom_title = None
        self.naming = False
        self.last_kind = self.tool = self.detail = self.last_ts = self.started = None
        self.status = self.since = None
        self.history = deque(maxlen=24)
        self.chat = deque(maxlen=CHAT_TURNS)  # your prompts and the agent's replies, in order
        self.act = self.effort = self.skill = self.login = self.cost = self.ctx = None
        self.agent_name = self.agent_path = None
        self.prs, self.touched = {}, {}  # 'owner/repo#n' -> PR, path -> last edit
        self.missives, self.inbox = deque(maxlen=16), deque(maxlen=16)
        self.beats = deque(maxlen=4000)  # (ts, kind) for the status band and the daily chronicle
        self.feats = Counter()           # evidence for earned epithets
        self.tokens = [0, 0]             # cached and total input tokens
        self.compactions = self.turns = self.fed = 0  # fed: file position up to which lines were read once
        self.replies = [0, 0]  # agent replies and their total length
        self.forked_at = self.own_from = None
        self.fresh, self.banded = True, (None, None)

    def feed(self, d, fresh=True):
        """Read one transcript line; `fresh` is false when a re-read tail replays it, so tallies skip it."""
        ts, order = epoch(d.get('timestamp') or ''), d.get('ordinal')
        if self.forked_at and (order < self.own_from if isinstance(order, int) and self.own_from else ts and ts < self.forked_at + 1):
            return  # a forked subagent's rollout opens with its parent's history, stamped at the fork
        self.fresh = fresh
        (self.feed_codex if self.engine == 'codex' else self.feed_claude)(d, ts)

    def feed_claude(self, d, ts):
        t, m = d.get('type'), d.get('message') or {}
        self.cwd, self.branch = text_of(d.get('cwd'), self.cwd), text_of(d.get('gitBranch'), self.branch)
        if t == 'custom-title':
            self.custom_title = clean(d.get('customTitle') or '', 90) or None
        elif t == 'ai-title':
            self.title = clean(d.get('aiTitle') or '', 90) or self.title
        elif t == 'summary':
            self.title = self.title or clean(d.get('summary') or '', 90)
        elif t == 'last-prompt':
            if d.get('lastPrompt') and self.kind == 'main':
                task = title_task(d['lastPrompt'])
                self.quest = clean(task if task is not None else d['lastPrompt'])
                self.naming = task is not None and not self.title
        elif t == 'pr-link':
            self._pr(d.get('prUrl'))
        elif t == 'cost-state':
            self.cost = {k: v if isinstance(v, (int, float)) else None for k, v in
                         (('usd', d.get('totalCostUSD')), ('added', d.get('totalLinesAdded')), ('removed', d.get('totalLinesRemoved')))}
        elif t == 'session-owner':
            self.login = login_key(d.get('accountUuid'), d.get('organizationUuid')) or self.login
        elif t == 'agent-name':
            self.agent_name = text_of(d.get('agentName'), self.agent_name)
        elif t == 'file-history-delta':
            self._touch(d.get('trackingPath'), ts)
        elif t == 'system' and d.get('subtype') == 'turn_duration':
            self._beat('turn_end' if not d.get('pendingBackgroundAgentCount') else 'turn_pending', ts)
        elif t == 'system' and d.get('subtype') == 'compact_boundary':
            meta = d.get('compactMetadata') or {}
            self._compacted(ts, meta.get('preTokens'), meta.get('postTokens'))
        elif t == 'user':
            c = m.get('content')
            texts = message_texts(c)
            if any(x.startswith('[Request interrupted') for x in texts):
                self._mark('interrupted', ts)
            real = next((x for x in texts if x and x[0] not in '<[' and not x.startswith(('Caveat:', 'This session is being continued'))), None)
            if real and not d.get('isMeta'):
                task = title_task(real)
                if task is not None:
                    real, self.naming = task, True
                elif self.kind == 'sub' and not self.title:
                    self.title = subagent_title(real)
                if self.kind == 'main' or not self.quest:
                    self.quest = clean(real)
                self._say('user', real, ts)
                self._mark('user_text', ts)
            if d.get('turnOrigin') == 'human':
                self._beat('human', ts)
            elif d.get('turnOrigin') == 'peer':
                self._receive((d.get('origin') or {}).get('from'), peer_text(' '.join(texts)), ts)
            if isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c):
                self._mark('tool_result', ts)
            result = d.get('toolUseResult') if isinstance(d.get('toolUseResult'), dict) else {}
            diff = result.get('bashEditDiff') if isinstance(result.get('bashEditDiff'), dict) else {}
            for path in diff.get('changedFiles') or []:
                self._touch(path, ts)
        elif t == 'assistant':
            self.model = text_of(m.get('model'), self.model)
            self.effort, self.skill = text_of(d.get('effort'), self.effort), text_of(d.get('attributionSkill'), None)
            if d.get('isApiErrorMessage') and d.get('error') == 'rate_limit':
                self._feat('limit')
            usage = m.get('usage') if isinstance(m.get('usage'), dict) else {}
            if used := sum(usage.get(k) or 0 for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')):
                self.ctx = [used, CLAUDE_WINDOW]
                self._tally(usage.get('cache_read_input_tokens') or 0, used)
            for b in m.get('content') or []:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'tool_use':
                    self._claude_tool(b.get('name') or '?', b.get('input') if isinstance(b.get('input'), dict) else {}, ts)
                elif b.get('type') == 'thinking':
                    self._mark('thinking', ts)
                elif b.get('type') == 'text' and (b.get('text') or '').strip():
                    text = b['text']
                    title = generated_title(text) if self.naming else None
                    if title:
                        self.title, self.naming = title, False
                        text = text.partition('\n')[2].strip()
                        if not text:
                            continue
                    self._say('agent', text, ts)
                    self._mark('assistant_text', ts)

    def _claude_tool(self, name, inp, ts):
        self.tool, self.detail, n = name, tool_detail(name, inp), name.lower()
        self._shell([inp['command']] if n == 'bash' and isinstance(inp.get('command'), str) else [])
        if n in ('edit', 'write', 'multiedit', 'notebookedit'):
            self._touch(inp.get('file_path') or inp.get('notebook_path'), ts)
        elif n == 'sendmessage':
            self._send(inp.get('to') or inp.get('recipient'), inp.get('recipient_kind'),
                       inp.get('summary') or inp.get('message') or inp.get('content'), ts)
        elif n in ('agent', 'task'):
            self._feat('spawn')
        self._mark('tool_use', ts)

    def feed_codex(self, d, ts):
        t, p = d.get('type'), d.get('payload') or {}
        pt = p.get('type')
        if t == 'session_meta':
            self.cwd = text_of(p.get('cwd'), self.cwd)
            self.id = self.sid = text_of(p.get('id'), self.id)
            self.branch = text_of((p.get('git') if isinstance(p.get('git'), dict) else {}).get('branch'), self.branch)
            self.agent_path = text_of(p.get('agent_path'), self.agent_path)
            if p.get('forked_from_id'):  # lines before the start ordinal are the parent's history
                start = p.get('subagent_history_start_ordinal')
                self.forked_at, self.own_from = ts, start if isinstance(start, int) else None
            src = p.get('source')
            if isinstance(src, dict):  # e.g. {'subagent': 'review'}
                self.kind, self.oneshot = 'sub', True
                self.parent = text_of(p.get('parent_thread_id'), self.parent)
            elif src == 'exec':
                self.oneshot = True
        elif t == 'turn_context':
            self.cwd, self.model = text_of(p.get('cwd'), self.cwd), text_of(p.get('model'), self.model)
            self.effort = text_of(p.get('effort'), self.effort)
        elif t == 'response_item':
            if pt == 'function_call':
                try:
                    args = json.loads(p.get('arguments') or '{}')
                except Exception:
                    args = {}
                args = args if isinstance(args, dict) else {}
                self.tool = name = p.get('name') or '?'
                self.detail = clean(str(next((args[k] for k in ('cmd', 'command', 'path', 'query', 'url', 'chars') if args.get(k)), '')), 70)
                cmd = (args.get('cmd') or args.get('command')) if name in CODEX_SHELLS else None
                if isinstance(cmd, list):  # ['bash', '-lc', script] in older rollouts
                    cmd = str(cmd[-1]) if len(cmd) > 2 and cmd[1] in ('-c', '-lc') else ' '.join(map(str, cmd))
                self._shell([cmd] if isinstance(cmd, str) else [])
                if name in ('send_message', 'followup_task'):
                    self._send(args.get('target'), 'codex', args.get('message'), ts)
                elif name == 'spawn_agent':
                    self._feat('spawn')
                self._mark('tool_use', ts)
            elif pt == 'custom_tool_call':  # apply_patch, and code-mode exec cells
                source, name = str(p.get('input') or ''), p.get('name') or '?'
                cmds = [js_string(c) for c in EXEC_CMD.findall(source)] if name == 'exec' else []
                self.tool, self.detail = name, clean(cmds[0] if cmds else source, 70)
                self._shell(cmds)
                for path in PATCH_FILE.findall(source.replace('\\n', '\n')):
                    self._touch(path, ts)
                for thread, prompt in THREAD_MESSAGE.findall(source):
                    self._send(js_string(thread), 'thread', js_string(prompt), ts)
                self._mark('tool_use', ts)
            elif pt == 'web_search_call':
                self.tool, self.detail, self.act = 'web_search', clean(str((p.get('action') or {}).get('query') or ''), 70), None
                self._mark('tool_use', ts)
            elif pt == 'tool_search_call':
                self.tool, self.detail, self.act = 'ToolSearch', '', None
                self._mark('tool_use', ts)
            elif pt in ('function_call_output', 'tool_search_output', 'custom_tool_call_output'):
                self._mark('tool_result', ts)
            elif pt == 'reasoning':
                self._mark('thinking', ts)
            elif pt == 'message' and p.get('role') == 'user':  # the only record of some prompts
                self._codex_prompt(codex_texts(p), ts)
        elif t == 'event_msg':
            item = p.get('item') if pt == 'item_completed' and isinstance(p.get('item'), dict) else {}
            kind = item.get('type')
            # Codex 0.16x records messages as completed items; older rollouts used user_message/agent_message.
            if pt == 'user_message' or kind == 'UserMessage':
                self._codex_prompt([p.get('message')] if pt == 'user_message' else codex_texts(item), ts)
            elif pt == 'task_started':
                self._mark('user_text', ts)
            elif pt == 'agent_message' or kind == 'AgentMessage':
                # Codex narrates as it goes; only the final answer belongs in the chat log.
                text = p.get('message') if pt == 'agent_message' else '\n'.join(filter(None, codex_texts(item)))
                if (p if pt == 'agent_message' else item).get('phase', 'final_answer') == 'final_answer' and isinstance(text, str) and text:
                    self._say('agent', text, ts)
                self._mark('thinking', ts)  # mid-turn commentary; task_complete marks the real end
            elif kind == 'FileChange':
                for path in item.get('changes') or {}:
                    self._touch(path, ts)
            elif kind == 'ContextCompaction':
                self._compacted(ts, None, None)
            elif kind == 'CommandExecution' and re.search(r'\b(?:gh\s+pr\s+create|gt\s+submit)\b', str(item.get('command'))):
                self._pr(str(item.get('aggregated_output') or ''))
            elif pt == 'token_count':
                info = p.get('info') if isinstance(p.get('info'), dict) else {}
                last = info.get('last_token_usage') if isinstance(info.get('last_token_usage'), dict) else {}
                if last.get('input_tokens') and info.get('model_context_window'):
                    self.ctx = [last['input_tokens'] + (last.get('output_tokens') or 0), info['model_context_window']]
                    self._tally(last.get('cached_input_tokens') or 0, last['input_tokens'])
                if (p.get('rate_limits') or {}).get('rate_limit_reached_type'):
                    self._feat('limit')
            elif pt == 'task_complete':
                if isinstance(p.get('last_agent_message'), str):
                    self._say('agent', p['last_agent_message'], ts)
                if 'usage' in str((p.get('error') or {}).get('codex_error_info')).lower():
                    self._feat('limit')
                self._mark('assistant_text', ts)
                self._beat('turn_end', ts)
            elif pt == 'thread_goal_updated':
                self.title = clean(str((p.get('goal') or {}).get('objective') or ''), 90) or self.title
            elif pt in ('turn_aborted', 'error'):
                if 'usage' in str(p.get('codex_error_info')).lower():
                    self._feat('limit')
                self._mark('interrupted', ts)

    def _codex_prompt(self, texts, ts):
        # Injected context, attachments, and abort notices share the user role but are not prompts.
        parts = [answers(m.group(2)) if (m := PROMPT_WRAPPER.match(s)) else s.strip() for s in texts if isinstance(s, str)]
        msg = '\n\n'.join(s for s in parts if s and s[0] not in '<[' and not s.startswith('# AGENTS.md instructions'))
        if not msg:
            return
        if self.kind == 'main' or not self.quest:
            self.quest = clean(msg)
        if self._say('user', msg, ts):
            self._beat('human', ts)
        self._mark('user_text', ts)

    def _shell(self, cmds):
        acts = [shell_act(cmd) for cmd in cmds]
        self.act = max(filter(None, acts), key=ACT_RANK.index, default=None)
        for cmd, act in zip(cmds, acts):
            for feat in [act] + [feat for feat, pattern in FEAT_COMMANDS if pattern.search(cmd)]:
                if feat:
                    self._feat(feat)

    def _feat(self, key):
        if self.fresh:
            self.feats[key] += 1

    def _tally(self, cached, used):
        if self.fresh:
            self.tokens = [self.tokens[0] + cached, self.tokens[1] + used]

    def _beat(self, kind, ts):
        if self.fresh:
            self.beats.append((ts, kind))
            self.turns += kind == 'turn_end'

    def _touch(self, path, ts):
        if isinstance(path, str) and path and ts:
            path = os.path.normpath(os.path.join(self.cwd or '/', os.path.expanduser(path)))
            self.touched[path] = max(ts, self.touched.pop(path, 0))
            if len(self.touched) > 64:
                del self.touched[next(iter(self.touched))]

    def _pr(self, text):
        for m in PR_URL.finditer(text or ''):
            key = f'{m.group(1) or m.group(2)}#{m.group(3)}'
            self.prs.pop(key, None)
            self.prs[key] = {'repo': m.group(1) or m.group(2), 'number': int(m.group(3))}

    def _send(self, to, via, text, ts):
        if self.fresh and to and ts:
            text = '' if SEALED.fullmatch(str(text or '')) else clean(str(text or ''), 160)  # Codex encrypts agent messages
            self.missives.append({'ts': ts, 'to': str(to), 'via': str(via or ''), 'text': text})
            self.feats['missive'] += 1

    def _receive(self, sender, text, ts):
        if self.fresh and sender and ts:
            self.inbox.append({'ts': ts, 'from': str(sender), 'text': clean(text, 160)})

    def _compacted(self, ts, before, after):
        if self.fresh:
            self.compactions += 1
            self._record('compact', ts, 'Compacted its memory' +
                         (f': {before // 1000}K → {after // 1000}K tokens' if before and after else ''))

    def _say(self, role, raw, ts):
        text = snip(raw)
        if not text or not ts:
            return False
        if self.chat and (ts < self.chat[-1]['ts'] or   # a re-read tail replays the whole exchange
                          (self.chat[-1]['role'] == role and self.chat[-1]['text'] == text)):
            return False
        self.chat.append({'ts': ts, 'role': role, 'text': text})
        if role == 'agent':
            self.replies = [self.replies[0] + 1, self.replies[1] + len(raw)]
        return True

    def _mark(self, kind, ts):
        if ts and self.last_ts and kind == 'tool_result' and self.last_kind == 'tool_use' and \
                ts - self.last_ts > LONG_RUN_SEC and self.act in ('test', 'build', 'lint', 'serve', 'wait'):
            self._feat('long')
        if ts and kind == 'tool_use' and time.localtime(ts).tm_hour < 5:
            self._feat('night')
        self.last_kind = kind
        if ts:
            self.last_ts, self.started = ts, self.started or ts
            self._record(kind, ts)
            self._beat(kind, ts)

    def _record(self, kind, ts, text=None):
        if text:
            pass
        elif kind == 'tool_use':
            text = f'{self.tool}: {self.detail}' if self.detail else self.tool
        elif kind == 'tool_result' and self.tool:
            text = f'{self.tool} completed'
        elif kind == 'user_text':
            text = f'New counsel: {self.quest}' if self.quest else 'Received new counsel'
        elif kind == 'assistant_text':
            text = 'Delivered a response'
        elif kind == 'interrupted':
            text = 'Work interrupted'
        else:
            return
        text = clean(text, 120)
        if self.history and ts < self.history[-1]['ts']:
            return
        if self.history and self.history[-1]['text'] == text and ts - self.history[-1]['ts'] < 2:
            return
        self.history.append({'ts': ts, 'kind': kind, 'tool': self.tool if kind in ('tool_use', 'tool_result') else None, 'text': text})

    def derive(self, now):
        if not self.last_ts:
            return
        age = now - self.last_ts                          # age of last *content* line
        live = now - max(self.last_ts, self.mtime)        # file activity: bridge sessions flush content lazily
        if DEAD.get(self.sid, 0) > max(self.last_ts, self.mtime) - 10:  # ended, and no signs of life since
            st = 'gone'
        else:
            if self.last_kind == 'tool_use':
                st = 'working'
            elif self.last_kind in ('tool_result', 'user_text', 'thinking'):
                st = 'thinking'
            else:
                st = 'done' if self.kind == 'sub' or self.oneshot else 'waiting'
            if self.last_kind == 'assistant_text':
                st = 'done' if self.kind == 'sub' or self.oneshot else ('responding' if age < RESPONDING_SEC else 'waiting')
            if st == 'thinking' and live > 300:  # interrupted/killed mid-turn; nobody ponders that long
                st = 'done' if self.kind == 'sub' or self.oneshot else 'waiting'
            ov = OVERRIDES.get(self.sid)
            if ov and ov['ts'] > self.last_ts and self.kind == 'main':
                if ov['event'] == 'Notification' and st in ('working', 'thinking'):
                    st = 'attention'
                elif ov['event'] == 'Stop' and st in ('working', 'thinking', 'responding'):
                    st = 'waiting'
                elif ov['event'] == 'UserPromptSubmit':
                    st = 'thinking'
            if st == 'waiting' and live > IDLE_SEC:
                st = 'idle'
            if (st in ('waiting', 'idle') and live > GONE_SEC) or (st in ('working', 'thinking') and live > ABANDON_SEC) or (st == 'done' and live > SUB_GONE_SEC):
                st = 'gone'
        if st != self.status:
            self.since = self.last_ts if self.status is None else now
            self.status = st

    def band(self, now):
        """Busy, waiting, and idle stretches over the last BAND_SEC as [[start, 'b'|'w'|'i'|'-'], ...]."""
        key = (len(self.beats), self.beats[-1] if self.beats else None, int(now // 15))
        if self.banded[0] == key:
            return self.banded[1]
        marks = []
        for ts, kind in reversed(self.beats):
            if kind in STATUS_BEATS:
                marks.append((ts, kind))
                if ts < now - BAND_SEC:
                    break
        out, done = [], self.kind == 'sub' or self.oneshot
        for (ts, kind), end in zip(reversed(marks), [ts for ts, _ in reversed(marks)][1:] + [now]):
            spans = ([(ts, 'b'), (ts + ABANDON_SEC, '-')] if kind == 'tool_use' else
                     [(ts, 'b'), (ts + 300, '-' if done else 'w')] if kind in ('tool_result', 'user_text', 'thinking') else
                     [(ts, '-')] if done else [(ts, 'w'), (ts + IDLE_SEC, 'i'), (ts + GONE_SEC, '-')])
            for start, state in spans:
                if start < end and end > now - BAND_SEC and (not out or out[-1][1] != state):
                    out.append([max(round(start), round(now - BAND_SEC)), state])
        self.banded = (key, out)
        return out

    def earned(self):
        return {**self.feats, 'cached': round(100 * self.tokens[0] / self.tokens[1]) if self.tokens[1] > 2e6 else 0,
                'verbose': round(self.replies[1] / self.replies[0]) if self.replies[0] >= 4 else 0}

    def payload(self, now=None):
        now, ov = now or time.time(), OVERRIDES.get(self.sid) or {}
        history = [h for h in self.history if h['tool'] != 'exec']
        if self.tool == 'exec' and self.last_kind == 'tool_use':
            history.append({'ts': self.last_ts, 'kind': 'tool_use', 'tool': 'exec',
                            'text': clean(f'exec running: {self.detail or ""}', 120)})
        return {'id': self.id, 'kind': self.kind, 'engine': self.engine, 'parent': self.parent, 'project': project_of(self.cwd),
                'branch': self.branch, 'title': self.custom_title or self.title, 'quest': self.quest, 'model': self.model,
                'status': self.status, 'tool': self.tool, 'detail': self.detail, 'act': self.act,
                'since': self.since, 'last': max(self.last_ts or 0, self.mtime) or None, 'started': self.started,
                'msg': ov.get('msg') if self.status == 'attention' else None, 'history': history,
                'chat': list(self.chat), 'cwd': self.cwd, 'effort': self.effort, 'skill': self.skill, 'login': self.login,
                'cost': self.cost, 'ctx': self.ctx, 'compactions': self.compactions, 'feats': self.earned(),
                'prs': list(self.prs.values())[-4:],
                'turns': self.turns, 'band': self.band(now)}


def retail(fs, size):
    # Start 1 byte early and always drop the first segment: it is empty iff the
    # preceding byte was a newline, so lines on the boundary are never lost.
    fs.offset = max(0, size - TAIL_BYTES - 1)
    fs.rem, fs.skip_first = b'', fs.offset > 0


def restore_claude_title(fs):
    naming, want_quest = False, fs.kind == 'sub' and not fs.quest
    try:
        with open(fs.path, 'rb') as f:
            while f.tell() <= fs.offset:
                line = f.readline()
                if not line:
                    break
                if b'"custom-title"' not in line and TITLE_PROMPT.encode() not in line and \
                        not (naming and b'"assistant"' in line) and not (want_quest and b'"user"' in line):
                    continue
                try:
                    event = json.loads(line)
                    if event.get('type') == 'custom-title':
                        fs.feed(event)
                    elif event.get('type') == 'user':
                        content = (event.get('message') or {}).get('content')
                        texts = message_texts(content)
                        naming = any(title_task(text) is not None for text in texts)
                        real = next((text for text in texts if text and text[0] not in '<[' and
                                     not text.startswith(('Caveat:', 'This session is being continued'))), None)
                        if want_quest and real and not naming:
                            fs.quest, fs.title = clean(real), fs.title or subagent_title(real)
                            want_quest = False
                    elif naming and event.get('type') == 'assistant':
                        texts = message_texts((event.get('message') or {}).get('content'))
                        title = next(filter(None, map(generated_title, texts)), None)
                        if title:
                            fs.title, naming = title, False
                except (ValueError, AttributeError):
                    continue
        fs.naming = naming and not fs.title
    except OSError:
        pass


def codex_titles():
    global CODEX_TITLES
    titles = {}
    try:
        path = CODEX.parent / 'session_index.jsonl'
        st = path.stat()
        key = (path, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        if key == CODEX_TITLES[0]:
            return CODEX_TITLES[1]
        with open(path) as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    if isinstance(entry, dict) and entry.get('id') and isinstance(entry.get('thread_name'), str):
                        titles[entry['id']] = clean(entry['thread_name'], 90)
                except (ValueError, TypeError):
                    continue
    except OSError:
        return titles
    CODEX_TITLES = (key, titles)
    return titles


ScanStat = namedtuple('ScanStat', 'st_ino st_size st_mtime')
BULK_COMMON = 0x02000409  # ATTR_CMN_NAME | OBJTYPE | MODTIME | FILEID
BULK_RECORD = struct.Struct('=I5IIiIIqqQ')


def bulk_transcripts(root, pattern, cutoff):
    # getattrlistbulk(2): returned attributes, error, name reference, type, mtime, inode.
    attrs = ctypes.create_string_buffer(struct.pack('=HH5I', 5, 0, BULK_COMMON | 0xa0000000, 0, 0, 0x200, 0))
    buf = ctypes.create_string_buffer(65536)
    entries = []
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        while True:
            count = BULK_STAT(fd, attrs, buf, len(buf), 8)  # FSOPT_PACK_INVAL_ATTRS
            if count < 0:
                raise OSError(ctypes.get_errno(), 'getattrlistbulk', root)
            if not count:
                return entries
            data, offset = buf.raw, 0
            for _ in range(count):
                pos = offset
                length, common, _, _, files, _, error, nameoff, nlen, kind, sec, nsec, ino = BULK_RECORD.unpack_from(data, pos)
                start, offset = pos + 28 + nameoff, pos + length
                if (length < BULK_RECORD.size or offset > len(data) or start < pos + BULK_RECORD.size or
                        nlen < 1 or start + nlen > offset or data[start + nlen - 1] != 0):
                    raise ValueError('Invalid bulk directory entry')
                available = not error and kind == 1 and common & BULK_COMMON == BULK_COMMON and files & 0x200
                if available:
                    if start < pos + BULK_RECORD.size + 8 or not 0 <= nsec < 1000000000:
                        raise ValueError('Invalid bulk file attributes')
                    mtime = sec + nsec * 1e-9
                    if mtime < cutoff:
                        continue
                name = os.fsdecode(data[start:start + nlen - 1])
                if '/' in name or '\0' in name:
                    raise ValueError('Invalid bulk entry name')
                if not fnmatchcase(name, pattern):
                    continue
                path = os.path.join(root, name)
                if available:
                    size, = struct.unpack_from('=q', data, pos + BULK_RECORD.size)
                    if size < 0:
                        raise ValueError('Invalid bulk file size')
                    st = ScanStat(ino, size, mtime)
                else:
                    try:
                        st = os.stat(path)  # Follow symlinks and handle unavailable attributes.
                    except OSError:
                        continue
                    if st.st_mtime < cutoff:
                        continue
                entries.append((path, st))
    finally:
        os.close(fd)


def transcript_entries(root, parts, cutoff):
    if BULK_STAT and len(parts) == 1:
        try:
            yield from bulk_transcripts(root, parts[0], cutoff)
            return
        except (OSError, ValueError, struct.error):
            pass
    try:
        with os.scandir(root) as entries:
            for entry in entries:
                if not fnmatchcase(entry.name, parts[0]):
                    continue
                if len(parts) == 1:
                    try:
                        st = entry.stat()
                        if st.st_mtime >= cutoff:
                            yield entry.path, st
                    except OSError:
                        continue
                else:
                    try:
                        if entry.is_dir():
                            yield from transcript_entries(entry.path, parts[1:], cutoff)
                    except OSError:
                        continue
    except OSError:
        pass


def scan_once(now):
    titles = codex_titles()
    seen = set()
    patterns = [(PROJECTS, ('*', '*.jsonl')), (PROJECTS, ('*', '*', 'subagents', '*.jsonl')),
                (CODEX, ('*', '*', '*', 'rollout-*.jsonl'))]
    for path, st in (entry for root, parts in patterns for entry in transcript_entries(root, parts, now - FRESH_SEC)):
        f = Path(path)
        seen.add(f)
        fs = FILES.get(f)
        if not fs:
            fs = FILES[f] = FileState(f)
            fs.ino = st.st_ino
            retail(fs, st.st_size)
            if fs.engine == 'claude' and fs.offset:
                restore_claude_title(fs)
            if fs.engine == 'codex' and fs.offset:  # session_meta is line 1; don't lose it to tailing
                try:
                    with open(f, 'rb') as fh:
                        fs.feed(json.loads(fh.readline()))
                except Exception:
                    pass
        elif st.st_ino != fs.ino or st.st_size < fs.offset:  # replaced or truncated
            fs.ino, fs.fed = st.st_ino, min(fs.fed, st.st_size)
            retail(fs, st.st_size)
        elif fs.offset and st.st_size == fs.offset and st.st_mtime > fs.mtime:  # same-size in-place rewrite
            retail(fs, st.st_size)
        fs.mtime = st.st_mtime
        if st.st_size > fs.offset:
            try:
                with open(f, 'rb') as fh:
                    fh.seek(fs.offset)
                    chunk = fh.read(st.st_size - fs.offset)
            except OSError:
                continue
            end = fs.offset - len(fs.rem)  # file position just past each line, for spotting re-read lines
            fs.offset += len(chunk)
            rem_empty = not fs.rem
            lines = (fs.rem + chunk).split(b'\n')
            fs.rem = lines.pop()
            ok = bad = 0
            first_ok = None
            for i, ln in enumerate(lines):
                end += len(ln) + 1
                if (i == 0 and fs.skip_first) or not ln.strip():
                    continue
                try:
                    fs.feed(json.loads(ln), end > fs.fed)
                    ok += 1
                except Exception:
                    bad += 1
                fs.fed = max(fs.fed, end)
                if first_ok is None:
                    first_ok = not bad
            fs.skip_first = False
            if bad >= 3 and not ok:  # not a transcript at all; just follow future appends
                fs.offset, fs.rem, fs.skip_first = st.st_size, b'', False
            elif first_ok is False and rem_empty and now - fs.retailed > 30:  # desynced by a rewrite
                fs.retailed = now
                retail(fs, st.st_size)
        if fs.engine == 'codex':
            fs.custom_title = titles.get(fs.id)
        fs.derive(now)
    for f in set(FILES) - seen:
        FILES.pop(f)
    cut = now - FRESH_SEC
    for k in [k for k, v in OVERRIDES.items() if v['ts'] < cut]:
        del OVERRIDES[k]
    for k in [k for k, v in DEAD.items() if v < cut]:
        del DEAD[k]


class Demo:
    TOOLS = [('Bash', 'pytest -q tests/spells'), ('Read', 'grimoire.py'), ('Edit', 'spellbook.ts'),
             ('Grep', 'TODO|HACK'), ('WebFetch', 'docs.python.org'), ('Write', 'prophecy.md'),
             ('Task', 'scout the catacombs'), ('TodoWrite', 'quest log'), ('Bash', 'make build && make test'),
             ('Monitor', 'npm test'), ('mcp__chrome_devtools__take_screenshot', 'localhost canvas check'),
             ('mcp__browser__snapshot', 'app state'), ('Bash', 'git push origin HEAD'),
             ('Bash', 'gt submit --stack'), ('Bash', 'jj git push'), ('Read', 'tome_of_errors.log'),
             ('WebSearch', 'ancient rune syntax'), ('Edit', 'cauldron.yaml')]
    QUESTS = ['Slay the flaky test of Auth Keep', 'Refactor the potion pipeline', 'Chart the realm of microservices',
              'Tame the wild memory leak', 'Forge a new login portal', 'Decode the ancient YAML scrolls',
              'Banish the segfault demon', 'Polish the crystal dashboard', 'Mend the broken CI golem',
              'Index the infinite scroll']
    PROJ = ['espresso', 'black-lotus', 'emacs', 'wizard-factory']

    def __init__(self):
        self.n, self.ags, self.rng = 0, {}, random.Random(7)
        for _ in range(9):
            self.spawn(time.time())

    def spawn(self, now, parent=None):
        self.n, r = self.n + 1, self.rng
        origin = self.ags[parent]['origin'] if parent else 'remote' if self.n % 3 == 0 else 'local'
        self.ags[f'demo-{self.n}'] = {
            'id': f'demo-{self.n}', 'kind': 'sub' if parent else 'main', 'parent': parent,
            'engine': 'codex' if not parent and self.rng.random() < .18 else 'claude',
            'origin': origin, 'host': 'mage-tower' if origin == 'remote' else None,
            'project': self.rng.choice(self.PROJ), 'branch': None, 'title': None,
            'quest': self.rng.choice(self.QUESTS), 'model': 'claude-fable-5', 'status': 'thinking',
            'tool': None, 'detail': None, 'msg': None, 'since': now, 'last': now, 'started': now,
            'history': [{'ts': now, 'kind': 'user_text', 'tool': None, 'text': 'Received a new quest'}],
            'chat': [{'ts': now - 90, 'role': 'user', 'text': self.rng.choice(self.QUESTS) + ', please.'},
                     {'ts': now - 30, 'role': 'agent', 'text': 'Aye. Reading the scrolls first:\n\n- the '
                      'cauldron logs\n- the questbook\n\nI will report once the rite holds.'}],
            'act': None, 'effort': r.choice(['medium', 'high', 'xhigh', 'max']), 'skill': None, 'login': 'demo-login',
            'ctx': [r.randint(40, 900) * 1000, CLAUDE_WINDOW], 'compactions': r.randint(0, 2), 'turns': r.randint(0, 9),
            'cost': {'usd': round(r.uniform(.2, 9), 2), 'added': r.randint(3, 400), 'removed': r.randint(0, 120)},
            'prs': [{'repo': 'arcana/tower', 'number': 4000 + self.n, 'ci': {'state': r.choice(['passing', 'pending', 'failing'])}}]
                   if not parent and r.random() < .4 else [],
            'feats': {r.choice(['search', 'rebase', 'test', 'spawn', 'night']): r.randint(1, 60)},
            'load': {'cpu': round(r.uniform(0, 140), 1), 'rss': r.randint(200, 3000) * 2**20, 'procs': r.randint(1, 9),
                     'ports': [5173] if r.random() < .2 else []} if not parent else None,
            'missives': [], 'inbox': [], 'clash': [], 'cwd': '/src/tower',
            '_band': [[now - r.uniform(600, BAND_SEC), 'w'], [now - r.uniform(60, 600), 'b']],
            '_next': now + self.rng.uniform(2, 5)}

    def step(self, a, now):
        r = self.rng

        def go(s, lo, hi, **kw):
            a.update(status=s, since=now, last=now, _next=now + r.uniform(lo, hi), **kw)
            band = {'working': 'b', 'thinking': 'b', 'responding': 'b', 'attention': 'b', 'waiting': 'w', 'idle': 'i'}.get(s, '-')
            if a['_band'][-1][1] != band:
                a['_band'] = [*a['_band'][-30:], [now, band]]
            if kw.get('tool'):
                a['act'] = shell_act(kw.get('detail', '')) if kw['tool'] == 'Bash' else None
                a['ctx'][0] = min(a['ctx'][1], a['ctx'][0] + r.randint(2, 30) * 1000)
                a['history'] = [*a['history'][-11:], {'ts': now, 'kind': 'tool_use', 'tool': kw['tool'], 'text': kw['tool'] + ': ' + kw.get('detail', '')}]
        st = a['status']
        if st == 'thinking':
            t = r.choice(self.TOOLS)
            go('working', 6, 16, tool=t[0], detail=t[1])
        elif st == 'working':
            if a['kind'] == 'sub' and r.random() < .3:
                go('done', 8, 12, tool=None, msg=None)
            elif r.random() < .15:
                go('attention', 12, 25, msg=f"Agent needs your permission to use {a['tool']}")
            elif r.random() < .6:
                go('thinking', 2, 6, tool=None, msg=None)
            else:
                go('responding', 2, 5, tool=None, msg=None)
        elif st == 'attention':
            go('working', 4, 10, msg=None)
        elif st == 'responding':
            go('waiting', 15, 45) if a['kind'] == 'main' else go('done', 8, 12)
        elif st == 'waiting':
            go('idle', 20, 40) if r.random() < .3 else go('gone', 3, 5) if r.random() < .3 else go('thinking', 3, 7)
        elif st == 'idle':
            go('thinking', 3, 6) if r.random() < .5 else go('gone', 3, 5)
        else:  # done / gone -> recycle
            del self.ags[a['id']]
            mains = [x['id'] for x in self.ags.values() if x['kind'] == 'main']
            self.spawn(now, parent=r.choice(mains) if mains and r.random() < .35 else None)

    def payload(self, now):
        for a in list(self.ags.values()):
            if now >= a['_next']:
                self.step(a, now)
        mains = [a for a in self.ags.values() if a['kind'] == 'main' and a['status'] != 'gone']
        if len(mains) > 1 and self.rng.random() < .04:  # an occasional missive, and one pair sharing a spellbook
            x, y = self.rng.sample(mains, 2)
            x['missives'] = [*x['missives'][-3:], {'ts': now, 'to': y['id'], 'via': 'agent', 'text': 'The wards on auth hold.'}]
        for a in self.ags.values():
            a['clash'] = [{'with': o['id'], 'paths': ['/src/tower/spellbook.ts']} for o in mains[:2] if o is not a] \
                if a in mains[:2] else []
        return [{**{k: v for k, v in a.items() if not k.startswith('_')}, 'band': a['_band']}
                for a in self.ags.values() if a['status'] != 'gone']

    def annals(self):
        now, r = time.time(), random.Random(3)
        days = [{'date': time.strftime('%Y-%m-%d', time.localtime(now - i * 86400)), 'busy': r.uniform(4, 30) * 3600,
                 'turns': r.randint(20, 160), 'prompts': r.randint(15, 120), 'sessions': r.randint(3, 20),
                 'lat': [r.randint(0, 9) for _ in range(len(LAT_EDGES) + 1)]} for i in range(10)]
        library = [book({'id': f'demo-book-{i}', 'engine': 'codex' if i % 4 == 0 else 'claude', 'title': q,
                         'quest': q + ', please.', 'project': self.PROJ[i % len(self.PROJ)], 'cwd': '/src/tower',
                         'started': now - (i + 2) * 5400, 'last': now - (i + 1) * 5400, 'turns': 3 + i,
                         'prs': [{'repo': 'arcana/tower', 'number': 3900 + i, 'ci': {'state': 'merged'}}] if i % 3 == 0 else [],
                         'chat': [{'role': 'agent', 'text': 'The rite holds. All tests pass.'}]})
                   for i, q in enumerate(self.QUESTS)]
        return {'edges': LAT_EDGES, 'days': days, 'library': library}


def link_agents(ags, states, now):
    """Fill in what one transcript says about another: Codex subagent tasks, missive recipients, shared files."""
    by_id = {fs.id: fs for fs in states}
    sockets = {s.get('messagingSocketPath'): s.get('sessionId') for s in CLAUDE_SESSIONS}
    names = {**{s.get('name'): s.get('sessionId') for s in CLAUDE_SESSIONS}, **{fs.agent_name: fs.id for fs in states if fs.agent_name}}

    def root(fs, depth=0):
        return root(by_id[fs.parent], depth + 1) if fs.parent in by_id and depth < 8 else fs

    def resolve(fs, to, via):
        if via == 'codex':  # '/root', '/root/task', or a bare task name relative to the sender
            here, top = fs.agent_path or '/root', root(fs)
            tree = {x.agent_path or '/root': x.id for x in states if x.engine == 'codex' and root(x) is top}
            paths = [to] if to.startswith('/') else [f'{here}/{to}', f'{here.rsplit("/", 1)[0]}/{to}', f'/root/{to}']
            return next((tree[p] for p in paths if p in tree), None)
        if to == 'main' or via == 'main':  # a Claude subagent writing to the session that summoned it
            return fs.parent if fs.parent in by_id else None
        if to.startswith('uds:') or via == 'session':
            return sockets.get(to[4:] if to.startswith('uds:') else to)
        return 'tower' if to == 'wizard-factory' else next((i for i in (to, 'agent-' + to) if i in by_id),
                                                           names.get(re.sub(r'\s*\[\w+\]$', '', to)))  # 'name [id]'

    shared = defaultdict(list)
    for fs, a in zip(states, ags):
        if fs.engine == 'codex' and fs.kind == 'sub' and fs.agent_path:  # the task itself is encrypted
            a['title'] = a['title'] or fs.agent_path.rsplit('/', 1)[-1].replace('_', ' ')
        a['missives'] = [{**m, 'to': resolve(fs, m['to'], m['via'])} for m in fs.missives if now - m['ts'] < MISSIVE_SEC]
        # Messages from agents in view are drawn from the sender's side; keep the rest (the tower, strangers).
        a['inbox'] = [{**m, 'from': sender} for m in fs.inbox
                      if now - m['ts'] < MISSIVE_SEC and (sender := resolve(fs, m['from'], '')) not in by_id]
        for path, ts in fs.touched.items():
            if now - ts < CLASH_SEC and a['status'] != 'done':
                shared[path].append(a)
    clashes = defaultdict(lambda: defaultdict(list))
    for path, group in shared.items():
        for i, x in enumerate(group):
            for y in group[i + 1:]:
                if x['id'] not in (y['id'], y['parent']) and y['id'] != x['parent']:
                    clashes[x['id']][y['id']].append(path)
                    clashes[y['id']][x['id']].append(path)
    for a in ags:
        a['clash'] = [{'with': other, 'paths': paths[-6:]} for other, paths in clashes[a['id']].items()]
    return ags


def remote_agents(host, payload):
    agents = payload.get('agents', []) if isinstance(payload, dict) else []
    ns = lambda i: f'{host}:{i}' if isinstance(i, str) and i != 'tower' else i
    return [{**a, 'id': ns(a['id']), 'parent': ns(a.get('parent')), 'origin': 'remote', 'host': host,
             'missives': [{**m, 'to': ns(m.get('to'))} for m in a.get('missives') or [] if isinstance(m, dict)],
             'clash': [{**c, 'with': ns(c.get('with'))} for c in a.get('clash') or [] if isinstance(c, dict)]}
            for a in agents if isinstance(a, dict) and isinstance(a.get('id'), str)]


def remote_snapshot(host, payload):
    payload = payload if isinstance(payload, dict) else {}
    return {'agents': remote_agents(host, payload),
            'quotas': [{**q, 'id': 'remote:' + q['id'] if q['id'].startswith('unknown:') else q['id'],
                        'origins': ['remote'] if q.get('origins') else []} for q in payload.get('quotas') or []
                       if isinstance(q, dict) and q.get('provider') in ('codex', 'claude')],
            'resources': {**((payload.get('resources') or {}).get('local') or {}), 'host': host},
            'orphans': [{**o, 'host': host} for o in payload.get('orphans') or [] if isinstance(o, dict)],
            'chronicle': payload.get('chronicle') or {}}


def remote_source():
    module = (ROOT / 'auto_continue.py').read_text()
    return (f'import sys, types\nsys.modules["auto_continue"] = types.ModuleType("auto_continue")\n'
            f'exec({module!r}, sys.modules["auto_continue"].__dict__)\n').encode() + Path(__file__).read_bytes()


def follow_remote(host):
    """Keep one long-lived scanner on the host, applying each snapshot it streams back."""
    while True:
        proc = None
        try:
            proc = subprocess.Popen([*SSH, host, *REMOTE_PYTHON, '--stream'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            STREAMS.append(proc)
            proc.stdin.write(remote_source())
            proc.stdin.close()
            for line in proc.stdout:
                payload = json.loads(line)
                snapshot = remote_snapshot(host, payload)
                with LOCK:
                    if payload.get('quotas') is None and host in REMOTES:  # a new scanner has not read usage yet
                        snapshot['quotas'] = REMOTES[host]['quotas']
                    REMOTES[host] = snapshot
                record_timer_prompts(snapshot['quotas'])
        except (OSError, ValueError) as e:
            print(f'remote scan error ({host}):', repr(e), flush=True)
        finally:
            if proc and proc.poll() is None:
                proc.kill()
            if proc in STREAMS:
                STREAMS.remove(proc)
        time.sleep(REMOTE_SCAN_SEC)


def stream_snapshots(out):
    """Remote end of follow_remote: print a snapshot whenever one changes, plus a heartbeat."""
    last, sent = None, 0
    scan_local()  # an empty first snapshot would read as every agent leaving
    while os.getppid() != 1:  # the SSH session is gone once init adopts us
        payload = state_payload(None)
        line = json.dumps({**payload, 'now': None, 'chronicle': chronicle_days(),
                           'quotas': payload['quotas'] if LOCAL_QUOTAS is not None else None})
        if line != last or time.time() - sent > 30:
            try:
                out.write(line + '\n')
                out.flush()
            except BrokenPipeError:
                os._exit(0)  # the dashboard hung up
            last, sent = line, time.time()
        time.sleep(REMOTE_EMIT_SEC)


def state_payload(demo):
    now = time.time()
    logins = {} if demo else {'codex': account_id(active_home()), 'claude': claude_id(claude_home())}
    with LOCK:
        if demo:
            ags = demo.payload(now)
        else:
            live = [fs for fs in FILES.values() if fs.status and fs.status != 'gone']
            ags = link_agents([{**fs.payload(now), 'origin': 'local', 'load': PROCS.get(fs.id)} for fs in live], live, now)
            ags += [a for remote in REMOTES.values() for a in remote['agents']]
            ags = [{**a, 'prs': [{**pr, 'ci': PR_STATES.get(f"{pr.get('repo')}#{pr.get('number')}")}
                                 for pr in a.get('prs') or [] if isinstance(pr, dict)]} for a in ags]
        quotas = ([{'id': 'demo-local', 'name': 'Espresso', 'provider': 'codex', 'origins': ['local'],
                    'period': 'weekly', 'left': 81, 'resets_at': now + 5.1 * 86400, 'resets_left': 2},
                   {'id': 'demo-remote', 'name': 'Mirasume', 'provider': 'codex', 'origins': ['remote'],
                    'period': 'weekly', 'left': 54, 'resets_at': now + 3.3 * 86400, 'resets_left': 1},
                   {'id': 'demo-spare', 'name': 'Caffeinated', 'provider': 'codex', 'origins': [],
                    'period': 'weekly', 'left': 100, 'resets_at': now + 7 * 86400, 'resets_left': 0},
                   {'id': 'claude:demo-login:Claude', 'name': 'Arcana', 'account': 'Arcana', 'model': 'Claude',
                    'provider': 'claude', 'loginId': 'demo-login', 'origins': ['local', 'remote'], 'tier': 20,
                    'period': 'weekly', 'left': 63, 'resets_at': now + 2.2 * 86400, 'resets_left': 0}]
                  if demo else merge_quotas([q for remote in REMOTES.values() for q in remote['quotas']], LOCAL_QUOTAS or []))
        if not demo:
            quotas = [{**q, 'origins': [origin for origin in q['origins'] if origin != 'local'] +
                       (['local'] if logins.get(q.get('provider')) and
                        logins[q['provider']] == q.get('loginId', q['id']) else [])}
                      for q in quotas]
        first = REMOTES.get(HOSTS[0]) if HOSTS else None
        resources = ({'local': {'host': 'local', 'cpu': 82, 'cores': 12,
                                'memoryUsed': 20 * 2**30, 'memoryTotal': 32 * 2**30,
                                'diskUsed': 300 * 2**30, 'diskTotal': 500 * 2**30},
                      'remote': {'host': 'mage-tower', 'cpu': 43, 'cores': 64,
                                 'memoryUsed': 80 * 2**30, 'memoryTotal': 128 * 2**30,
                                 'diskUsed': 900 * 2**30, 'diskTotal': 1000 * 2**30}}
                     if demo else {'local': LOCAL_RESOURCES, 'remote': first['resources'] if first else {}})
        orphans = [{'pid': 4242, 'cmd': 'node node_modules/.bin/vite --port 5173', 'cpu': 2.5, 'rss': 180 * 2**20,
                    'project': 'espresso'}] if demo else ORPHANS + [o for remote in REMOTES.values() for o in remote['orphans']]
    return {'now': now, 'demo': bool(demo), 'cpu': 82 if demo else CPU_USAGE, 'resources': resources, 'quotas': quotas,
            'timerPrompts': list(TIMER_PROMPTS), 'hosts': ['mage-tower'] if demo else HOSTS,
            'orphans': orphans, 'annals': ANNALS['stamp'],
            'agents': sorted(ags, key=lambda a: a['started'] or 0)}


LAT_EDGES = [15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400, 28800, 86400]  # reply-latency buckets (s)
LIBRARY_SIZE, CHRONICLE_DAYS = 96, 60


def state_file(name):
    directory = active_home() / 'wizard-factory'
    directory.mkdir(parents=True, exist_ok=True)
    return directory / name


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def save_json(path, data):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    os.replace(tmp, path)


def fold_chronicle(saved, timelines, now):
    """Add each agent's beats since its last fold to daily totals: busy agent-seconds, turns, prompts,
    sessions, and a histogram of how long finished turns waited for your next prompt."""
    days, upto = saved.setdefault('days', {}), saved.setdefault('upto', {})
    day = lambda ts: days.setdefault(time.strftime('%Y-%m-%d', time.localtime(ts)), {
        'busy': 0, 'turns': 0, 'prompts': 0, 'sessions': [], 'lat': [0] * (len(LAT_EDGES) + 1)})
    changed = False
    for aid, main, beats in timelines:
        since, ended = upto.get(aid, [0])[0], None
        marks = [b for b in beats if b[1] in STATUS_BEATS]
        for (ts, kind), (after, _) in zip(marks, marks[1:]):
            if after > since and kind in BUSY_BEATS:
                day(ts)['busy'] += min(after - ts, ABANDON_SEC if kind == 'tool_use' else 300)
                changed = True
        for ts, kind in beats if main else []:
            if kind in ('turn_end', 'human') and ts > since:
                d, changed = day(ts), True
                d['turns' if kind == 'turn_end' else 'prompts'] += 1
                if aid not in d['sessions']:
                    d['sessions'].append(aid)
                if kind == 'human' and ended:
                    d['lat'][bisect.bisect(LAT_EDGES, ts - ended)] += 1
            if kind in ('turn_end', 'turn_pending', 'human'):
                ended = ts if kind == 'turn_end' else None
        if beats:
            upto[aid] = [max(since, beats[-1][0]), now]
    cut = now - CHRONICLE_DAYS * 86400  # a session resumed weeks later must not recount its tail
    for key in [k for k in days if k < time.strftime('%Y-%m-%d', time.localtime(cut))]:
        del days[key]
    for aid in [k for k, (_, seen) in upto.items() if seen < cut]:
        del upto[aid]
    return changed


def book(a):
    final = next((c['text'] for c in reversed(a.get('chat') or []) if c.get('role') == 'agent'), '')
    sid = a['id'].split(':', 1)[1] if a.get('host') else a['id']
    resume = (f"cd {shlex.quote(a['cwd'])} && " if a.get('cwd') else '') + \
        f"{'codex resume' if a.get('engine') == 'codex' else 'claude --resume'} {sid}"
    return {'id': a['id'], 'engine': a.get('engine'), 'host': a.get('host'), 'title': a.get('title') or a.get('quest'),
            'quest': a.get('quest'), 'project': a.get('project'), 'branch': a.get('branch'), 'started': a.get('started'),
            'ended': a.get('last'), 'final': snip(final, 400), 'prs': a.get('prs') or [], 'turns': a.get('turns') or 0,
            'cost': a.get('cost'), 'resume': f"ssh -t {a['host']} {shlex.quote(resume)}" if a.get('host') else resume}


def merge_book(old, new):
    """A session shelved again after a restart or resume is read only from its tail; keep what the shelf knew."""
    if not old:
        return new
    prs = {f"{pr.get('repo')}#{pr.get('number')}": pr for pr in (old.get('prs') or []) + new['prs']}
    return {**old, **{k: v for k, v in new.items() if v}, 'turns': max(old.get('turns') or 0, new['turns']),
            'started': min(filter(None, (old.get('started'), new['started'])), default=None), 'prs': list(prs.values())}


def update_annals(shelve):
    """Persist the daily chronicle, and shelve a book for each main session that has left the tower."""
    now = time.time()
    agents = state_payload(None)['agents'] if shelve else []
    with LOCK:
        timelines = [(fs.id, fs.kind == 'main', list(fs.beats)) for fs in FILES.values()]
        departed = [{**fs.payload(now), 'origin': 'local'} for fs in FILES.values()
                    if shelve and fs.kind == 'main' and fs.status == 'gone' and fs.id not in ANNALS['shelved']]
    path = state_file('chronicle.json')
    saved = load_json(path, {})
    changed = fold_chronicle(saved, timelines, now)
    if changed:
        save_json(path, saved)
    ANNALS['days'] = saved.get('days', {})
    live = {a['id']: a for a in agents if a['kind'] == 'main'}
    departed += [a for aid, a in ANNALS['seen'].items() if aid not in live]
    ANNALS['seen'] = live
    if departed:
        path = state_file('library.json')
        books = {b['id']: b for b in load_json(path, []) if isinstance(b, dict) and b.get('id')}
        books.update((a['id'], merge_book(books.get(a['id']), book(a))) for a in departed)
        ANNALS['shelved'].update(a['id'] for a in departed)
        save_json(path, sorted(books.values(), key=lambda b: -(b.get('ended') or 0))[:LIBRARY_SIZE])
    if changed or departed:
        ANNALS['stamp'] += 1


def chronicle_days(limit=14):
    return dict(sorted(ANNALS['days'].items())[-limit:])


def annals_payload():
    days = {}
    with LOCK:
        sources = [('', chronicle_days())] + [(host + ':', r['chronicle']) for host, r in REMOTES.items()]
    for prefix, source in sources:
        for date, d in source.items():
            if not isinstance(d, dict):
                continue
            into = days.setdefault(date, {'busy': 0, 'turns': 0, 'prompts': 0, 'sessions': [], 'lat': [0] * (len(LAT_EDGES) + 1)})
            for key in ('busy', 'turns', 'prompts'):
                into[key] += d.get(key) or 0
            into['sessions'] += [prefix + s for s in d.get('sessions') or []]
            into['lat'] = [x + y for x, y in zip(into['lat'], (d.get('lat') or []) + [0] * len(into['lat']))]
    return {'edges': LAT_EDGES, 'days': [{'date': date, **{**d, 'sessions': len(d['sessions'])}}
                                          for date, d in sorted(days.items(), reverse=True)][:14],
            'library': load_json(state_file('library.json'), [])}


def make_handler(demo):
    class H(BaseHTTPRequestHandler):
        timeout = 10

        def log_message(self, format, *args):
            pass

        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            url = urlsplit(self.path)
            p = url.path
            if p == '/api/state':
                return self._send(200, json.dumps(state_payload(demo)).encode(), 'application/json')
            if p == '/api/annals':
                return self._send(200, json.dumps(demo.annals() if demo else annals_payload()).encode(), 'application/json')
            try:
                f = (ROOT / 'static' / ('index.html' if p == '/' else p.lstrip('/'))).resolve()
                if f.is_file() and (ROOT / 'static') in f.parents:
                    return self._send(200, f.read_bytes(), MIME.get(f.suffix, 'application/octet-stream'))
            except (ValueError, OSError):
                pass
            self._send(404, b'lost in the void', 'text/plain')

        def do_POST(self):
            if self.path != '/hook':
                return self._send(404, b'', 'text/plain')
            try:
                n = min(max(int(self.headers.get('Content-Length') or 0), 0), 1 << 20)
                d = json.loads(self.rfile.read(n) or b'{}')
            except Exception:
                d = {}
            ev, sid = d.get('hook_event_name', ''), d.get('session_id', '')
            with LOCK:
                if ev == 'SessionEnd':
                    DEAD[sid] = time.time()
                elif ev:
                    DEAD.pop(sid, None)
                    OVERRIDES[sid] = {'event': ev, 'ts': time.time(), 'msg': d.get('message')}
            self._send(200, b'{"ok":true}', 'application/json')
    return H


def edit_hooks(install, port):
    orig = SETTINGS.read_text() if SETTINGS.exists() else '{}'
    try:
        cfg = json.loads(orig)
        assert isinstance(cfg, dict) and isinstance(cfg.get('hooks', {}), dict)
    except Exception:
        return print(f'refusing to touch {SETTINGS}: not the JSON shape I expect')
    hooks = cfg.setdefault('hooks', {})
    cmd = (f"curl -s -m 2 --connect-timeout 1 -X POST -H 'Content-Type: application/json' "
           f"--data-binary @- http://127.0.0.1:{port}/hook >/dev/null 2>&1; true {HOOK_MARK}")
    mine = lambda h: isinstance(h, dict) and HOOK_MARK in str(h.get('command') or '')
    for ev in HOOK_EVENTS:
        kept = []
        for grp in (hooks.get(ev) if isinstance(hooks.get(ev), list) else []):
            if isinstance(grp, dict) and isinstance(grp.get('hooks'), list):
                grp = {**grp, 'hooks': [h for h in grp['hooks'] if not mine(h)]}
                if not grp['hooks']:
                    continue
            kept.append(grp)
        if install:
            kept.append({'hooks': [{'type': 'command', 'command': cmd}]})
        if kept:
            hooks[ev] = kept
        else:
            hooks.pop(ev, None)
    if not hooks:
        cfg.pop('hooks', None)
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    if SETTINGS.exists():
        SETTINGS.with_name('settings.json.wizard-bak').write_text(orig)
    tmp = SETTINGS.with_name('settings.json.wizard-tmp')
    tmp.write_text(json.dumps(cfg, indent=2) + '\n')
    os.replace(tmp, SETTINGS)
    print(f"{'installed' if install else 'removed'} wizard-factory hooks in {SETTINGS} (backup: settings.json.wizard-bak)")
    if install:
        print('note: hooks only apply to sessions started from now on; polling covers everything else')


def every(seconds, step, label):
    def loop():
        while True:
            t = time.time()
            try:
                step()
            except Exception as e:
                print(f'{label} error:', repr(e), flush=True)
            time.sleep(max(0.1, seconds - (time.time() - t)))
    threading.Thread(target=loop, daemon=True).start()


def sample_resources():
    global CPU_USAGE, LOCAL_RESOURCES
    resources = {}
    try:
        resources = read_resources()
    finally:
        with LOCK:
            LOCAL_RESOURCES, CPU_USAGE = resources, resources.get('cpu')


def sample_usage():
    global LOCAL_QUOTAS
    quotas = account_quotas(not HOSTS)  # with remote hosts, the listed accounts come from their streams
    record_timer_prompts(quotas)
    with LOCK:
        LOCAL_QUOTAS = quotas


def scan_local():
    with LOCK:
        scan_once(time.time())


def sample_processes():
    global CLAUDE_SESSIONS, PROCS, ORPHANS
    sessions, loads, strays = read_processes()
    with LOCK:
        CLAUDE_SESSIONS, PROCS, ORPHANS = sessions, loads, strays


def sample_ci():
    with LOCK:
        keys = {key for fs in FILES.values() if fs.status not in (None, 'gone') for key in fs.prs}
        keys |= {f"{pr['repo']}#{pr['number']}" for remote in REMOTES.values() for a in remote['agents']
                 for pr in a.get('prs') or [] if isinstance(pr, dict)}
    for key in sorted(keys):
        old = PR_STATES.get(key)
        if not re.fullmatch(r'[\w.-]+/[\w.-]+#\d+', key) or \
                old and time.time() - old['checked'] < (600 if old['state'] in ('merged', 'closed') else CI_SEC):
            continue
        if state := read_ci(key):
            with LOCK:
                PR_STATES[key] = state


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=7777)
    ap.add_argument('--demo', action='store_true', help='populate the tower with fake wizards')
    ap.add_argument('--debug-scan', action='store_true', help='print inferred agents as JSON and exit')
    ap.add_argument('--refresh-usage', action='store_true', help=argparse.SUPPRESS)
    ap.add_argument('--stream', action='store_true', help=argparse.SUPPRESS)
    ap.add_argument('--remote-host', default='mage-tower',
                    help='SSH hosts to scan, comma-separated; each gets its own faction (empty to disable)')
    ap.add_argument('--install-hooks', action='store_true', help='add optional hooks to ~/.claude/settings.json')
    ap.add_argument('--uninstall-hooks', action='store_true', help='remove those hooks')
    a = ap.parse_args()
    if a.install_hooks or a.uninstall_hooks:
        return edit_hooks(a.install_hooks, a.port)
    if a.debug_scan:
        with LOCK:
            scan_once(time.time())
        payload = state_payload(None)
        payload['resources']['local'] = read_resources()
        payload['quotas'] = account_quotas(True) if a.refresh_usage else []
        return print(json.dumps(payload, indent=2))
    demo = Demo() if a.demo else None
    if a.stream:
        out, sys.stdout = sys.stdout, sys.stderr  # loop logs must not corrupt the snapshot stream
    if not demo:
        HOSTS[:] = [] if a.stream else [h.strip() for h in a.remote_host.split(',') if h.strip()]
        every(3, sample_resources, 'cpu usage')
        every(REMOTE_USAGE_SEC, sample_usage, 'usage')
        every(60, lambda: resume_limited(active_home(), time.time()), 'auto-continue')
        every(SCAN_SEC, scan_local, 'scan')
        every(PROC_SEC, sample_processes, 'process scan')
        every(ANNALS_SEC, lambda: update_annals(not a.stream), 'annals')
        if not a.stream:
            every(CI_SEC / 2, sample_ci, 'ci')
        for host in HOSTS:
            threading.Thread(target=follow_remote, args=(host,), daemon=True).start()
        # watch_server.py restarts the tower with SIGTERM; take the remote scanners down with it.
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        atexit.register(lambda: [proc.kill() for proc in list(STREAMS) if proc.poll() is None])
    if a.stream:
        return stream_snapshots(out)
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), make_handler(demo))
    print(f"\n   /\\\n  /__\\   WIZARD FACTORY{' (demo)' if demo else ''}\n   ||    http://127.0.0.1:{a.port}\n", flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
