import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class TaskTitlesTest(unittest.TestCase):
    def test_custom_title_takes_precedence_over_generated_titles(self):
        state = server.FileState(Path('/tmp/session.jsonl'))
        state.feed({'type': 'custom-title', 'customTitle': 'Fix wizard desks'})
        state.feed({'type': 'ai-title', 'aiTitle': 'Generated title'})
        state.feed({'type': 'summary', 'summary': 'Summary'})
        self.assertEqual(state.payload()['title'], 'Fix wizard desks')
        state.feed({'type': 'custom-title', 'customTitle': 'New task name'})
        self.assertEqual(state.payload()['title'], 'New task name')

    def test_codex_rename_updates_without_transcript_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sessions = root / 'sessions'
            transcript = sessions / '2026/09/20/rollout-test.jsonl'
            transcript.parent.mkdir(parents=True)
            transcript.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': 'test'}}) + '\n')
            index = root / 'session_index.jsonl'
            with patch.object(server, 'CODEX', sessions), patch.object(server, 'PROJECTS', root / 'projects'), \
                 patch.object(server, 'FILES', {}), patch.object(server, 'OVERRIDES', {}), patch.object(server, 'DEAD', {}):
                for title in ['Original name', 'Renamed task']:
                    with index.open('a') as f:
                        f.write(json.dumps({'id': 'test', 'thread_name': title}) + '\n{partial\n')
                    server.scan_once(time.time())
                    self.assertEqual(server.FILES[transcript].payload()['title'], title)

    def test_claude_rename_before_tail_survives_startup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript = root / 'project/session.jsonl'
            transcript.parent.mkdir()
            transcript.write_text(json.dumps({'type': 'custom-title', 'customTitle': 'Named desk'}) + '\n'
                                  + (json.dumps({'type': 'progress', 'text': 'x' * 1024}) + '\n') * 600
                                  + json.dumps({'type': 'user', 'message': {'content': 'Work'}}) + '\n')
            with patch.object(server, 'PROJECTS', root), patch.object(server, 'CODEX', root / 'sessions'), \
                 patch.object(server, 'FILES', {}), patch.object(server, 'OVERRIDES', {}), patch.object(server, 'DEAD', {}):
                server.scan_once(time.time())
                self.assertEqual(server.FILES[transcript].payload()['title'], 'Named desk')

    def test_claude_title_at_exact_tail_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'session.jsonl'
            prefix = json.dumps({'type': 'progress'}) + '\n'
            title = json.dumps({'type': 'custom-title', 'customTitle': 'Boundary title'}) + '\n'
            path.write_text(prefix + title)
            state = server.FileState(path)
            state.offset = len(prefix)
            server.restore_claude_title(state)
            self.assertEqual(state.payload()['title'], 'Boundary title')

    def test_missing_codex_index_is_optional(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'CODEX', Path(tmp) / 'sessions'):
            self.assertEqual(server.codex_titles(), {})
