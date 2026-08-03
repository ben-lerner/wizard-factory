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


if __name__ == '__main__':
    unittest.main()
