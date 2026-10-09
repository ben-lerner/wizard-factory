"""Queue continuation for Codex turns interrupted by a subscription usage limit."""
import fcntl
import json
import os
import re
import sqlite3
import subprocess
import time
from contextlib import closing
from datetime import datetime
from pathlib import Path


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

        turns = limited_turns(home)
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
                result = subprocess.run(['codex', 'queue', '--thread', sid, '--message', 'continue'],
                                        env={**os.environ, 'CODEX_HOME': str(home)},
                                        capture_output=True, text=True, timeout=30)
            except (OSError, subprocess.TimeoutExpired) as error:
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
