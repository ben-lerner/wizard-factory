import unittest
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

    def test_points_remote_open_at_the_host_we_can_reach(self):
        payload = {'agents': [{'id': 'a', 'open': {'host': 'local', 'tmux': 'claude'}},
                              {'id': 'b', 'open': 'not a dict'}]}

        agents = server.remote_agents('mage-tower', payload)

        self.assertEqual(agents[0]['open'], {'host': 'mage-tower', 'tmux': 'claude'})
        self.assertIsNone(agents[1]['open'])

    def test_extracts_only_codex_quota_for_remote_usage_probe(self):
        payload = {'agents': [], 'quotas': [
            {'provider': 'claude', 'period': 'weekly', 'left': 30},
            {'provider': 'codex', 'period': 'weekly', 'left': 60},
        ]}

        agents, quotas = server.remote_snapshot('mage-tower', payload)

        self.assertEqual(agents, [])
        self.assertEqual(quotas, [{
            'provider': 'codex', 'period': 'weekly', 'left': 60, 'origin': 'remote',
        }])

    def test_usage_failure_falls_back_to_fast_agent_scan(self):
        fresh = [{'provider': 'codex', 'period': 'weekly', 'left': 42, 'resets_left': 0}]
        cached = [{'provider': 'codex', 'period': 'weekly', 'left': 50, 'resets_left': 3}]
        with patch.object(server, 'scan_remote', side_effect=[TimeoutError, (['agent'], fresh)]) as scan, \
             patch.object(server, 'REMOTE_QUOTAS', cached):
            self.assertEqual(server.poll_remote('mage-tower', True), (['agent'], [{
                'provider': 'codex', 'period': 'weekly', 'left': 42, 'resets_left': 3,
            }]))
            self.assertEqual([c.args for c in scan.call_args_list], [('mage-tower', True), ('mage-tower',)])

    def test_usage_refresh_has_a_larger_remote_timeout(self):
        proc = MagicMock(stdout=b'{"agents": [], "quotas": []}')
        with patch.object(server.subprocess, 'run', return_value=proc) as run:
            server.scan_remote('mage-tower', True)

        self.assertEqual(run.call_args.kwargs['timeout'], 20)


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
    def test_normalizes_remaining_quota_and_optional_resets(self):
        q = server.quota('claude', 'weekly', {
            'utilization': 23, 'resets_at': '2026-08-11T08:00:00Z', 'resets_left': 3,
        })

        self.assertEqual(q, {'provider': 'claude', 'period': 'weekly', 'left': 77,
                             'resets_at': 1786435200.0, 'resets_left': 3})

    def test_picks_codex_weekly_window_by_duration(self):
        rate_limits = {
            'primary': {'used_percent': 25, 'window_minutes': 300, 'resets_at': 10},
            'secondary': {'used_percent': 40, 'window_minutes': 10080, 'resets_at': 20},
        }

        self.assertEqual(server.codex_quota(rate_limits), [{
            'provider': 'codex', 'period': 'weekly', 'left': 60,
            'resets_at': 20, 'resets_left': 0,
        }])

    def test_reads_codex_reset_credit_count(self):
        response = {'rateLimitResetCredits': {'availableCount': 1, 'credits': []}}

        self.assertEqual(server.reset_count(response), 1)

    def test_synchronous_refresh_primes_reset_credits_for_remote_snapshot(self):
        with patch.object(server, 'fetch_codex_resets', return_value=3), \
             patch.object(server, 'CODEX_RESETS', 0), \
             patch.object(server, 'CODEX_RESETS_TS', 0):
            self.assertTrue(server.refresh_codex_resets())

            self.assertEqual(server.CODEX_RESETS, 3)
            self.assertGreater(server.CODEX_RESETS_TS, 0)

    def test_failed_reset_refresh_is_reported_without_overwriting_cached_count(self):
        with patch.object(server, 'fetch_codex_resets', return_value=None), \
             patch.object(server, 'CODEX_RESETS', 4), \
             patch.object(server, 'CODEX_RESETS_TS', 0):
            self.assertFalse(server.refresh_codex_resets())

            self.assertEqual(server.CODEX_RESETS, 4)
            self.assertGreater(server.CODEX_RESETS_TS, 0)

    def test_fast_remote_scan_does_not_fetch_reset_credits(self):
        quota = {'provider': 'codex', 'period': 'weekly', 'left': 60,
                 'resets_at': 9999999999, 'resets_left': 0}
        with patch.object(server, 'CODEX_QUOTAS', [quota]), \
             patch.object(server, 'codex_resets', side_effect=AssertionError):
            self.assertEqual(server.codex_quotas(False), [quota])

    def test_reads_claude_fable_quota_with_weekly_reset_fallback(self):
        usage = {
            'seven_day': {'resets_at': '2026-08-11T08:00:00Z'},
            'limits': [{'percent': 25, 'resets_at': None,
                        'scope': {'model': {'display_name': 'Fable'}}}],
        }

        self.assertEqual(server.claude_fable(usage), {
            'provider': 'claude', 'period': 'fable', 'left': 75,
            'resets_at': 1786435200.0, 'resets_left': 0,
        })

    def test_rolls_expired_codex_quota_into_a_fresh_week(self):
        quotas = [{'provider': 'codex', 'period': 'weekly', 'left': 8,
                   'resets_at': 20, 'resets_left': 2}]

        self.assertEqual(server.advance_quotas(quotas, 21), [{
            'provider': 'codex', 'period': 'weekly', 'left': 100,
            'resets_at': 20 + 7 * 86400, 'resets_left': 0,
        }])

    def test_rolls_expired_five_hour_quota_into_a_fresh_window(self):
        quotas = [{'provider': 'claude', 'period': 'five_hour', 'left': 2,
                   'resets_at': 20, 'resets_left': 1}]

        self.assertEqual(server.advance_quotas(quotas, 21), [{
            'provider': 'claude', 'period': 'five_hour', 'left': 100,
            'resets_at': 20 + 5 * 3600, 'resets_left': 0,
        }])


if __name__ == '__main__':
    unittest.main()
