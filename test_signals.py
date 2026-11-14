import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import server
from test_server import codex_rollout, item

NOW = server.epoch('2026-11-14T10:10:00Z')
SEALED = 'gAAAAABq-EAnGJQOA6jqXSZ4kq9mR0xX2b6fTvaYH7cL1pWnE3zU8dKs='


def stamp(i):
    return f'2026-11-14T10:{i // 60:02d}:{i % 60:02d}Z'


def claude(path, rows, start=0):
    fs = server.FileState(Path(path))
    for i, row in enumerate(rows):
        fs.feed({'timestamp': stamp(start + i), **row})
    return fs


def tool(name, **inp):
    return {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'name': name, 'input': inp}]}}


def result(**extra):
    return {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'content': 'ok'}]}, **extra}


class ShellActTest(unittest.TestCase):
    def test_commands_are_judged_by_their_most_significant_step(self):
        cases = {
            'sed -n 1,80p server.py': 'read', 'rg -n "a|b" static': 'search', 'git diff --stat': 'git',
            'cd /src/app && FOO=1 uv run --with x python -m pytest -q 2>&1 | tail -5': 'test',
            'git add -A && git commit -m "x" && git push': 'push', 'gh pr create --fill': 'pr',
            'until gh pr checks 12; do sleep 30; done': 'wait', 'gh pr checks 12': 'ci', 'gt submit --stack': 'graphite',
            'git checkout -b ben/fix': 'tree', 'git pull --rebase': 'tree', 'gt sync': 'tree', 'jj git push': 'jujutsu',
            'npm run build': 'build', 'npm run dev': 'serve', 'cargo clippy': 'lint', 'make test': 'test',
            "python3 - <<'EOF'\ngit push\nEOF": 'script', 'aws s3 ls': 'cloud', 'curl -s url | jq .': 'web',
            'ps aux | grep python': 'proc', 'echo "git push later"': None, "bash -lc 'pytest -q'": 'test',
            'tail -f server.log': 'wait', 'sleep 1 && cat x': 'read', 'mkdir -p out': 'files',
        }
        self.assertEqual({cmd: server.shell_act(cmd) for cmd in cases}, cases)


class ClaudeSignalsTest(unittest.TestCase):
    def test_reads_context_effort_cost_prs_login_and_compactions(self):
        fs = claude('/p/proj/s.jsonl', [
            {'type': 'session-owner', 'accountUuid': 'acct', 'organizationUuid': 'org'},
            {'type': 'assistant', 'effort': 'max', 'attributionSkill': 'pr-watch', 'message': {
                'model': 'claude-opus-5-5', 'usage': {'input_tokens': 10, 'cache_read_input_tokens': 300_000,
                                                      'cache_creation_input_tokens': 90}, 'content': []}},
            {'type': 'pr-link', 'prUrl': 'https://github.com/arcana/tower/pull/12', 'prRepository': 'arcana/tower'},
            {'type': 'cost-state', 'totalCostUSD': 4.1, 'totalLinesAdded': 312, 'totalLinesRemoved': 88},
            {'type': 'system', 'subtype': 'compact_boundary', 'compactMetadata': {'preTokens': 950_000, 'postTokens': 60_000}},
        ])
        a = fs.payload(0)
        self.assertEqual((a['ctx'], a['effort'], a['skill'], a['cost']['usd']), ([300_100, server.CLAUDE_WINDOW], 'max', 'pr-watch', 4.1))
        self.assertEqual(a['prs'], [{'repo': 'arcana/tower', 'number': 12}])
        self.assertEqual(a['login'], server.login_key('acct', 'org'))
        self.assertEqual((a['compactions'], a['history'][-1]['text']), (1, 'Compacted its memory: 950K → 60K tokens'))

    def test_scans_count_each_line_once_even_when_metadata_runs_ahead_of_content(self):
        # Claude stamps api-request lines after the content written below them; a re-read tail replays everything.
        lines = [{'type': 'api-request', 'timestamp': stamp(30)},
                 {'type': 'user', 'turnOrigin': 'human', 'timestamp': stamp(29), 'message': {'content': 'find foo'}},
                 {'timestamp': stamp(31), **tool('Bash', command='rg foo')}, {'timestamp': stamp(32), **result()},
                 {'type': 'system', 'subtype': 'turn_duration', 'timestamp': stamp(33)}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'proj/s.jsonl'
            path.parent.mkdir()
            path.write_text(''.join(json.dumps(line) + '\n' for line in lines))
            os.utime(path, (NOW, NOW))
            with patch.object(server, 'PROJECTS', Path(directory)), patch.object(server, 'CODEX', Path(directory) / 'none'), \
                    patch.object(server, 'FILES', {}):
                server.scan_once(NOW)
                fs = server.FILES[path]
                server.retail(fs, path.stat().st_size)
                server.scan_once(NOW)
        self.assertEqual((fs.feats['search'], fs.turns, [kind for _, kind in fs.beats]),
                         (1, 1, ['user_text', 'human', 'tool_use', 'tool_result', 'turn_end']))

    def test_missives_resolve_to_subagents_sessions_names_and_the_tower(self):
        parent = claude('/p/proj/main.jsonl', [
            {'type': 'user', 'cwd': '/src', 'message': {'content': 'hunt the bug'}},
            tool('SendMessage', to='a1b2c3', recipient_kind='agent', summary='check auth'),
            tool('SendMessage', to='uds:/tmp/cc-socks/9.sock', recipient_kind='session', summary='your turn'),
            tool('SendMessage', to='espresso-51 [edb6a3]', recipient_kind='name', summary='rebase please'),
            {'type': 'user', 'isMeta': True, 'turnOrigin': 'peer', 'origin': {'kind': 'peer', 'from': 'wizard-factory'},
             'message': {'content': 'Another Claude session sent a message:\n<peer-message>\ncontinue\n</peer-message>\n\n'
                                    'This came from another Claude session — not typed by your user.'}},
        ])
        child = claude('/p/proj/main/subagents/agent-a1b2c3.jsonl', [{'type': 'user', 'message': {'content': 'check auth'}}])
        peer = claude('/p/proj/peer.jsonl', [{'type': 'user', 'message': {'content': 'other work'}}])
        named = claude('/p/proj/named.jsonl', [{'type': 'user', 'message': {'content': 'espresso work'}}])
        states = [parent, child, peer, named]
        sessions = [{'messagingSocketPath': '/tmp/cc-socks/9.sock', 'sessionId': 'peer'}, {'name': 'espresso-51', 'sessionId': 'named'}]
        with patch.object(server, 'CLAUDE_SESSIONS', sessions):
            ags = server.link_agents([fs.payload(0) for fs in states], states, NOW)
        self.assertEqual([m['to'] for m in ags[0]['missives']], ['agent-a1b2c3', 'peer', 'named'])
        self.assertEqual([(m['from'], m['text']) for m in ags[0]['inbox']], [('tower', 'continue')])

    def test_subagent_messages_to_main_reach_their_parent(self):
        parent = claude('/p/proj/main.jsonl', [
            {'type': 'user', 'message': {'content': 'hunt the bug'}},
            {'type': 'user', 'isMeta': True, 'turnOrigin': 'peer', 'origin': {'kind': 'peer', 'from': 'a1b2c3'},
             'message': {'content': 'Another Claude session sent a message:\nfound it'}}])
        child = claude('/p/proj/main/subagents/agent-a1b2c3.jsonl', [
            {'type': 'user', 'message': {'content': 'check auth'}},
            tool('SendMessage', to='main', recipient_kind='main', summary='found it')])
        states = [parent, child]
        ags = server.link_agents([fs.payload(0) for fs in states], states, NOW)
        self.assertEqual(([m['to'] for m in ags[1]['missives']], ags[0]['inbox']), ([parent.id], []))

    def test_shared_files_clash_except_between_parent_and_child(self):
        edit = lambda path: [tool('Edit', file_path=path, old_string='a', new_string='b'), result()]
        a = claude('/p/proj/a.jsonl', [{'type': 'user', 'cwd': '/src', 'message': {'content': 'x'}}, *edit('app.py')])
        b = claude('/p/proj/b.jsonl', [{'type': 'user', 'cwd': '/src', 'message': {'content': 'y'}},
                                       tool('Bash', command='sed -i s/a/b/ app.py'),
                                       result(toolUseResult={'bashEditDiff': {'changedFiles': ['/src/app.py']}})])
        kid = claude('/p/proj/a/subagents/agent-k.jsonl', [{'type': 'user', 'cwd': '/src', 'message': {'content': 'z'}}, *edit('/src/app.py')])
        states = [a, b, kid]
        ags = server.link_agents([fs.payload(0) for fs in states], states, NOW)
        self.assertEqual({x['id']: sorted(c['with'] for c in x['clash']) for x in ags},
                         {'a': ['b'], 'b': ['a', 'agent-k'], 'agent-k': ['b']})
        self.assertEqual(ags[0]['clash'][0]['paths'], ['/src/app.py'])

    def test_malformed_values_stay_out_of_cross_agent_lookups(self):
        fs = claude('/p/proj/s.jsonl', [{'type': 'agent-name', 'agentName': {'not': 'a name'}},
                                        {'type': 'user', 'cwd': {'x': 1}, 'gitBranch': ['b'], 'message': {'content': 'hi'}},
                                        {'type': 'assistant', 'effort': 3, 'message': {'model': [], 'content': []}}])
        self.assertEqual((fs.agent_name, fs.effort, fs.cwd, fs.branch, fs.model), (None, None, None, None, None))
        self.assertEqual(server.link_agents([fs.payload(0)], [fs], NOW)[0]['project'], '?')


class CodexSignalsTest(unittest.TestCase):
    def test_subagents_are_titled_by_task_and_encrypted_messages_stay_sealed(self):
        root = codex_rollout('/s/2026/11/14/rollout-2026-11-14T10-00-00-root.jsonl', [
            ('session_meta', {'id': 'root', 'cwd': '/src'}),
            ('turn_context', {'model': 'gpt-6', 'effort': 'xhigh'}),
            ('response_item', {'type': 'function_call', 'name': 'spawn_agent',
                               'arguments': json.dumps({'task_name': 'audit_cache', 'message': SEALED})}),
            ('event_msg', {'type': 'token_count', 'info': {'last_token_usage': {'input_tokens': 120_000, 'output_tokens': 800},
                                                           'model_context_window': 258_400}}),
        ])
        kid = codex_rollout('/s/2026/11/14/rollout-2026-11-14T10-00-00-kid.jsonl', [
            ('session_meta', {'id': 'kid', 'cwd': '/src', 'parent_thread_id': 'root', 'agent_path': '/root/audit_cache',
                              'source': {'subagent': {'thread_spawn': {}}}}),
            ('response_item', {'type': 'function_call', 'name': 'send_message',
                               'arguments': json.dumps({'target': '/root', 'message': SEALED})}),
            ('response_item', {'type': 'custom_tool_call', 'name': 'apply_patch',
                               'input': '*** Begin Patch\n*** Update File: cache.py\n@@\n*** End Patch'}),
            item('FileChange', changes={'/src/keys.py': {'type': 'update'}}),
        ])
        states = [root, kid]
        ags = server.link_agents([fs.payload(0) for fs in states], states, NOW)
        self.assertEqual((ags[1]['quest'], ags[1]['title'], ags[0]['feats']['spawn']), (None, 'audit cache', 1))
        self.assertEqual([(m['to'], m['text']) for m in ags[1]['missives']], [('root', '')])
        self.assertEqual((ags[0]['ctx'], ags[0]['effort']), ([120_800, 258_400], 'xhigh'))
        self.assertEqual(sorted(kid.touched), ['/src/cache.py', '/src/keys.py'])

    def test_code_mode_cells_reveal_their_commands_patches_and_thread_messages(self):
        cell = ('const r = await tools.exec_command({cmd: "cd /src && python3 -m pytest -q 2>&1 | tail -5"});\n'
                'await tools.apply_patch("*** Begin Patch\\n*** Update File: app.py\\n*** End Patch");\n'
                'await tools.mcp__codex_tui__send_message_to_thread({threadId: "peer", prompt: "Rebase \\"main\\" first"});')
        fs = codex_rollout('/s/2026/11/14/rollout-2026-11-14T10-00-00-cell.jsonl', [
            ('session_meta', {'id': 'cell', 'cwd': '/src'}),
            ('response_item', {'type': 'custom_tool_call', 'name': 'exec', 'input': cell}),
        ])
        self.assertEqual((fs.tool, fs.detail, fs.act), ('exec', 'cd /src && python3 -m pytest -q 2>&1 | tail -5', 'test'))
        self.assertEqual(list(fs.touched), ['/src/app.py'])
        self.assertEqual([(m['to'], m['text']) for m in fs.missives], [('peer', 'Rebase "main" first')])

    def test_forked_subagents_keep_their_own_lines_at_the_fork_instant(self):
        fs = server.FileState(Path('/s/2026/11/14/rollout-2026-11-14T10-00-00-fork.jsonl'))
        rows = [(0, 'session_meta', {'id': 'fork', 'forked_from_id': 'root', 'subagent_history_start_ordinal': 2,
                                     'source': {'subagent': {'thread_spawn': {}}}}),
                (1, 'turn_context', {'model': 'parent-model', 'effort': 'low'}),
                (2, 'turn_context', {'model': 'gpt-6', 'effort': 'max'})]
        for order, kind, payload in rows:
            fs.feed({'type': kind, 'ordinal': order, 'timestamp': stamp(0), 'payload': payload})
        self.assertEqual((fs.model, fs.effort), ('gpt-6', 'max'))

    def test_forked_subagents_skip_the_history_they_inherit(self):
        fs = server.FileState(Path('/s/2026/11/14/rollout-2026-11-14T10-00-00-fork.jsonl'))
        rows = [(0, 'session_meta', {'id': 'fork', 'cwd': '/src', 'forked_from_id': 'root', 'parent_thread_id': 'root',
                                     'source': {'subagent': {'thread_spawn': {}}}}),
                (0, 'response_item', {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': "the parent's prompt"}]}),
                (0, 'response_item', {'type': 'custom_tool_call', 'name': 'apply_patch', 'input': '*** Update File: parent.py'}),
                (5, 'response_item', {'type': 'custom_tool_call', 'name': 'apply_patch', 'input': '*** Update File: own.py'})]
        for seconds, kind, payload in rows:
            fs.feed({'type': kind, 'timestamp': stamp(seconds), 'payload': payload})
        self.assertEqual((fs.quest, list(fs.chat), list(fs.touched)), (None, [], ['/src/own.py']))


class AnnalsTest(unittest.TestCase):
    def test_chronicle_counts_busy_time_turns_prompts_and_reply_waits_once(self):
        beats = [(1000, 'user_text'), (1000, 'human'), (1010, 'tool_use'), (1070, 'tool_result'), (1080, 'assistant_text'),
                 (1081, 'turn_end'), (1681, 'user_text'), (1681, 'human'), (1700, 'assistant_text')]
        saved = {}
        with patch.object(server.time, 'localtime', return_value=server.time.gmtime(0)):
            self.assertTrue(server.fold_chronicle(saved, [('s', True, beats)], 2000))
            day = next(iter(saved['days'].values()))
            self.assertEqual((day['busy'], day['turns'], day['prompts'], day['sessions']), (99, 1, 2, ['s']))
            self.assertEqual(day['lat'][server.bisect.bisect(server.LAT_EDGES, 600)], 1)
            self.assertFalse(server.fold_chronicle(saved, [('s', True, beats)], 2001))
            # a session resumed days later re-reads the same tail without recounting it
            self.assertFalse(server.fold_chronicle(saved, [('s', True, beats)], 2001 + 5 * 86400))
            self.assertEqual(next(iter(saved['days'].values()))['turns'], 1)

    def test_reshelving_a_partially_reread_session_keeps_what_the_book_knew(self):
        old = {'id': 's', 'turns': 40, 'started': 100, 'prs': [{'repo': 'a/b', 'number': 1}], 'final': 'Done.', 'cost': {'usd': 9}}
        new = {'id': 's', 'turns': 3, 'started': 500, 'prs': [{'repo': 'a/b', 'number': 2}], 'final': '', 'cost': None, 'ended': 900}
        self.assertEqual(server.merge_book(old, new), {
            'id': 's', 'turns': 40, 'started': 100, 'prs': [{'repo': 'a/b', 'number': 1}, {'repo': 'a/b', 'number': 2}],
            'final': 'Done.', 'cost': {'usd': 9}, 'ended': 900})

    def test_lines_appended_after_a_truncation_count(self):
        turns = lambda *seconds: ''.join(json.dumps({'type': 'system', 'subtype': 'turn_duration', 'timestamp': stamp(i)}) + '\n'
                                         for i in seconds)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'proj/s.jsonl'
            path.parent.mkdir()
            with patch.object(server, 'PROJECTS', Path(directory)), patch.object(server, 'CODEX', Path(directory) / 'none'), \
                    patch.object(server, 'FILES', {}):
                for text, mode in ((turns(0, 1, 2, 3, 4), 'w'), (turns(0, 1), 'w'), (turns(5, 6), 'a')):  # rewritten shorter, then extended
                    with path.open(mode) as f:
                        f.write(text)
                    os.utime(path, (NOW, NOW))
                    server.scan_once(NOW)
                self.assertEqual(server.FILES[path].turns, 7)

    def test_books_carry_a_resume_command_for_the_right_machine(self):
        local = server.book({'id': 'abc', 'engine': 'claude', 'cwd': '/src/my app', 'chat': [{'role': 'agent', 'text': 'Done.'}]})
        remote = server.book({'id': 'mage-tower:t1', 'host': 'mage-tower', 'engine': 'codex', 'cwd': '/src'})
        self.assertEqual((local['resume'], local['final']), ("cd '/src/my app' && claude --resume abc", 'Done.'))
        self.assertEqual(remote['resume'], "ssh -t mage-tower 'cd /src && codex resume t1'")

    def test_status_band_marks_busy_waiting_and_idle_stretches(self):
        fs = server.FileState(Path('/p/proj/s.jsonl'))
        fs.tool = 'Bash'
        for ts, kind in [(0, 'user_text'), (10, 'tool_use'), (70, 'assistant_text')]:
            fs._mark(kind, ts + 10_000)
        self.assertEqual(fs.band(10_070 + server.IDLE_SEC + 60), [[10_000, 'b'], [10_070, 'w'], [10_070 + server.IDLE_SEC, 'i']])


class CiTest(unittest.TestCase):
    def test_summarizes_checks_and_merge_state(self):
        def view(*checks, state='OPEN'):
            payload = {'state': state, 'isDraft': False, 'reviewDecision': 'APPROVED', 'statusCheckRollup': list(checks)}
            return MagicMock(returncode=0, stdout=json.dumps(payload))
        cases = [(view({'status': 'COMPLETED', 'conclusion': 'SUCCESS'}), 'passing'),
                 (view({'status': 'IN_PROGRESS', 'conclusion': ''}, {'state': 'SUCCESS'}), 'pending'),
                 (view({'status': 'COMPLETED', 'conclusion': 'FAILURE'}, {'status': 'QUEUED'}), 'failing'),
                 (view(state='MERGED'), 'merged'), (view(), 'none')]
        for proc, expected in cases:
            with self.subTest(expected), patch.object(server.subprocess, 'run', return_value=proc) as run:
                self.assertEqual(server.read_ci('arcana/tower#12')['state'], expected)
        self.assertEqual(run.call_args.args[0][:5], ['gh', 'pr', 'view', '12', '--repo'])


if __name__ == '__main__':
    unittest.main()
