import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class TaskTitlesTest(unittest.TestCase):
    def test_claude_naming_prompt_becomes_title_and_actual_quest(self):
        state = server.FileState(Path('/tmp/session.jsonl'))
        state.feed({'type': 'user', 'timestamp': '2026-09-22T20:00:00Z', 'message': {
            'content': server.TITLE_PROMPT + ', no punctuation, no preamble -- just the name. Task:\n\nReview the architecture'}})
        state.feed({'type': 'assistant', 'timestamp': '2026-09-22T20:00:01Z', 'message': {
            'content': [{'type': 'text', 'text': 'review_architecture\n\nI will inspect the codebase.'}]}})
        self.assertEqual(state.payload()['title'], 'review architecture')
        self.assertEqual(state.payload()['quest'], 'Review the architecture')
        self.assertEqual(state.payload()['chat'][-1]['text'], 'I will inspect the codebase.')

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

    def test_generated_claude_title_before_tail_survives_startup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript = root / 'project/session.jsonl'
            transcript.parent.mkdir()
            transcript.write_text(
                json.dumps({'type': 'user', 'message': {'content': server.TITLE_PROMPT + ' Task: Review architecture'}}) + '\n' +
                json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'review_architecture'}]}}) + '\n' +
                (json.dumps({'type': 'progress', 'text': 'x' * 1024}) + '\n') * 600)
            with patch.object(server, 'PROJECTS', root), patch.object(server, 'CODEX', root / 'sessions'), \
                    patch.object(server, 'FILES', {}), patch.object(server, 'OVERRIDES', {}), patch.object(server, 'DEAD', {}):
                server.scan_once(time.time())
                self.assertEqual(server.FILES[transcript].payload()['title'], 'review architecture')

    def test_generated_title_prompt_split_by_tail_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'session.jsonl'
            prompt = json.dumps({'type': 'user', 'message': {'content': server.TITLE_PROMPT + ' Task: Review architecture'}}) + '\n'
            reply = {'type': 'assistant', 'timestamp': '2026-09-22T20:00:01Z',
                     'message': {'content': [{'type': 'text', 'text': 'review_architecture'}]}}
            path.write_text(prompt + json.dumps(reply) + '\n')
            state = server.FileState(path)
            state.offset = len(prompt) // 2
            server.restore_claude_title(state)
            state.feed(reply)
            self.assertEqual(state.payload()['title'], 'review architecture')

    def test_restores_generated_title_from_text_block_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'session.jsonl'
            prompt = {'type': 'user', 'message': {'content': [
                {'type': 'text', 'text': server.TITLE_PROMPT + ' Task: Review architecture'}]}}
            reply = {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'review_architecture'}]}}
            path.write_text(json.dumps(prompt) + '\n' + json.dumps(reply) + '\n')
            state = server.FileState(path)
            state.offset = path.stat().st_size
            server.restore_claude_title(state)
            self.assertEqual(state.payload()['title'], 'review architecture')

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
