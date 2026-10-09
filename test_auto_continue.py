import json
import sqlite3
import subprocess
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import auto_continue as resume


ERROR = {'codexErrorInfo': 'usageLimitExceeded', 'message':
         "You've hit your usage limit. Try again at Oct 9th, 2026 5:03 PM."}
RESET = datetime(2026, 10, 9, 17, 4).timestamp()


class ContinuationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
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


if __name__ == '__main__':
    unittest.main()
