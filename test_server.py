import base64
import json
import io
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
            {'id': 'work', 'provider': 'codex', 'period': 'weekly', 'left': 60, 'origins': ['local']},
        ]}

        agents, quotas = server.remote_snapshot('mage-tower', payload)

        self.assertEqual(agents, [])
        self.assertEqual(quotas, [{
            'id': 'claude:active', 'provider': 'claude', 'period': 'weekly', 'left': 30, 'origins': ['remote'],
        }, {
            'id': 'work', 'provider': 'codex', 'period': 'weekly', 'left': 60, 'origins': ['remote'],
        }])

    def test_usage_refresh_has_a_larger_remote_timeout(self):
        proc = MagicMock(stdout=b'{"agents": [], "quotas": []}')
        with patch.object(server.subprocess, 'run', return_value=proc) as run:
            server.scan_remote('mage-tower', True)

        self.assertEqual(run.call_args.kwargs['timeout'], 90)


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
        reader = patch.object(server, 'read_claude', None)
        reader.start()
        self.addCleanup(reader.stop)
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

    def collect(self, homes):
        return {'accounts': [{'name': name, 'weeklyUsedPercent': 25, 'weeklyResetsAt': 123,
                              'availableResets': 2, 'error': None} for name in homes]}

    def test_listed_active_account_is_not_duplicated(self):
        with patch.object(server, 'collect', side_effect=self.collect):
            qs = server.account_quotas(True)
        self.assertEqual([(q['name'], q['origins'], q['left']) for q in qs], [('Listed', ['local'], 75)])

    def test_added_account_appears_on_next_refresh(self):
        with patch.object(server, 'collect', side_effect=self.collect):
            before = server.account_quotas(True)
            (self.root / 'codex-quota/accounts.json').write_text(
                json.dumps({'Listed': '../a', 'Additional': '../b'}))
            after = server.account_quotas(True)
        self.assertEqual(len(before), 1)
        self.assertEqual([(q['name'], q['origins'], q['left']) for q in after],
                         [('Listed', ['local'], 75), ('Additional', [], 75)])
        self.assertEqual(after[0]['id'], before[0]['id'])
        self.assertNotEqual(after[0]['id'], after[1]['id'])

    def test_listed_accounts_match_the_cli_account_list(self):
        with patch.dict(server.os.environ, {'CODEX_HOME': str(self.b)}), patch.object(server, 'collect', side_effect=self.collect):
            qs = server.account_quotas(True)
            local = server.account_quotas(False)
        self.assertEqual([(q['name'], q['origins']) for q in qs], [('Listed', [])])
        self.assertEqual([(q['name'], q['origins']) for q in local], [('In use', ['local'])])

    def test_listed_home_with_missing_auth_is_not_duplicated(self):
        (self.a / 'auth.json').unlink()
        with patch.object(server, 'collect', side_effect=self.collect):
            qs = server.account_quotas(True)
        self.assertEqual([(q['name'], q['origins']) for q in qs], [('Listed', ['local'])])

    def test_missing_config_has_no_listed_accounts(self):
        (self.root / 'codex-quota/accounts.json').unlink()
        with patch.object(server, 'collect', side_effect=self.collect):
            qs = server.account_quotas(True)
        self.assertEqual(qs, [])

    def test_quota_cache_survives_agent_polling_outage(self):
        cached = [{'id': 'a', 'name': 'Listed', 'origins': ['remote'], 'left': 50}]
        with patch.object(server, 'REMOTE_QUOTAS', cached), patch.object(server, 'LOCAL_QUOTAS', []), patch.object(server, 'REMOTE_SEEN', 0):
            self.assertEqual(server.state_payload(None)['quotas'], cached)

    def test_claude_is_collected_with_the_listed_accounts(self):
        reading = {'name': 'Claude', 'provider': 'claude', 'weeklyUsedPercent': 35,
                   'weeklyResetsAt': 123, 'availableResets': None, 'error': None}
        with patch.object(server, 'collect', side_effect=self.collect), \
                patch.object(server, 'read_claude', return_value=reading) as reader:
            quotas = server.account_quotas(True)
            local = server.account_quotas(False)
        reader.assert_called_once_with()
        self.assertEqual(len(local), 1)
        self.assertEqual(quotas[-1], {'id': 'claude:active', 'name': 'Claude', 'provider': 'claude',
                                    'period': 'weekly', 'origins': ['local'], 'left': 65,
                                    'resets_at': 123, 'resets_left': None, 'error': None})

    def test_claude_and_fable_get_separate_containers(self):
        readings = [{'id': name, 'name': name, 'provider': 'claude', 'weeklyUsedPercent': used,
                     'weeklyResetsAt': reset, 'availableResets': None, 'error': None}
                    for name, used, reset in [('Claude', 35, 123), ('Fable', 60, 456)]]
        with patch.object(server, 'collect', side_effect=self.collect), \
                patch.object(server, 'read_claude', return_value=readings):
            quotas = server.account_quotas(True)
        _, remote = server.remote_snapshot('mage-tower', {'quotas': quotas})
        merged = server.merge_quotas(remote, quotas)
        self.assertEqual([(q['id'], q['name'], q['left'], q['resets_at']) for q in merged[1:]],
                         [('claude:active', 'Claude', 65, 123), ('claude:Fable', 'Fable', 40, 456)])
        self.assertTrue(all(q['origins'] == ['remote', 'local'] for q in merged))

    def test_cli_and_dashboard_share_claude_cache_and_rate_limit_backoff(self):
        # Exercise the real token-quota reader; only credentials/network are mocked.
        import claude_quota
        import codex_quota
        from urllib.error import HTTPError
        with patch.dict(server.os.environ, {'XDG_CACHE_HOME': str(self.root / 'cache')}), \
                patch.object(server, 'collect', side_effect=self.collect), \
                patch.object(server, 'read_claude', claude_quota.read_claude), \
                patch.object(claude_quota, 'access_token', return_value='test-token'), \
                patch.object(claude_quota.time, 'time', return_value=1000):
            data = {'seven_day': {'utilization': 35, 'resets_at': None}, 'limits': [
                {'kind': 'weekly_scoped', 'percent': 60,
                 'scope': {'model': {'display_name': 'Fable'}}},
            ]}
            with patch.object(claude_quota, 'urlopen', return_value=io.StringIO(json.dumps(data))) as fetch:
                codex_quota.read_claude()
                quotas = server.account_quotas(True)
            fetch.assert_called_once()
            self.assertEqual([(q['name'], q['left']) for q in quotas[-2:]], [('Claude', 65), ('Fable', 40)])
            self.assertTrue(all(q['cached'] for q in quotas[-2:]))

            with patch.object(claude_quota.time, 'time', return_value=1300), \
                    patch.object(claude_quota, 'urlopen', side_effect=HTTPError('url', 429, 'limited', {}, None)) as fetch:
                quotas = server.account_quotas(True)
                codex_quota.read_claude()
                again = server.account_quotas(True)
            fetch.assert_called_once()
            self.assertEqual(quotas, again)
            _, remote = server.remote_snapshot('mage-tower', {'quotas': quotas})
            for q in remote[-2:]:
                self.assertTrue(q['stale'])
                self.assertEqual(q['updatedAt'], 1000)
                self.assertEqual(q['retryAt'], 1600)
                self.assertIn('cached reading', q['error'])
                self.assertIsNotNone(q['left'])

    def test_failed_account_is_still_displayed(self):
        reading = {'name': 'Listed', 'weeklyUsedPercent': None, 'weeklyResetsAt': None,
                   'availableResets': None, 'error': 'unavailable'}
        with patch.object(server, 'collect', return_value={'accounts': [reading]}):
            qs = server.account_quotas(True)
        self.assertIsNone(qs[0]['left'])
        self.assertEqual(qs[0]['error'], 'unavailable')

    def test_local_and_remote_account_merge_keeps_name_and_both_origins(self):
        remote = [{'id': 'a', 'name': 'Listed', 'origins': ['remote'], 'left': None, 'error': 'unavailable'}]
        local = [{'id': 'a', 'name': 'In use', 'origins': ['local'], 'left': 75, 'error': None},
                 {'id': 'b', 'name': 'In use', 'origins': ['local'], 'left': 50}]
        qs = server.merge_quotas(remote, local)
        self.assertEqual(len(qs), 2)
        self.assertEqual((qs[0]['name'], qs[0]['origins'], qs[0]['left']), ('Listed', ['remote', 'local'], 75))
        self.assertEqual(remote[0]['origins'], ['remote'])

    def test_unreadable_auth_does_not_match_another_account(self):
        (self.a / 'auth.json').write_text('{}')
        self.assertIsNone(server.account_id(self.a))


if __name__ == '__main__':
    unittest.main()
