import unittest

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
