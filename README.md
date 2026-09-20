# 🧙 Wizard Factory

A retro 8-bit dashboard that shows every running coding agent in a shared tower.
Local sessions are pixel wizards, agents running remotely on `mage-tower` are demons,
and subagents are apprentices. They work at desks labeled with their task names,
and wait for you at the café with a fresh drink when their turn is done.

![demo](assets/demo.gif)

## Run

```sh
python3 server.py                  # → http://127.0.0.1:7777
python3 server.py --install-hooks  # one-time: instant "needs permission" alerts (see Hooks)
python3 server.py --demo           # fake wizards, for kicking the tires
python3 server.py --port N         # different port
```

Agent polling has no Python dependencies and uses the system `ssh` command.
Usage displays require `~/token-quota` and an authenticated Codex CLI on each
machine. Configure the accounts to display in
`~/.config/codex-quota/accounts.json` on `mage-tower` (or locally when remote
polling is disabled).

## How it works

The server tails local transcript files written to
`~/.claude/projects/<project>/<session>.jsonl` (and
`<session>/subagents/agent-*.jsonl` for subagents), keeping byte offsets per file
and re-reading the tail if a file is rewritten. It also polls the same paths on
`mage-tower` over SSH; remote agents are namespaced and displayed as demons. OpenAI Codex
CLI sessions are tracked the same way from `~/.codex/sessions/**/rollout-*.jsonl` —
they appear as hooded agents with a `codex` chip, and one-shot `codex exec` runs (including
codex review subagents) finish and leave instead of waiting for input. From the
last few events it infers a status for each agent:

| status     | meaning                                   | where the wizard goes        |
|------------|-------------------------------------------|------------------------------|
| working    | a tool call is in flight                  | a personal task desk |
| thinking   | tool result landed / prompt being chewed  | task desk, `…` bubble        |
| responding | writing the final answer                  | task desk, quill bubble      |
| waiting    | turn ended, your move                     | café, fresh drink in hand    |
| attention  | needs permission (hooks mode only)        | petition board, red `!`      |
| idle       | waiting 15+ min                           | hearth armchairs, `Z`        |
| done       | subagent finished                         | celebrates, exits the door   |

Working wizards summon a desk and remain seated through tool calls, thinking, and
replies, including long-running commands and tests. The desk dissolves when they
leave to wait or finish. Labels use the session name set by `/rename`, falling back
to the task or project; hover over a wizard to read a longer label. Apprentices get
smaller desks in the nearest available space to their parent. Explicit questions
send wizards to the café while they wait for an answer.

Appearance and name are deterministic per agent id (seeded hats, beards, robes,
staffs, and cafe order), so the same session keeps the same wizard
across reloads. Long quiet stretches are occasionally interrupted by a brief
tower-wide ray battle; victims burst through faction-colored shock sigils, then
magically reconstitute amid orbiting motes and reforming circles before returning
to work, followed by a three-to-five-minute cooldown. Agents
of the opposite rank help their faction in a duel, with only one apprentice
joining the fray at a time; stronger defending support
reflects the blast at the aggressor, while a tie still hits the target. Agents
rarely challenge Earl Grey; those who do may bring one supporter, but he roasts each
assailant into soot in succession. Biggles and Lucipurr bypass duels and can
blast anyone, including Earl Grey, but are themselves immune. Earl Grey, the
dragon barista, brews cafe orders with fire and pours milk for milk drinks.
The frontend polls `/api/state` every 1.5s.

The laboratory's usage bottles show all configured Codex accounts, plus any active
account missing from the list. Blue `LOC` and red `REM` labels mark the accounts
in use locally and remotely; purple `L/R` marks an account used on both machines.
Hover over a numbered bottle for its account name, remaining quota, and reset credits.
Reset times above 24 hours round to the nearest day. Missing usage or reset data
shows a floating ∅ inside the bottle. Usage refreshes once a minute independently
of agent polling; these checks never send prompts or redeem reset credits.

## The journal: what was said

Clicking a wizard opens its journal. **Counsel & missives** is the exchange itself — your prompts
and the agent's replies, oldest first, scrolling like the window you were last looking at — read out
of the same transcripts as everything else, including agents running over SSH.

## Hooks: instant "needs your blessing"

Polling can't always distinguish a long-running Bash spell from a permission
prompt. Installing the hooks fixes that: the wizard runs to the petition board
with a red `!` the moment a session asks for approval, and arrivals/departures/turn
ends land instantly instead of on the next poll.

```sh
python3 server.py --install-hooks    # merges into ~/.claude/settings.json
python3 server.py --uninstall-hooks  # removes exactly what install added
```

This registers `Notification`, `Stop`, `UserPromptSubmit`, `SessionStart`, and
`SessionEnd` hooks. Safety properties: existing hooks and settings are left
untouched (verified round-trip), the write is atomic, a backup is kept at
`~/.claude/settings.json.wizard-bak`, install is idempotent, and each hook is a
fire-and-forget `curl` to `127.0.0.1:7777/hook` that exits 0 in under a second
even when the server isn't running. Hooks are captured at session startup, so
they only take effect for sessions started after installing —
already-running sessions keep working via polling alone.

## Notes

- Binds to 127.0.0.1 only.
- Remote polling uses non-interactive SSH to `mage-tower`; pass
  `--remote-host ''` to disable it or `--remote-host HOST` to use another machine.
- Sessions whose transcript hasn't been touched for 3h are ignored; waiting
  wizards leave after 45 min, finished apprentices after ~2 min.
- Desktop-app (bridge) sessions flush transcript content lazily, so "last sign"
  uses file mtime and statuses may lag a little for those.
- `python3 server.py --debug-scan` prints the inferred agent list as JSON.
- The cat is named Biggles. He is not configurable.
  [Editor's note: I didn't ask for a cat, this is completely agentic humour.]
