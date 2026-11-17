import base64
import io
import json
import os
import struct
import tempfile
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import server


def remotes(agents=(), quotas=(), resources=None):
    return {'mage-tower': {'agents': list(agents), 'quotas': list(quotas), 'resources': resources or {},
                           'orphans': [], 'chronicle': {}}}


class TranscriptScanTest(unittest.TestCase):
    @unittest.skipUnless(server.BULK_STAT, 'macOS bulk metadata API')
    def test_bulk_metadata_matches_stat_across_batches_unicode_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for i in range(400):
                path = root / (f'{i:04d}-' + 'x' * 120 + '.jsonl')
                path.write_text('{}\n')
                os.utime(path, ns=(1800000000000000000 + i, 1800000000000000000 + i))
            regular = root / '.rúné-⟡.jsonl'
            regular.write_text('{}\n')
            (root / 'alias.jsonl').symlink_to(regular)
            (root / 'missing.jsonl').symlink_to(root / 'absent')
            (root / 'folder.jsonl').mkdir()
            expected = {}
            for entry in root.iterdir():
                try:
                    st = entry.stat()
                except OSError:
                    continue
                expected[str(entry)] = (st.st_ino, st.st_size, st.st_mtime)
            actual = {path: (st.st_ino, st.st_size, st.st_mtime) for path, st in server.bulk_transcripts(root, '*.jsonl', 0)}
            self.assertEqual(actual, expected)

    def test_unsupported_bulk_read_closes_directory_and_uses_portable_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'file.jsonl'
            path.write_text('{}\n')
            with patch.object(server, 'BULK_STAT', side_effect=OSError('unsupported')), \
                    patch.object(server.os, 'close', wraps=os.close) as close:
                entries = list(server.transcript_entries(path.parent, ('*.jsonl',), 0))
            self.assertEqual([name for name, _ in entries], [str(path)])
            self.assertEqual(entries[0][1].st_size, 3)
            close.assert_called_once()

    def test_malformed_later_batch_discards_partial_bulk_results(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'file.jsonl'
            path.write_text('{}\n')
            name = b'file.jsonl\0'
            length = (72 + len(name) + 7) // 8 * 8
            record = struct.pack('=I5IIiIIqqQq', length, 0xa2000409, 0, 0, 0x200, 0,
                                 0, 44, len(name), 1, 1800000000, 0, path.stat().st_ino, 999) + name
            chunks = iter([record.ljust(length, b'\0'), b'\0' * 64])
            def read(_fd, _attrs, buf, size, _flags):
                buf.raw = next(chunks).ljust(size, b'\0')
                return 1
            with patch.object(server, 'BULK_STAT', side_effect=read):
                entries = list(server.transcript_entries(path.parent, ('*.jsonl',), 0))
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0][0], str(path))
            self.assertEqual(entries[0][1].st_size, 3)

    def test_discovers_hidden_transcripts_and_resumed_history_and_removes_stale_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root, now = Path(directory), 1800000000
            projects, sessions = root / 'projects', root / 'sessions'
            paths = [projects / '.hidden/.main.jsonl', projects / 'project/session/subagents/agent-child.jsonl',
                     sessions / '2026/01/01/rollout-old.jsonl']
            for path in paths:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{}\n')
                os.utime(path, (now, now))
            old = paths[-1]
            os.utime(old, (now - server.FRESH_SEC - 1, now - server.FRESH_SEC - 1))
            with patch.object(server, 'PROJECTS', projects), patch.object(server, 'CODEX', sessions), \
                    patch.object(server, 'FILES', {}):
                server.scan_once(now)
                self.assertEqual(set(server.FILES), set(paths[:-1]))
                with old.open('a') as f:
                    f.write('{}\n')
                os.utime(old, (now, now))
                server.scan_once(now)
                self.assertEqual(set(server.FILES), set(paths))
                paths[0].unlink()
                os.utime(paths[1], (now - server.FRESH_SEC - 1, now - server.FRESH_SEC - 1))
                server.scan_once(now)
                self.assertEqual(set(server.FILES), {old})

    def test_scan_still_reads_appends_and_same_size_rewrites(self):
        with tempfile.TemporaryDirectory() as directory:
            root, now = Path(directory), 1800000000
            transcript = root / 'project/session.jsonl'
            transcript.parent.mkdir()
            def title(text):
                return json.dumps({'type': 'custom-title', 'customTitle': text}) + '\n'
            transcript.write_text(title('first'))
            with patch.object(server, 'PROJECTS', root), patch.object(server, 'CODEX', root / 'sessions'), \
                    patch.object(server, 'FILES', {}):
                os.utime(transcript, (now, now))
                server.scan_once(now)
                self.assertEqual(server.FILES[transcript].custom_title, 'first')
                with transcript.open('a') as f:
                    f.write(title('later'))
                os.utime(transcript, (now + 1, now + 1))
                server.scan_once(now + 1)
                self.assertEqual(server.FILES[transcript].custom_title, 'later')
                transcript.write_text(title('other') + title('final'))
                os.utime(transcript, (now + 2, now + 2))
                server.scan_once(now + 2)
                self.assertEqual(server.FILES[transcript].custom_title, 'final')


class RemoteAgentsTest(unittest.TestCase):
    def test_namespaces_remote_agents_and_parents(self):
        payload = {'agents': [
            {'id': 'parent', 'parent': None},
            {'id': 'child', 'parent': 'parent'},
        ]}

        agents = server.remote_agents('mage-tower', payload)

        self.assertEqual(
            [(a['id'], a['parent'], a['origin'], a['host']) for a in agents],
            [
                ('mage-tower:parent', None, 'remote', 'mage-tower'),
                ('mage-tower:child', 'mage-tower:parent', 'remote', 'mage-tower'),
            ],
        )

    def test_remote_ids_are_namespaced_except_the_tower(self):
        agent = {'id': 'a', 'missives': [{'to': 'b'}], 'clash': [{'with': 'c'}], 'inbox': [{'from': 'tower'}]}
        [a] = server.remote_agents('mage-tower', {'agents': [agent]})
        self.assertEqual((a['missives'][0]['to'], a['clash'][0]['with'], a['inbox'][0]['from']),
                         ('mage-tower:b', 'mage-tower:c', 'tower'))

    def test_stream_scans_before_its_first_snapshot(self):
        out = io.StringIO()
        with patch.object(server, 'scan_local') as scan, patch.object(server.os, 'getppid', side_effect=[2, 1]), \
                patch.object(server.time, 'sleep'), patch.object(server, 'state_payload',
                                                               side_effect=lambda _: scan.assert_called_once() or {'agents': []}):
            server.stream_snapshots(out)
        self.assertEqual(json.loads(out.getvalue())['agents'], [])

    def test_ignores_malformed_remote_agents(self):
        self.assertEqual(server.remote_agents('mage-tower', {'agents': [None, {}]}), [])

    def test_extracts_codex_and_claude_quotas_for_remote_usage_probe(self):
        payload = {'agents': [], 'quotas': [
            {'id': 'claude:active', 'provider': 'claude', 'period': 'weekly', 'left': 30, 'origins': ['local']},
            {'id': 'other', 'provider': 'other'},
            {'id': 'work', 'provider': 'codex', 'period': 'weekly', 'left': 60, 'origins': ['local'],
             'timerPrompt': {'status': 'sent', 'fact': 'A remote timer fact'}},
        ]}

        snapshot = server.remote_snapshot('mage-tower', payload)

        self.assertEqual(snapshot['agents'], [])
        self.assertEqual(snapshot['quotas'], [{
            'id': 'claude:active', 'provider': 'claude', 'period': 'weekly', 'left': 30, 'origins': ['remote'],
        }, {
            'id': 'work', 'provider': 'codex', 'period': 'weekly', 'left': 60, 'origins': ['remote'],
            'timerPrompt': {'status': 'sent', 'fact': 'A remote timer fact'},
        }])

    def test_follow_remote_applies_streamed_snapshots_and_reconnects(self):
        snapshot = lambda agent, quotas: json.dumps({'agents': [{'id': agent}], 'quotas': quotas,
                                                     'resources': {'local': {'cpu': 7}}}).encode() + b'\n'
        first = MagicMock(stdout=iter([snapshot('a', [{'id': 'q', 'provider': 'codex', 'origins': ['local']}])]))
        second = MagicMock(stdout=iter([snapshot('b', None)]))  # a fresh scanner has not read usage yet
        class Stop(Exception):
            pass
        with patch.object(server.subprocess, 'Popen', side_effect=[first, second]) as popen, \
                patch.object(server, 'REMOTES', {}), patch.object(server.time, 'sleep', side_effect=[None, Stop]):
            with self.assertRaises(Stop):
                server.follow_remote('mage-tower')
            remote = server.REMOTES['mage-tower']
        self.assertEqual([a['id'] for a in remote['agents']], ['mage-tower:b'])
        self.assertEqual([q['id'] for q in remote['quotas']], ['q'])
        self.assertEqual(remote['resources'], {'cpu': 7, 'host': 'mage-tower'})
        self.assertEqual(popen.call_count, 2)
        self.assertIn('--stream', popen.call_args.args[0])
        second.stdin.write.assert_called_once_with(server.remote_source())

    def test_bundled_source_runs_from_stdin_and_streams(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {**server.os.environ, 'HOME': directory, 'CODEX_HOME': directory, 'PYTHONPATH': ''}
            result = subprocess.run([sys.executable, '-', '--debug-scan'], input=server.remote_source(),
                                    capture_output=True, cwd=directory, env=env, check=True)
            self.assertEqual(json.loads(result.stdout)['agents'], [])
            proc = subprocess.Popen([sys.executable, '-', '--stream'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, cwd=directory, env=env)
            try:
                proc.stdin.write(server.remote_source())
                proc.stdin.close()
                snapshot = json.loads(proc.stdout.readline())
            finally:
                proc.kill()
                proc.wait()
                proc.stdout.close()
        self.assertEqual((snapshot['agents'], snapshot['chronicle']), ([], {}))


class CpuUsageTest(unittest.TestCase):
    def test_macos_memory_includes_inactive_app_memory_and_excludes_cache(self):
        memory = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: 100.\nAnonymous pages: 150.\nPages wired down: 20.\nPages occupied by compressor: 10.\nPages purgeable: 5.\n'
        procs = [MagicMock(stdout=str(256 * 16384)), MagicMock(stdout=memory)]
        with patch.object(server.sys, 'platform', 'darwin'), patch.object(server, 'read_cpu_usage', return_value=30), \
                patch.object(server.subprocess, 'run', side_effect=procs), patch.object(server.os, 'cpu_count', return_value=12):
            resources = server.read_resources()
        self.assertEqual((resources['memoryUsed'], resources['memoryTotal'], resources['cores']),
                         (175 * 16384, 256 * 16384, 12))

    def test_linux_memory_uses_available_including_reclaimable_cache(self):
        with patch.object(server.sys, 'platform', 'linux'), patch.object(server, 'read_cpu_usage', side_effect=[None, 40]), \
                patch.object(server.time, 'sleep'), patch.object(server.Path, 'read_text',
                    return_value='MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\n'):
            resources = server.read_resources()
        self.assertEqual((resources['cpu'], resources['memoryUsed'], resources['memoryTotal']), (40, 600 * 1024, 1000 * 1024))

    def test_disk_usage_tracks_the_home_filesystem(self):
        disk = MagicMock(used=300, total=1000)
        with patch.object(server.shutil, 'disk_usage', return_value=disk) as usage:
            resources = server.read_resources()
        usage.assert_called_once_with(server.Path.home())
        self.assertEqual((resources['diskUsed'], resources['diskTotal']), (300, 1000))

    def test_remote_snapshot_returns_machine_resources(self):
        resources = {'cpu': 30, 'cores': 8, 'memoryUsed': 1024, 'memoryTotal': 2048}
        self.assertEqual(server.remote_snapshot('mage-tower', {'resources': {'local': resources}})['resources'],
                         {**resources, 'host': 'mage-tower'})

    def test_remote_snapshot_survives_polling_gaps(self):
        agents = [{'id': 'mage-tower:agent', 'started': 100, 'origin': 'remote', 'prs': []}]
        with patch.object(server, 'FILES', {}), patch.object(server, 'REMOTES', remotes(agents, resources={'cpu': 40})), \
                patch.object(server, 'HOSTS', ['mage-tower']):
            for now in (101, 120, 3700):
                with self.subTest(now=now), patch.object(server.time, 'time', return_value=now):
                    state = server.state_payload(None)
                    self.assertEqual(state['agents'], agents)
                    self.assertEqual(state['resources']['remote'], {'cpu': 40})

    def test_remote_snapshot_reflects_successful_empty_scan(self):
        with patch.object(server, 'FILES', {}), patch.object(server, 'REMOTES', remotes(resources={'cpu': 10})), \
                patch.object(server, 'HOSTS', ['mage-tower']):
            state = server.state_payload(None)
        self.assertEqual(state['agents'], [])
        self.assertEqual(state['resources']['remote'], {'cpu': 10})

    def test_reads_macos_cpu_counters_without_spawning_top(self):
        readings = iter([(100, 50, 850, 0), (110, 60, 930, 0)])
        def read(_host, flavor, ticks, count):
            self.assertEqual(flavor, 3)
            ticks[:] = next(readings)
            return 0
        mach = MagicMock()
        mach.host_statistics.side_effect = read
        with patch.object(server.sys, 'platform', 'darwin'), patch.object(server, 'MACH', mach), \
                patch.object(server, 'MACH_HOST', 1, create=True), patch.object(server, 'CPU_TIMES', None), \
                patch.object(server.subprocess, 'run') as run:
            self.assertIsNone(server.read_cpu_usage())
            self.assertAlmostEqual(server.read_cpu_usage(), 20)
        run.assert_not_called()

    def test_macos_cpu_counter_failure_is_reported(self):
        mach = MagicMock()
        mach.host_statistics.return_value = 5
        with patch.object(server.sys, 'platform', 'darwin'), patch.object(server, 'MACH', mach), \
                patch.object(server, 'MACH_HOST', 1, create=True), self.assertRaises(OSError):
            server.read_cpu_usage()

    def test_linux_cpu_usage_does_not_double_count_guest_time(self):
        readings = ['cpu 100 0 0 900 0 0 0 0 100 0\n', 'cpu 150 0 0 950 0 0 0 0 150 0\n']
        with patch.object(server.sys, 'platform', 'linux'), patch.object(server.Path, 'read_text', side_effect=readings), \
                patch.object(server, 'CPU_TIMES', None):
            self.assertIsNone(server.read_cpu_usage())
            self.assertEqual(server.read_cpu_usage(), 50)

    def test_state_payload_includes_cpu_usage(self):
        with patch.object(server, 'CPU_USAGE', 42.5), patch.object(server, 'REMOTES', {}), \
                patch.object(server, 'LOCAL_QUOTAS', []):
            self.assertEqual(server.state_payload(None)['cpu'], 42.5)


class ChatLogTest(unittest.TestCase):
    TURN = [{'type': 'user', 'timestamp': '2026-08-02T20:00:00Z', 'promptSource': 'typed',
             'message': {'content': 'find the flaky test'}},
            {'type': 'assistant', 'timestamp': '2026-08-02T20:00:05Z',
             'message': {'content': [{'type': 'text', 'text': 'Found it in test_auth.py'}]}}]

    def chat(self, rows):
        fs = server.FileState(server.Path('/tmp/projects/whatever/deadbeef.jsonl'))
        for row in rows:
            fs.feed(row)
        return [(c['role'], c['text']) for c in fs.chat]

    def test_records_both_sides_in_order(self):
        self.assertEqual(self.chat(self.TURN),
                         [('user', 'find the flaky test'), ('agent', 'Found it in test_auth.py')])

    def test_survives_a_re_read_of_the_same_tail(self):
        # retail() re-feeds up to TAIL_BYTES after a rewrite; the exchange must not double up.
        self.assertEqual(self.chat(self.TURN * 2), self.chat(self.TURN))


def codex_rollout(path, rows):
    fs = server.FileState(server.Path(path))
    for i, (kind, payload) in enumerate(rows):
        fs.feed({'type': kind, 'timestamp': f'2026-11-14T10:00:{i:02d}Z', 'payload': payload})
    return fs


def item(kind, **fields):
    return ('event_msg', {'type': 'item_completed', 'item': {'type': kind, **fields}})


class CodexRolloutTest(unittest.TestCase):
    def test_current_rollouts_fill_the_journal_quest_and_branch(self):
        fs = codex_rollout('/tmp/sessions/2026/11/14/rollout-2026-11-14T10-00-00-thread.jsonl', [
            ('session_meta', {'id': 'thread', 'cwd': '/src/espresso', 'source': 'vscode', 'git': {'branch': 'ben/fix'}}),
            ('event_msg', {'type': 'task_started', 'model_context_window': 258400}),
            item('UserMessage', content=[{'type': 'text', 'text': 'Fix the flaky auth test'}]),
            item('AgentMessage', phase='commentary', content=[{'type': 'text', 'text': 'Reading the test first.'}]),
            ('response_item', {'type': 'function_call', 'name': 'exec_command', 'arguments': '{"cmd": "pytest -q"}'}),
            item('AgentMessage', phase='final_answer', content=[{'type': 'text', 'text': 'Fixed: the clock was not frozen.'}]),
            ('event_msg', {'type': 'task_complete', 'last_agent_message': 'Fixed: the clock was not frozen.'}),
            item('UserMessage', content=[{'type': 'text', 'text': '<send_user_message_question_reply>' + json.dumps(
                 [{'question': 'Ship it?', 'answer': 'Yes, ship it', 'questionItemId': 'q1'}]) + '</send_user_message_question_reply>'}]),
            ('event_msg', {'type': 'thread_goal_updated', 'goal': {'objective': 'Stabilize auth tests'}}),
        ])
        self.assertEqual([(c['role'], c['text']) for c in fs.chat], [
            ('user', 'Fix the flaky auth test'), ('agent', 'Fixed: the clock was not frozen.'), ('user', 'Yes, ship it')])
        self.assertEqual((fs.quest, fs.title, fs.branch), ('Yes, ship it', 'Stabilize auth tests', 'ben/fix'))

    def test_subagent_task_comes_from_its_user_message_and_injections_are_skipped(self):
        user = lambda text: ('response_item', {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': text}]})
        fs = codex_rollout('/tmp/sessions/2026/11/14/rollout-2026-11-14T10-00-00-child.jsonl', [
            ('session_meta', {'id': 'child', 'parent_thread_id': 'root', 'source': {'subagent': {'thread_spawn': {}}}}),
            user('# AGENTS.md instructions for /src\n\n<INSTRUCTIONS>be terse</INSTRUCTIONS>'),
            user('<environment_context>cwd</environment_context>'),
            user('Audit the cache keys'),
            item('UserMessage', content=[{'type': 'text', 'text': 'Audit the cache keys'}]),
            ('event_msg', {'type': 'task_complete', 'last_agent_message': 'Two keys collide.'}),
            user('<turn_aborted>The user interrupted</turn_aborted>'),
        ])
        self.assertEqual([(c['role'], c['text']) for c in fs.chat], [('user', 'Audit the cache keys'), ('agent', 'Two keys collide.')])
        self.assertEqual((fs.kind, fs.parent, fs.quest, fs.last_kind), ('sub', 'root', 'Audit the cache keys', 'assistant_text'))

    def test_legacy_event_messages_still_count(self):
        fs = codex_rollout('/tmp/sessions/2026/01/01/rollout-2026-01-01T10-00-00-old.jsonl', [
            ('event_msg', {'type': 'user_message', 'message': '<task>Index the scrolls</task>'}),
            ('event_msg', {'type': 'agent_message', 'message': 'Indexed.'}),
            ('event_msg', {'type': 'task_complete'}),
        ])
        self.assertEqual([(c['role'], c['text']) for c in fs.chat], [('user', 'Index the scrolls'), ('agent', 'Indexed.')])


class QuotaTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        config = self.root / 'codex-quota'
        config.mkdir()
        self.a, self.b = self.root / 'a', self.root / 'b'
        for home, identity in [(self.a, 'a'), (self.b, 'b')]:
            home.mkdir()
            claims = base64.urlsafe_b64encode(json.dumps({'sub': identity}).encode()).decode().rstrip('=')
            (home / 'auth.json').write_text(json.dumps({'tokens': {'account_id': identity, 'id_token': f'x.{claims}.x'}}))
        (config / 'accounts.json').write_text(json.dumps({'Listed': '../a'}))
        env = patch.dict(server.os.environ, {'XDG_CONFIG_HOME': str(self.root), 'CODEX_HOME': str(self.a),
                                            'CLAUDE_CONFIG_DIR': str(self.root / 'claude')})
        env.start()
        self.addCleanup(env.stop)

    def cli(self, args, **kwargs):
        config = Path(args[args.index('--config') + 1]) if '--config' in args else None
        names = json.loads(config.read_text()) if config else {}
        names = names.get('codex', {}) if 'codex' in names else names
        accounts = [dict(name=name, provider='codex', weeklyUsedPercent=25,
                         weeklyResetsAt=123, weeklyResetDetail='2 Minutes', availableResets=2,
                         resetExpirations=[456, None], error=None)
                    for name in names]
        if '--codex-only' not in args:
            accounts.append(dict(name='Claude', provider='claude', weeklyUsedPercent=35,
                                 weeklyResetsAt=456, availableResets=None, error=None))
        return MagicMock(returncode=0, stdout=json.dumps({'accounts': accounts}), stderr='')

    def test_running_daemon_overrides_changed_login_file(self):
        daemon = dict(id=server.account_id(self.b), name='Running', provider='codex',
                      origins=['local'], left=0, error=None)
        with patch.object(server, 'CODEX_DAEMON', None), \
                patch.object(server, 'daemon_quota', return_value=daemon), \
                patch.object(server.subprocess, 'run', side_effect=self.cli) as run:
            self.assertEqual(server.account_quotas(False), [daemon])
            run.assert_not_called()
            self.assertEqual(server.active_codex_id(), daemon['id'])
            quotas = server.account_quotas(True)
            self.assertEqual([(q['name'], q['origins']) for q in quotas if q['provider'] == 'codex'],
                             [('Listed', []), ('Running', ['local'])])
            with patch.object(server, 'LOCAL_QUOTAS', quotas), patch.object(server, 'REMOTES', {}):
                self.assertEqual([q['origins'] for q in server.state_payload(None)['quotas']
                                  if q['provider'] == 'codex'], [[], ['local']])

    def test_daemon_failure_keeps_identity_instead_of_using_file_login(self):
        daemon = dict(id=server.account_id(self.b), name='Running', origins=['local'], left=0)
        with patch.object(server, 'CODEX_DAEMON', (server.active_home(), daemon)), \
                patch.object(server, 'daemon_quota', side_effect=TimeoutError):
            self.assertTrue(server.account_quotas(False)[0]['stale'])
            self.assertEqual(server.active_codex_id(), daemon['id'])
        with patch.object(server, 'CODEX_DAEMON', None), \
                patch.object(server, 'daemon_quota', side_effect=TimeoutError):
            self.assertEqual(server.account_quotas(False), [])
            self.assertIsNone(server.active_codex_id())
            with patch.object(server.subprocess, 'run', side_effect=self.cli):
                quotas = server.account_quotas(True)
            self.assertEqual([(q['name'], q['origins']) for q in quotas],
                             [('Listed', []), ('Claude', ['local'])])

    def test_daemon_identity_matches_configured_token_identity(self):
        claims = base64.urlsafe_b64encode(json.dumps({
            'sub': 'external-login', 'https://api.openai.com/auth': {'chatgpt_user_id': 'user-a'}}).encode()).decode()
        (self.a / 'auth.json').write_text(json.dumps({'tokens': {'account_id': 'a', 'id_token': f'x.{claims}.x'}}))
        self.assertEqual(server.account_id(self.a), server.login_key('a', 'user-a'))

    def test_daemon_websocket_reads_account_and_weekly_usage(self):
        path = self.a / 'app-server-control/app-server-control.sock'
        path.parent.mkdir()
        path.touch()
        key = base64.b64encode(b'x' * 16).decode()
        accept = base64.b64encode(server.hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        data = bytearray(b'HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ' + accept + b'\r\n\r\n')
        def frame(value, opcode=0x81):
            payload = json.dumps(value).encode()
            return bytes([opcode, 126]) + server.struct.pack('!H', len(payload)) + payload
        data.extend(frame({'id': 1, 'result': {}}))
        data.extend(bytes([0x89, 1]) + b'p')  # ping between RPC responses
        data.extend(frame({'id': 2, 'result': {'userId': 'user-a', 'account': {'email': 'running@example.com'}}}))
        data.extend(frame({'id': 3, 'result': {'accountId': 'a', 'rateLimits': {
            'planType': 'pro', 'primary': {'usedPercent': 100, 'windowDurationMins': 10080, 'resetsAt': 123}},
            'rateLimitResetCredits': {'availableCount': 1, 'credits': [{'status': 'available', 'expiresAt': 456}]}}}))
        def recv(size):
            chunk = bytes(data[:size])
            del data[:size]
            return chunk
        sock = MagicMock()
        sock.__enter__.return_value = sock
        sock.recv.side_effect = recv
        with patch.object(server.socket, 'socket', return_value=sock), patch.object(server.os, 'urandom', side_effect=lambda n: b'x' * n):
            quota = server.daemon_quota()
        self.assertEqual((quota['id'], quota['left'], quota['resets_at'], quota['reset_expirations']),
                         (server.login_key('a', 'user-a'), 0, 123, [456]))
        self.assertTrue(any(call.args[0][0] == 0x8a for call in sock.sendall.call_args_list))

    def test_listed_accounts_use_installed_cli_and_include_claude(self):
        with patch.object(server.subprocess, 'run', side_effect=self.cli) as run:
            quotas = server.account_quotas(True)
        self.assertEqual(run.call_args.args[0], ['token-quota', '--json', '--detailed-reset-timing', '--config',
                         str(self.root / 'codex-quota/accounts.json')])
        self.assertEqual([(q['name'], q['origins'], q['left']) for q in quotas],
                         [('Listed', ['local'], 75), ('Claude', ['local'], 65)])
        self.assertEqual([q['resets_left'] for q in quotas], [2, None])
        self.assertEqual(quotas[1]['id'], 'claude:active')
        self.assertEqual(quotas[0]['reset_detail'], '2 Minutes')
        self.assertEqual(quotas[0]['reset_expirations'], [456, None])
        self.assertIsNone(quotas[1]['reset_expirations'])

    def test_quota_labels_split_model(self):
        self.assertEqual(server.quota_label('Espresso Fable', 'claude'),
                         {'name': 'Espresso Fable', 'account': 'Espresso', 'model': 'Fable'})
        self.assertEqual(server.quota_label('Espresso', 'claude'),
                         {'name': 'Espresso', 'account': 'Espresso', 'model': 'Claude'})
        self.assertEqual(server.quota_label('Mirasume', 'codex'),
                         {'name': 'Mirasume', 'account': 'Mirasume', 'model': None})
        self.assertEqual(server.quota_label('Claude', 'claude'),
                         {'name': 'Claude', 'account': '', 'model': 'Claude'})

    def test_sectioned_config_reads_codex_homes(self):
        config = self.root / 'codex-quota/accounts.json'
        config.write_text(json.dumps({'codex': json.loads(config.read_text()), 'claude': {'Work (10x)': '../c'}}))
        with patch.object(server.subprocess, 'run', side_effect=self.cli):
            quotas = server.account_quotas(True)
        self.assertEqual([(q['name'], q['provider']) for q in quotas], [('Listed', 'codex'), ('Claude', 'claude')])

    def test_older_cli_is_retried_without_detailed_flag(self):
        old = MagicMock(returncode=2, stdout='', stderr='error: unrecognized arguments: --detailed-reset-timing')
        with patch.object(server.subprocess, 'run', side_effect=[old, self.cli(
                ['--config', str(self.root / 'codex-quota/accounts.json')])]) as run:
            quotas = server.account_quotas(True)
        self.assertEqual(len(quotas), 2)
        self.assertNotIn('--detailed-reset-timing', run.call_args.args[0])

    def test_local_account_uses_temporary_config_even_if_not_listed(self):
        with patch.dict(server.os.environ, {'CODEX_HOME': str(self.b)}), \
                patch.object(server.subprocess, 'run', side_effect=self.cli) as run:
            quotas = server.account_quotas(False)
        self.assertEqual([(q['name'], q['origins']) for q in quotas], [('In use', ['local'])])
        self.assertEqual(run.call_args.args[0][:3], ['token-quota', '--json', '--detailed-reset-timing'])
        self.assertIn('--codex-only', run.call_args.args[0])

    def test_missing_config_still_reads_claude(self):
        (self.root / 'codex-quota/accounts.json').unlink()
        with patch.object(server.subprocess, 'run', side_effect=self.cli) as run:
            quotas = server.account_quotas(True)
        self.assertEqual(run.call_args.args[0], ['token-quota', '--json', '--detailed-reset-timing', '--claude-only'])
        self.assertEqual([q['name'] for q in quotas], ['Claude'])

    def test_disconnected_local_account_does_not_call_cli(self):
        (self.b / 'auth.json').unlink()
        with patch.dict(server.os.environ, {'CODEX_HOME': str(self.b)}), \
                patch.object(server.subprocess, 'run') as run:
            self.assertEqual(server.account_quotas(False), [])
        run.assert_not_called()

    def test_new_config_account_appears_on_next_read(self):
        with patch.object(server.subprocess, 'run', side_effect=self.cli):
            before = server.account_quotas(True)
            (self.root / 'codex-quota/accounts.json').write_text(
                json.dumps({'Listed': '../a', 'Additional': '../b'}))
            after = server.account_quotas(True)
        self.assertEqual([q['name'] for q in before], ['Listed', 'Claude'])
        self.assertEqual([q['name'] for q in after], ['Listed', 'Additional', 'Claude'])
        self.assertNotEqual(after[0]['id'], after[1]['id'])
        self.assertEqual([q['origins'] for q in after[:2]], [['local'], []])

    def test_local_label_tracks_login_without_local_quota_readings(self):
        quotas = [{'id': server.account_id(home), 'provider': 'codex', 'origins': origins}
                  for home, origins in [(self.a, []), (self.b, ['remote'])]]
        with patch.object(server, 'REMOTES', remotes(quotas=quotas)), patch.object(server, 'LOCAL_QUOTAS', []):
            self.assertEqual([q['origins'] for q in server.state_payload(None)['quotas']],
                             [['local'], ['remote']])
            with patch.dict(server.os.environ, {'CODEX_HOME': str(self.b)}):
                self.assertEqual([q['origins'] for q in server.state_payload(None)['quotas']],
                                 [[], ['remote', 'local']])
            (self.a / 'auth.json').unlink()
            self.assertEqual([q['origins'] for q in server.state_payload(None)['quotas']],
                             [[], ['remote']])
        self.assertEqual([q['origins'] for q in quotas], [[], ['remote']])

    def test_configured_claude_labels_match_only_main_login(self):
        for home, identity in [(self.a, 'a'), (self.b, 'b')]:
            (home / '.claude.json').write_text(json.dumps({'oauthAccount': {
                'accountUuid': identity, 'organizationUuid': 'org'}}))
        (self.root / 'codex-quota/accounts.json').write_text(json.dumps({
            'claude': {'Work (10x)': '../a', 'Personal (20x)': '../b'}}))
        rows = [dict(name=name, provider='claude', weeklyUsedPercent=25,
                     weeklyResetsAt=123, availableResets=2, error=None)
                for name in ('Work (10x)', 'Work (10x) Fable', 'Personal (20x)', 'Personal (20x) Fable')]
        proc = MagicMock(returncode=0, stdout=json.dumps({'accounts': rows}), stderr='')
        with patch.dict(server.os.environ, {'CLAUDE_CONFIG_DIR': str(self.b)}), \
                patch.object(server.subprocess, 'run', return_value=proc):
            quotas = server.account_quotas(True)
            self.assertEqual([q['origins'] for q in quotas], [[], [], ['local'], ['local']])
            remote = server.remote_snapshot('mage-tower', {'quotas': quotas})['quotas']
            with patch.object(server, 'REMOTES', remotes(quotas=remote)), patch.object(server, 'LOCAL_QUOTAS', []), \
                    patch.dict(server.os.environ, {'CLAUDE_CONFIG_DIR': str(self.a)}):
                self.assertEqual([q['origins'] for q in server.state_payload(None)['quotas']],
                                 [['local'], ['local'], ['remote'], ['remote']])

    def test_cli_exit_one_still_uses_partial_readings_and_timer_prompt(self):
        account = dict(name='Listed', provider='codex', weeklyUsedPercent=0,
                       weeklyResetsAt=123, availableResets=2, error='one account failed',
                       timerPrompt={'status': 'sent', 'fact': 'A timer fact'})
        proc = MagicMock(returncode=1, stdout=json.dumps({'accounts': [account]}), stderr='')
        with patch.object(server.subprocess, 'run', return_value=proc):
            quotas = server.account_quotas(True)
        self.assertEqual(quotas[0]['timerPrompt']['fact'], 'A timer fact')
        self.assertEqual(quotas[0]['error'], 'one account failed')

    def test_cli_setup_error_is_reported(self):
        proc = MagicMock(returncode=2, stdout='', stderr='missing configuration')
        with patch.object(server.subprocess, 'run', return_value=proc):
            with self.assertRaisesRegex(RuntimeError, 'missing configuration'):
                server.account_quotas(True)

    def test_timer_prompts_stay_in_state_until_server_reset(self):
        prompt = {'id': 'a', 'name': 'Listed', 'provider': 'codex',
                  'timerPrompt': {'status': 'sent', 'fact': 'A timer fact'}}
        with patch.object(server, 'TIMER_PROMPTS', []), patch.object(server, 'REMOTES', {}), \
                patch.object(server, 'LOCAL_QUOTAS', []):
            server.record_timer_prompts([prompt, prompt])
            self.assertEqual(server.state_payload(None)['timerPrompts'],
                             [{'id': 'a', 'name': 'Listed', 'provider': 'codex', 'fact': 'A timer fact'}])
            server.record_timer_prompts([])
            self.assertEqual(len(server.state_payload(None)['timerPrompts']), 1)

    def test_quota_cache_survives_agent_polling_outage(self):
        cached = [{'id': 'a', 'name': 'Listed', 'origins': ['remote'], 'left': 50}]
        with patch.object(server, 'REMOTES', remotes(quotas=cached)), patch.object(server, 'LOCAL_QUOTAS', []):
            self.assertEqual(server.state_payload(None)['quotas'], cached)

    def test_local_and_remote_account_merge_keeps_name_and_both_origins(self):
        remote = [{'id': 'a', 'name': 'Listed', 'origins': ['remote'], 'left': None, 'error': 'unavailable'}]
        local = [{'id': 'a', 'name': 'In use', 'origins': ['local'], 'left': 75, 'error': None}]
        quotas = server.merge_quotas(remote, local)
        self.assertEqual((quotas[0]['name'], quotas[0]['origins'], quotas[0]['left']),
                         ('Listed', ['remote', 'local'], 75))

    def test_unreadable_auth_does_not_match_another_account(self):
        (self.a / 'auth.json').write_text('{}')
        self.assertIsNone(server.account_id(self.a))


if __name__ == '__main__':
    unittest.main()
