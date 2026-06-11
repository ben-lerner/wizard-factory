#!/usr/bin/env python3
"""Wizard Factory - a retro dashboard that shows every coding agent as a pixel wizard.

Polls ~/.claude/projects/**/*.jsonl transcripts (main sessions + subagents), infers what
each agent is doing, and serves the tower at http://127.0.0.1:7777. No registration needed.

  python3 server.py                  # the real tower
  python3 server.py --demo           # a busy fake tower (for trying the UI)
  python3 server.py --install-hooks  # optional: instant permission/stop events via hooks
"""
import argparse
import json
import os
import random
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECTS = Path.home() / '.claude' / 'projects'
CODEX = Path.home() / '.codex' / 'sessions'
SETTINGS = Path.home() / '.claude' / 'settings.json'
HOOK_MARK = '#wizard-factory'
HOOK_EVENTS = ['Notification', 'Stop', 'UserPromptSubmit', 'SessionStart', 'SessionEnd']
SCAN_SEC, FRESH_SEC, TAIL_BYTES = 1.0, 3 * 3600, 512 * 1024
RESPONDING_SEC, IDLE_SEC, GONE_SEC = 6, 15 * 60, 45 * 60
ABANDON_SEC, SUB_GONE_SEC = 2 * 3600, 150
MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png'}

FILES = {}      # path -> FileState
OVERRIDES = {}  # session_id -> latest hook event {event, ts, msg}
DEAD = {}       # session_id -> epoch of SessionEnd hook
LOCK = threading.Lock()


def epoch(ts):
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
    except Exception:
        return None


def clean(s, n=160):
    s = ' '.join(s.split())
    return s[:n] + ('…' if len(s) > n else '')


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


def project_of(cwd):
    if not cwd:
        return '?'
    if '/.claude/worktrees/' in cwd:
        repo, wt = cwd.split('/.claude/worktrees/', 1)
        return Path(repo).name + '/' + wt.split('/')[0]
    return Path(cwd).name or '/'


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
        self.last_kind = self.tool = self.detail = self.last_ts = self.started = None
        self.status = self.since = None

    def feed(self, d):
        if self.engine == 'codex':
            return self.feed_codex(d)
        t, m, ts = d.get('type'), d.get('message') or {}, epoch(d.get('timestamp') or '')
        self.cwd, self.branch = d.get('cwd') or self.cwd, d.get('gitBranch') or self.branch
        if t == 'ai-title':
            self.title = clean(d.get('aiTitle') or '', 90) or self.title
        elif t == 'summary':
            self.title = self.title or clean(d.get('summary') or '', 90)
        elif t == 'last-prompt':
            if d.get('lastPrompt') and self.kind == 'main':
                self.quest = clean(d['lastPrompt'])
        elif t == 'user':
            c = m.get('content')
            texts = [c] if isinstance(c, str) else [b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text'] if isinstance(c, list) else []
            if any(x.startswith('[Request interrupted') for x in texts):
                self._mark('interrupted', ts)
            real = next((x for x in texts if x and x[0] not in '<[' and not x.startswith(('Caveat:', 'This session is being continued'))), None)
            if real and not d.get('isMeta'):
                if self.kind == 'main' or not self.quest:
                    self.quest = clean(real)
                self._mark('user_text', ts)
            if isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c):
                self._mark('tool_result', ts)
        elif t == 'assistant':
            self.model = m.get('model') or self.model
            for b in m.get('content') or []:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'tool_use':
                    self.tool, self.detail = b.get('name', '?'), tool_detail(b.get('name', ''), b.get('input'))
                    self._mark('tool_use', ts)
                elif b.get('type') == 'thinking':
                    self._mark('thinking', ts)
                elif b.get('type') == 'text' and (b.get('text') or '').strip():
                    self._mark('assistant_text', ts)

    def feed_codex(self, d):
        t, p, ts = d.get('type'), d.get('payload') or {}, epoch(d.get('timestamp') or '')
        pt = p.get('type')
        if t == 'session_meta':
            self.cwd = p.get('cwd') or self.cwd
            self.id = self.sid = p.get('id') or self.id
            src = p.get('source')
            if isinstance(src, dict):  # e.g. {'subagent': 'review'}
                self.kind, self.oneshot = 'sub', True
            elif src == 'exec':
                self.oneshot = True
        elif t == 'turn_context':
            self.cwd, self.model = p.get('cwd') or self.cwd, p.get('model') or self.model
        elif t == 'response_item':
            if pt == 'function_call':
                try:
                    args = json.loads(p.get('arguments') or '{}')
                except Exception:
                    args = {}
                self.tool = p.get('name') or '?'
                self.detail = clean(str(next((args[k] for k in ('cmd', 'command', 'path', 'query', 'url', 'chars') if isinstance(args, dict) and args.get(k)), '')), 70)
                self._mark('tool_use', ts)
            elif pt == 'custom_tool_call':  # apply_patch arrives this way
                self.tool, self.detail = p.get('name') or '?', clean(str(p.get('input') or ''), 70)
                self._mark('tool_use', ts)
            elif pt == 'web_search_call':
                self.tool, self.detail = 'web_search', clean(str((p.get('action') or {}).get('query') or ''), 70)
                self._mark('tool_use', ts)
            elif pt == 'tool_search_call':
                self.tool, self.detail = 'ToolSearch', ''
                self._mark('tool_use', ts)
            elif pt in ('function_call_output', 'tool_search_output', 'custom_tool_call_output'):
                self._mark('tool_result', ts)
            elif pt == 'reasoning':
                self._mark('thinking', ts)
        elif t == 'event_msg':
            if pt == 'user_message':
                msg = p.get('message')
                msg = msg.strip() if isinstance(msg, str) else ''
                if msg.startswith('<task>'):
                    msg = msg.replace('<task>', '', 1).replace('</task>', '').strip()
                if msg and msg[0] not in '<[' and (self.kind == 'main' or not self.quest):
                    self.quest = clean(msg)
                self._mark('user_text', ts)
            elif pt == 'task_started':
                self._mark('user_text', ts)
            elif pt == 'agent_message':
                self._mark('thinking', ts)  # mid-turn commentary; task_complete marks the real end
            elif pt == 'task_complete':
                self._mark('assistant_text', ts)
            elif pt in ('turn_aborted', 'error'):
                self._mark('interrupted', ts)

    def _mark(self, kind, ts):
        self.last_kind = kind
        if ts:
            self.last_ts, self.started = ts, self.started or ts

    def derive(self, now):
        if not self.last_ts:
            return
        age = now - self.last_ts                          # age of last *content* line
        live = now - max(self.last_ts, self.mtime)        # file activity: bridge sessions flush content lazily
        if DEAD.get(self.sid, 0) > max(self.last_ts, self.mtime) - 10:  # ended, and no signs of life since
            st = 'gone'
        else:
            st = {'tool_use': 'working', 'tool_result': 'thinking', 'user_text': 'thinking', 'thinking': 'thinking'}.get(self.last_kind, 'done' if self.kind == 'sub' or self.oneshot else 'waiting')
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

    def payload(self):
        ov = OVERRIDES.get(self.sid) or {}
        return {'id': self.id, 'kind': self.kind, 'engine': self.engine, 'parent': self.parent, 'project': project_of(self.cwd),
                'branch': self.branch, 'title': self.title, 'quest': self.quest, 'model': self.model,
                'status': self.status, 'tool': self.tool, 'detail': self.detail,
                'since': self.since, 'last': max(self.last_ts or 0, self.mtime) or None, 'started': self.started,
                'msg': ov.get('msg') if self.status == 'attention' else None}


def retail(fs, size):
    # Start 1 byte early and always drop the first segment: it is empty iff the
    # preceding byte was a newline, so lines on the boundary are never lost.
    fs.offset = max(0, size - TAIL_BYTES - 1)
    fs.rem, fs.skip_first = b'', fs.offset > 0


def scan_once(now):
    seen = set()
    files = list(PROJECTS.glob('*/*.jsonl')) + list(PROJECTS.glob('*/*/subagents/*.jsonl'))
    if CODEX.is_dir():
        files += CODEX.glob('*/*/*/rollout-*.jsonl')
    for f in files:
        try:
            st = f.stat()
        except OSError:
            continue
        if now - st.st_mtime > FRESH_SEC:
            FILES.pop(f, None)
            continue
        seen.add(f)
        fs = FILES.get(f)
        if not fs:
            fs = FILES[f] = FileState(f)
            fs.ino = st.st_ino
            retail(fs, st.st_size)
            if fs.engine == 'codex' and fs.offset:  # session_meta is line 1; don't lose it to tailing
                try:
                    with open(f, 'rb') as fh:
                        fs.feed(json.loads(fh.readline()))
                except Exception:
                    pass
        elif st.st_ino != fs.ino or st.st_size < fs.offset:  # replaced or truncated
            fs.ino = st.st_ino
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
            fs.offset += len(chunk)
            rem_empty = not fs.rem
            lines = (fs.rem + chunk).split(b'\n')
            fs.rem = lines.pop()
            if fs.skip_first:
                lines, fs.skip_first = lines[1:], False
            ok = bad = 0
            first_ok = None
            for ln in lines:
                if not ln.strip():
                    continue
                try:
                    fs.feed(json.loads(ln))
                    ok += 1
                except Exception:
                    bad += 1
                if first_ok is None:
                    first_ok = not bad
            if bad >= 3 and not ok:  # not a transcript at all; just follow future appends
                fs.offset, fs.rem, fs.skip_first = st.st_size, b'', False
            elif first_ok is False and rem_empty and now - fs.retailed > 30:  # desynced by a rewrite
                fs.retailed = now
                retail(fs, st.st_size)
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
        self.n += 1
        self.ags[f'demo-{self.n}'] = {
            'id': f'demo-{self.n}', 'kind': 'sub' if parent else 'main', 'parent': parent,
            'engine': 'codex' if not parent and self.rng.random() < .18 else 'claude',
            'project': self.rng.choice(self.PROJ), 'branch': None, 'title': None,
            'quest': self.rng.choice(self.QUESTS), 'model': 'claude-fable-5', 'status': 'thinking',
            'tool': None, 'detail': None, 'msg': None, 'since': now, 'last': now, 'started': now,
            '_next': now + self.rng.uniform(2, 5)}

    def step(self, a, now):
        r = self.rng

        def go(s, lo, hi, **kw):
            a.update(status=s, since=now, last=now, _next=now + r.uniform(lo, hi), **kw)
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
        return [{k: v for k, v in a.items() if k != '_next'} for a in self.ags.values() if a['status'] != 'gone']


def state_payload(demo):
    now = time.time()
    with LOCK:
        ags = demo.payload(now) if demo else [fs.payload() for fs in FILES.values() if fs.status and fs.status != 'gone']
    return {'now': now, 'demo': bool(demo), 'agents': sorted(ags, key=lambda a: a['started'] or 0)}


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
            p = self.path.split('?')[0]
            if p == '/api/state':
                return self._send(200, json.dumps(state_payload(demo)).encode(), 'application/json')
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=7777)
    ap.add_argument('--demo', action='store_true', help='populate the tower with fake wizards')
    ap.add_argument('--debug-scan', action='store_true', help='print inferred agents as JSON and exit')
    ap.add_argument('--install-hooks', action='store_true', help='add optional hooks to ~/.claude/settings.json')
    ap.add_argument('--uninstall-hooks', action='store_true', help='remove those hooks')
    a = ap.parse_args()
    if a.install_hooks or a.uninstall_hooks:
        return edit_hooks(a.install_hooks, a.port)
    if a.debug_scan:
        with LOCK:
            scan_once(time.time())
        return print(json.dumps(state_payload(None), indent=2))
    demo = Demo() if a.demo else None
    if not demo:
        def loop():
            while True:
                t = time.time()
                with LOCK:
                    try:
                        scan_once(t)
                    except Exception as e:
                        print('scan error:', repr(e), flush=True)
                time.sleep(max(0.1, SCAN_SEC - (time.time() - t)))
        threading.Thread(target=loop, daemon=True).start()
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), make_handler(demo))
    print(f"\n   /\\\n  /__\\   WIZARD FACTORY{' (demo)' if demo else ''}\n   ||    http://127.0.0.1:{a.port}\n", flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
