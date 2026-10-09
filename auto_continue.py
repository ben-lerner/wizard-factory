"""Continue coding sessions interrupted by subscription usage limits."""
import fcntl
import hashlib
import json
import os
import re
import sqlite3
import socket
import stat
import subprocess
import time
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def reset_time(error):
    info = error.get('codexErrorInfo', error.get('codex_error_info'))
    if info not in ('usageLimitExceeded', 'UsageLimitExceeded', 'usage_limit_exceeded'):
        return None
    match = re.search(r'try again at (.+?)\.(?:\s|$)', error.get('message', ''), re.I)
    if not match:
        return None
    text = re.sub(r'(\d+)(st|nd|rd|th)', r'\1', match[1])
    try:
        # Codex renders this timestamp in the host's local timezone, to the minute.
        return datetime.strptime(text, '%b %d, %Y %I:%M %p').timestamp() + 60
    except ValueError:
        return None


def limited_turns(home):
    history = home / 'thread_history_1.sqlite'
    turns, projected = {}, set()
    if history.exists():
        with closing(sqlite3.connect(history.as_uri() + '?mode=ro', uri=True)) as db:
            db.execute('ATTACH DATABASE ? AS state', ((home / 'state_5.sqlite').as_uri() + '?mode=ro',))
            projected = {row[0] for row in db.execute('SELECT DISTINCT thread_id FROM thread_turns')}
            projected.update(row[0] for row in db.execute('SELECT id FROM state.threads WHERE archived = 1'))
            rows = db.execute('''
                SELECT t.thread_id, t.turn_id, t.error_json
                FROM thread_turns t JOIN state.threads s ON s.id = t.thread_id
                WHERE s.archived = 0 AND s.source IN ('cli', 'vscode', 'appServer')
                  AND t.status = 'failed' AND t.error_json IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM thread_turns newer
                      WHERE newer.thread_id = t.thread_id AND newer.rollout_ordinal > t.rollout_ordinal)
            ''')
            for sid, turn, raw in rows:
                reset = reset_time(json.loads(raw))
                if reset:
                    turns[sid] = {'turn': turn, 'reset': reset}
    # Older CLIs retain rollouts rather than projecting turns into SQLite.
    for path in (home / 'sessions').glob('*/*/*/rollout-*.jsonl'):
        error, stamp = None, None
        with path.open('rb') as stream:
            try:
                meta = json.loads(stream.readline()).get('payload') or {}
            except ValueError:
                continue
            sid, source = meta.get('id'), meta.get('source')
            if not sid or sid in projected or source not in ('cli', 'vscode', 'appServer'):
                continue
            if path.stat().st_size > 512 * 1024:
                stream.seek(path.stat().st_size - 512 * 1024)
                stream.readline()
            for line in stream:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                p = event.get('payload') or {}
                if event.get('type') == 'event_msg':
                    if p.get('type') == 'error':
                        error, stamp = p, event.get('timestamp')
                    elif p.get('type') == 'task_complete':
                        error, stamp = p.get('error'), event.get('timestamp')
                    elif p.get('type') in ('user_message', 'task_started'):
                        error = None
        reset = reset_time(error) if error else None
        if sid and sid not in turns and source in ('cli', 'vscode', 'appServer') and reset:
            turns[sid] = {'turn': stamp, 'reset': reset}
    return turns


def claude_home():
    return Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude').expanduser().resolve()


def claude_reset(event):
    if not event.get('isApiErrorMessage') or event.get('error') != 'rate_limit':
        return None
    text = ' '.join(b.get('text', '') for b in (event.get('message') or {}).get('content', [])
                    if b.get('type') == 'text')
    # A session-reset hint does not clear an org spending cap or depleted credits.
    if re.search(r'monthly|spend limit|credits', text, re.I):
        return None
    match = re.search(r'resets\s+(?:(\w{3})\s+(\d{1,2})(?:,\s*(\d{4}))?(?:\s+at\s+|,\s*))?'
                      r'(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)', text, re.I)
    if not match:
        return None
    month, day, year, hour, minute, period, zone = match.groups()
    try:
        stamp = datetime.fromisoformat(event['timestamp'].replace('Z', '+00:00')).astimezone(ZoneInfo(zone))
        hour = int(hour) % 12 + (12 if period.lower() == 'pm' else 0)
        reset = stamp.replace(hour=hour, minute=int(minute or 0), second=0, microsecond=0)
        if month:
            reset = reset.replace(year=int(year or stamp.year),
                                  month=datetime.strptime(month.title(), '%b').month, day=int(day))
            if not year and reset + timedelta(minutes=1) < stamp:
                reset = reset.replace(year=reset.year + 1)
        elif reset + timedelta(minutes=1) < stamp:
            reset += timedelta(days=1)
        return reset.timestamp() + 60
    except (ValueError, KeyError, ZoneInfoNotFoundError):
        return None


def limited_claude_turns(home):
    turns = {}
    for path in (home / 'projects').glob('*/*.jsonl'):
        error = None
        with path.open('rb') as stream:
            size = path.stat().st_size
            if size > 512 * 1024:
                stream.seek(size - 512 * 1024)
                stream.readline()
            for line in stream:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get('type') in ('user', 'assistant') and not event.get('isMeta'):
                    error = event if claude_reset(event) else None
        reset = claude_reset(error) if error else None
        if reset and error.get('cwd') and not error.get('isSidechain'):
            turns['claude:' + path.stem] = {'turn': error.get('uuid') or error['timestamp'],
                                          'reset': reset, 'engine': 'claude'}
    return turns


class AmbiguousDelivery(Exception):
    pass


def send_claude(home, sid):
    # Use Claude's authenticated peer inbox, retaining the session's inbound policy.
    for path in (home / 'sessions').glob('*.json'):
        try:
            peer = json.loads(path.read_text())
            if not isinstance(peer, dict) or peer.get('sessionId') != sid or not peer.get('messagingSocketPath'):
                continue
            os.kill(peer['pid'], 0)
            address = Path(peer['messagingSocketPath'])
            digest = hashlib.sha256(str(address).encode()).hexdigest()
            key = home / 'sessions' / f"{peer['pid']}.{digest}.key"
            for target, kind in ((address, stat.S_ISSOCK), (key, stat.S_ISREG)):
                info = target.lstat()
                if info.st_uid != os.getuid() or not kind(info.st_mode) or info.st_mode & 0o022:
                    raise OSError('Unsafe Claude inbox or key')
            token = json.loads(key.read_text())['peerToken']
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if not isinstance(token, str) or not re.fullmatch('[0-9a-f]{32}', token):
            continue
        frames = [{'type': 'auth', 'token': token}, {'type': 'user', 'session_id': sid,
                  'from': 'wizard-factory', 'message': {'role': 'user', 'content': 'continue'}}]
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(5)
            try:
                client.connect(str(address))
            except OSError:
                continue
            try:
                client.sendall(('\n'.join(map(json.dumps, frames)) + '\n').encode())
                client.shutdown(socket.SHUT_WR)
            except OSError as error:
                raise AmbiguousDelivery('Claude inbox write may have been delivered') from error
        return
    raise OSError('No live Claude inbox for session ' + sid)


def resume_limited(home, now):
    directory = home / 'wizard-factory'
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / 'continuations.json'
    with (directory / 'continuations.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        saved = json.loads(path.read_text()) if path.exists() else {}

        def save():
            tmp = path.with_suffix('.tmp')
            tmp.write_text(json.dumps(saved))
            os.replace(tmp, path)

        turns = {**limited_turns(home), **limited_claude_turns(claude_home())}
        for sid in list(saved):
            if sid not in turns or saved[sid]['turn'] != turns[sid]['turn']:
                del saved[sid]
        for sid, turn in turns.items():
            if sid not in saved:
                # Do not wake up historical failures on the first launch.
                if turn['reset'] < now - 120:
                    continue
                saved[sid] = {**turn, 'status': 'pending'}
            item = saved[sid]
            if item['status'] != 'pending' or now < item['reset']:
                continue
            # Record before delivery: an ambiguous timeout/crash must not send twice.
            item['status'] = 'attempted'
            save()
            try:
                if turn.get('engine') == 'claude':
                    send_claude(claude_home(), sid.removeprefix('claude:'))
                    result = subprocess.CompletedProcess('claude inbox', 0, stderr='')
                else:
                    result = subprocess.run(['codex', 'queue', '--thread', sid, '--message', 'continue'],
                                            env={**os.environ, 'CODEX_HOME': str(home)},
                                            capture_output=True, text=True, timeout=30)
            except (OSError, subprocess.TimeoutExpired, AmbiguousDelivery) as error:
                print('auto-continue delivery error:', sid, repr(error), flush=True)
                if isinstance(error, OSError):
                    item['status'] = 'pending'
            else:
                item['status'] = 'sent' if result.returncode == 0 else 'pending'
                print('auto-continue:', sid, item['status'], result.stderr.strip(), flush=True)
            save()
        save()


if __name__ == '__main__':
    resume_limited(Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex').expanduser().resolve(), time.time())
