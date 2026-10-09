import hashlib
import json
import os
import socket
import sqlite3
import subprocess
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import auto_continue as resume


ERROR = {'codexErrorInfo': 'usageLimitExceeded', 'message':
         "You've hit your usage limit. Try again at Oct 9th, 2026 5:03 PM."}
RESET = datetime(2026, 10, 9, 17, 4).timestamp()


class ContinuationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        env = patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': str(self.home / 'claude')})
        env.start()
        self.addCleanup(env.stop)
        self.history = sqlite3.connect(self.home / 'thread_history_1.sqlite')
        self.addCleanup(self.history.close)
        self.history.execute('CREATE TABLE thread_turns (thread_id, turn_id, rollout_ordinal, status, error_json)')
        with sqlite3.connect(self.home / 'state_5.sqlite') as db:
            db.execute('CREATE TABLE threads (id, archived, source)')
            db.execute("INSERT INTO threads VALUES ('session', 0, 'cli')")
        self.history.execute('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)',
                             ('session', 'turn', 1, 'failed', json.dumps(ERROR)))
        self.history.commit()

    def test_waits_for_reset_and_sends_once_across_restarts(self):
        with patch.object(resume.subprocess, 'run', return_value=MagicMock(returncode=0, stderr='')) as run:
            resume.resume_limited(self.home, RESET - 5 * 3600)
            run.assert_not_called()
            resume.resume_limited(self.home, RESET - 1)
            run.assert_not_called()
            resume.resume_limited(self.home, RESET)
            resume.resume_limited(self.home, RESET + 3600)
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0], ['codex', 'queue', '--thread', 'session', '--message', 'continue'])
        self.assertEqual(run.call_args.kwargs['env']['CODEX_HOME'], str(self.home))

    def test_new_turn_or_archive_cancels_resume(self):
        for archived in (False, True):
            with self.subTest(archived=archived), patch.object(resume.subprocess, 'run') as run:
                resume.resume_limited(self.home, RESET - 100)
                if archived:
                    with sqlite3.connect(self.home / 'state_5.sqlite') as db:
                        db.execute('UPDATE threads SET archived = 1')
                else:
                    self.history.execute("INSERT INTO thread_turns VALUES ('session', 'new', 2, 'inProgress', NULL)")
                    self.history.commit()
                resume.resume_limited(self.home, RESET)
                run.assert_not_called()
                self.history.execute("DELETE FROM thread_turns WHERE turn_id = 'new'")
                self.history.commit()

    def test_old_failure_is_not_resumed_on_first_launch(self):
        with patch.object(resume.subprocess, 'run') as run:
            resume.resume_limited(self.home, RESET + 86400)
        run.assert_not_called()

    def test_failed_delivery_retries_but_ambiguous_timeout_does_not(self):
        with patch.object(resume.subprocess, 'run', side_effect=[
                MagicMock(returncode=1, stderr='unavailable'), subprocess.TimeoutExpired('codex', 30)]) as run:
            resume.resume_limited(self.home, RESET)
            resume.resume_limited(self.home, RESET + 60)
            resume.resume_limited(self.home, RESET + 120)
        self.assertEqual(run.call_count, 2)

    def test_only_subscription_usage_errors_with_reset_times_qualify(self):
        self.assertEqual(resume.reset_time(ERROR), RESET)
        self.assertEqual(resume.reset_time({**ERROR, 'codexErrorInfo': 'UsageLimitExceeded'}), RESET)
        for error in ({**ERROR, 'codexErrorInfo': 'rateLimitExceeded'},
                      {**ERROR, 'message': 'Limit exceeded'},
                      {**ERROR, 'message': 'Try again at an invalid date.'}):
            self.assertIsNone(resume.reset_time(error))

    def test_legacy_rollout_and_manual_continuation(self):
        path = self.home / 'sessions/2026/10/09/rollout-session.jsonl'
        path.parent.mkdir(parents=True)
        meta = {'type': 'session_meta', 'payload': {'id': 'legacy', 'source': 'cli'}}
        error = {'type': 'event_msg', 'timestamp': '2026-10-09T12:00:00Z',
                 'payload': {**ERROR, 'type': 'error'}}
        path.write_text('\n'.join(map(json.dumps, [meta, error])) + '\n')
        self.assertIn('legacy', resume.limited_turns(self.home))
        with path.open('a') as stream:
            stream.write(json.dumps({'type': 'event_msg', 'payload': {'type': 'user_message'}}) + '\n')
        self.assertNotIn('legacy', resume.limited_turns(self.home))

    def test_legacy_completion_error_survives_unicode_tail_boundary(self):
        path = self.home / 'sessions/2026/10/09/rollout-session.jsonl'
        path.parent.mkdir(parents=True)
        meta = {'type': 'session_meta', 'payload': {'id': 'legacy', 'source': 'cli'}}
        complete = {'type': 'event_msg', 'timestamp': '2026-10-09T12:00:00Z', 'payload': {
            'type': 'task_complete', 'error': {'codex_error_info': 'usage_limit_exceeded',
                                              'message': ERROR['message']}}}
        end = json.dumps(complete).encode() + b'\n'
        start = json.dumps(meta).encode() + b'\n'
        # The byte at size - TAIL_BYTES is the second byte of the UTF-8 character.
        tail = b'x' * (512 * 1024 - len(end) - 2) + b'\n' + end
        path.write_bytes(start + b' ' * (512 * 1024) + 'é'.encode() + tail)
        self.assertEqual(resume.limited_turns(self.home)['legacy']['reset'], RESET)
        with path.open('a') as stream:
            stream.write(json.dumps({'type': 'event_msg', 'payload': {'type': 'task_complete'}}) + '\n')
        self.assertNotIn('legacy', resume.limited_turns(self.home))


class ClaudeContinuationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/tmp')
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        env = patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        codex = patch.object(resume, 'limited_turns', return_value={})
        codex.start()
        self.addCleanup(codex.stop)
        self.error = {'type': 'assistant', 'error': 'rate_limit', 'isApiErrorMessage': True,
                      'uuid': 'failed-turn', 'timestamp': '2026-10-09T16:00:00Z', 'cwd': '/repo',
                      'message': {'content': [{'type': 'text', 'text':
                          "You've hit your limit · resets 4pm (America/New_York)"}]}}
        self.reset = datetime(2026, 10, 9, 16, 1, tzinfo=ZoneInfo('America/New_York')).timestamp()
        self.path = self.home / 'projects/repo/session.jsonl'
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps(self.error) + '\n')

    def test_session_and_weekly_reset_times_use_error_timezone(self):
        self.assertEqual(resume.claude_reset(self.error), self.reset)
        for text, expected in [
                ('resets Oct 12 at 9:30am (America/New_York)', datetime(2026, 10, 12, 9, 31)),
                ('resets Oct 12, 9:30am (America/New_York)', datetime(2026, 10, 12, 9, 31)),
                ('resets Jan 1, 2027, 9am (America/New_York)', datetime(2027, 1, 1, 9, 1)),
                ('resets 1am (America/New_York)', datetime(2026, 10, 10, 1, 1)),
                ('resets 12pm (America/New_York)', datetime(2026, 10, 9, 12, 1))]:
            event = {**self.error, 'message': {'content': [{'type': 'text', 'text': text}]}}
            self.assertEqual(resume.claude_reset(event), expected.replace(tzinfo=ZoneInfo('America/New_York')).timestamp())
        for text in ("You've hit your org's monthly spend limit · your session limit resets 4pm (America/New_York)",
                     'Too many requests', 'resets 4pm (Invalid/Timezone)'):
            self.assertIsNone(resume.claude_reset({**self.error, 'message': {'content': [{'type': 'text', 'text': text}]}}))

    def test_continuation_waits_sends_once_and_cancels_after_user_message(self):
        with patch.object(resume, 'send_claude') as send:
            resume.resume_limited(self.home, self.reset - 300)
            send.assert_not_called()
            resume.resume_limited(self.home, self.reset)
            resume.resume_limited(self.home, self.reset + 300)
            send.assert_called_once_with(self.home, 'session')
        self.path.write_text(json.dumps({**self.error, 'uuid': 'another-turn'}) + '\n')
        resume.resume_limited(self.home, self.reset - 60)
        with self.path.open('a') as stream:
            stream.write(json.dumps({'type': 'user', 'message': {'content': 'stop'}}) + '\n')
        with patch.object(resume, 'send_claude') as send:
            resume.resume_limited(self.home, self.reset)
            send.assert_not_called()

    def test_subagents_and_successful_turns_do_not_qualify(self):
        self.path.write_text(json.dumps({**self.error, 'isSidechain': True}) + '\n')
        self.assertEqual(resume.limited_claude_turns(self.home), {})
        self.path.write_text(json.dumps(self.error) + '\n' + json.dumps({
            'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Finished'}]}}) + '\n')
        self.assertEqual(resume.limited_claude_turns(self.home), {})

    def test_inbox_delivery_uses_peer_auth_and_exact_session(self):
        address = self.home / 'inbox.sock'
        sessions = self.home / 'sessions'
        sessions.mkdir()
        (sessions / 'peer.json').write_text(json.dumps({'pid': os.getpid(), 'sessionId': 'session',
                                                     'messagingSocketPath': str(address)}))
        stale = sessions / 'stale.json'
        stale.write_text(json.dumps({'pid': os.getpid(), 'sessionId': 'session',
                                     'messagingSocketPath': str(self.home / 'missing.sock')}))
        digest = hashlib.sha256(str(address).encode()).hexdigest()
        key = sessions / f'{os.getpid()}.{digest}.key'
        key.write_text(json.dumps({'peerToken': 'a' * 32}))
        key.chmod(0o600)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(address))
            server.listen(1)
            server.settimeout(2)
            with patch.object(Path, 'glob', return_value=iter([stale, sessions / 'peer.json'])):
                resume.send_claude(self.home, 'session')
            client, _ = server.accept()
            with client:
                frames = [json.loads(line) for line in client.makefile().read().splitlines()]
        self.assertEqual(frames[0], {'type': 'auth', 'token': 'a' * 32})
        self.assertEqual(frames[1]['session_id'], 'session')
        self.assertEqual(frames[1]['message']['content'], 'continue')
        with self.assertRaises(OSError):
            resume.send_claude(self.home, 'different-session')

    def test_unavailable_inbox_retries_and_ambiguous_write_does_not(self):
        with patch.object(resume, 'send_claude', side_effect=[OSError('no inbox'),
                          resume.AmbiguousDelivery('partial write')]) as send:
            resume.resume_limited(self.home, self.reset)
            resume.resume_limited(self.home, self.reset + 60)
            resume.resume_limited(self.home, self.reset + 120)
        self.assertEqual(send.call_count, 2)


if __name__ == '__main__':
    unittest.main()
