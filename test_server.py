import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import server


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

    def test_ignores_malformed_remote_agents(self):
        self.assertEqual(server.remote_agents('mage-tower', {'agents': [None, {}]}), [])

    def test_extracts_codex_and_claude_quotas_for_remote_usage_probe(self):
        payload = {'agents': [], 'quotas': [
            {'id': 'claude:active', 'provider': 'claude', 'period': 'weekly', 'left': 30, 'origins': ['local']},
            {'id': 'other', 'provider': 'other'},
            {'id': 'work', 'provider': 'codex', 'period': 'weekly', 'left': 60, 'origins': ['local'],
             'timerPrompt': {'status': 'sent', 'fact': 'A remote timer fact'}},
        ]}

        agents, quotas = server.remote_snapshot('mage-tower', payload)

        self.assertEqual(agents, [])
        self.assertEqual(quotas, [{
            'id': 'claude:active', 'provider': 'claude', 'period': 'weekly', 'left': 30, 'origins': ['remote'],
        }, {
            'id': 'work', 'provider': 'codex', 'period': 'weekly', 'left': 60, 'origins': ['remote'],
            'timerPrompt': {'status': 'sent', 'fact': 'A remote timer fact'},
        }])

    def test_usage_refresh_has_a_larger_remote_timeout(self):
        proc = MagicMock(stdout=b'{"agents": [], "quotas": []}')
        with patch.object(server.subprocess, 'run', return_value=proc) as run:
            server.scan_remote('mage-tower', True)

        self.assertEqual(run.call_args.kwargs['timeout'], server.QUOTA_TIMEOUT + 10)


class CpuUsageTest(unittest.TestCase):
    def test_reads_macos_idle_percentage(self):
        proc = MagicMock(stdout='CPU usage: 12.5% user, 7.5% sys, 80.0% idle\n')
        with patch.object(server.sys, 'platform', 'darwin'), patch.object(server.subprocess, 'run', return_value=proc):
            self.assertEqual(server.read_cpu_usage(), 20)
        proc.check_returncode.assert_called_once_with()

    def test_linux_cpu_usage_does_not_double_count_guest_time(self):
        readings = ['cpu 100 0 0 900 0 0 0 0 100 0\n', 'cpu 150 0 0 950 0 0 0 0 150 0\n']
        with patch.object(server.sys, 'platform', 'linux'), patch.object(server.Path, 'read_text', side_effect=readings), \
                patch.object(server, 'CPU_TIMES', None):
            self.assertIsNone(server.read_cpu_usage())
            self.assertEqual(server.read_cpu_usage(), 50)

    def test_state_payload_includes_cpu_usage(self):
        with patch.object(server, 'CPU_USAGE', 42.5), patch.object(server, 'REMOTE_QUOTAS', []), \
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
        env = patch.dict(server.os.environ, {'XDG_CONFIG_HOME': str(self.root), 'CODEX_HOME': str(self.a)})
        env.start()
        self.addCleanup(env.stop)

    def cli(self, args, **kwargs):
        config = Path(args[args.index('--config') + 1]) if '--config' in args else None
        names = json.loads(config.read_text()) if config else {}
        accounts = [dict(name=name, provider='codex', weeklyUsedPercent=25,
                         weeklyResetsAt=123, weeklyResetDetail='2 Minutes', availableResets=2, error=None)
                    for name in names]
        if '--codex-only' not in args:
            accounts.append(dict(name='Claude', provider='claude', weeklyUsedPercent=35,
                                 weeklyResetsAt=456, availableResets=None, error=None))
        return MagicMock(returncode=0, stdout=json.dumps({'accounts': accounts}), stderr='')

    def test_listed_accounts_use_installed_cli_and_include_claude(self):
        with patch.object(server.subprocess, 'run', side_effect=self.cli) as run:
            quotas = server.account_quotas(True)
        self.assertEqual(run.call_args.args[0], ['token-quota', '--json', '--detailed-reset-timing', '--config',
                         str(self.root / 'codex-quota/accounts.json')])
        self.assertEqual([(q['name'], q['origins'], q['left']) for q in quotas],
                         [('Listed', ['local'], 75), ('Claude', ['local'], 65)])
        self.assertEqual(quotas[1]['id'], 'claude:active')
        self.assertEqual(quotas[0]['reset_detail'], '2 Minutes')

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
        with patch.object(server, 'TIMER_PROMPTS', []), patch.object(server, 'REMOTE_QUOTAS', []), \
                patch.object(server, 'LOCAL_QUOTAS', []):
            server.record_timer_prompts([prompt, prompt])
            self.assertEqual(server.state_payload(None)['timerPrompts'],
                             [{'id': 'a', 'name': 'Listed', 'provider': 'codex', 'fact': 'A timer fact'}])
            server.record_timer_prompts([])
            self.assertEqual(len(server.state_payload(None)['timerPrompts']), 1)

    def test_quota_cache_survives_agent_polling_outage(self):
        cached = [{'id': 'a', 'name': 'Listed', 'origins': ['remote'], 'left': 50}]
        with patch.object(server, 'REMOTE_QUOTAS', cached), patch.object(server, 'LOCAL_QUOTAS', []), \
                patch.object(server, 'REMOTE_SEEN', 0):
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
