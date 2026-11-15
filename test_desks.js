// Run with node --test test_desks.js. Exercise the real scene without a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function scene(random = Math.random) {
  const calls = [];
  const ctx = new Proxy({ getImageData: () => ({ data: [] }) }, { get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]) });
  const element = { getContext: () => ctx, toDataURL: () => '', addEventListener() {}, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 544 }), clientLeft: 0, clientTop: 0, offsetWidth: 200, offsetHeight: 80 };
  const sandbox = { console, Math: Object.assign(Object.create(Math), { random }), ResizeObserver: class { observe() {} }, document: { querySelector: () => element, createElement: () => ({ ...element }) }, window: { addEventListener() {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('static/sprites.js', 'utf8'), sandbox);
  sandbox.SP = sandbox.window.SP;
  vm.runInContext(fs.readFileSync('static/go-games.js', 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync('static/magic.js', 'utf8'), sandbox);
  sandbox.MAGIC = sandbox.window.MAGIC;
  for (const name of ['drawText', 'drawEmote']) {
    const draw = sandbox.SP[name];
    sandbox.SP[name] = (...args) => { calls.push([name, ...args.slice(1)]); draw(...args); };
  }
  const source = fs.readFileSync('static/game.js', 'utf8').split('  // ---------- logo ----------')[0];
  vm.runInContext(source + 'window.test = { reconcile, update, wizards, desks, deskSpace, separateActors, draw, drawWorkDesk, drawTaskLabel, drawUsageProbes, showUsageTip, showResourceTip, RESOURCE_BALLS, ballReading, pickAt, usageProbe, castSpell, castRay, updateBattle, updateSpells, drawGlowingEyes, cloudAnchor, SPELLS, PARTS, COURT, TABLES, startGame, updateRally, rallyPosition, drawRally, drawCourt, updateTableGames, updateBoardGame, drawTableGame, playGo, gameName, MTG, updateMagic, updateMagicCards, drawMagic, drawMagicFront, magicTipHTML, magicEvent, statusLine, callJudge, BREW, updateBrew, RITUALS, SIGIL_EVENTS, SIGIL_LINKS, SUMMON_CIRCLE, CAULDRON_SIGIL, sigilEvent, sigilLink, drawFloorSigils, cat, demonCat, catThink, canUseCat, updateDemonCat, finishDragonTravel, sigilGust, MIMIC, HAUNTED_TODOS, startMimic, updateMimic, spawnHauntedTodo, updateHauntedTodos, startDoorStandoff, standoffMove, getDoorStandoff: () => doorStandoff, blocked, route, dragon, dragonAtBar, shrinkLab, sortAgents, launchMissives, BIRDS, statusLine, emoteFor, earned, drawStrays, layout: () => ({ labExtra, labDown, labSteps, S }), setData: data => { lastData = data; } }; })();', sandbox);
  return { ...sandbox.window.test, calls, element, SP: sandbox.SP, MAGIC: sandbox.MAGIC, ctx };
}
const agent = (id, status = 'working', parent = null) => ({ id, status, parent, kind: parent ? 'sub' : 'main', title: 'Fix wizard desks', tool: 'Bash', detail: 'npm test' });
test('cauldron sigil has reserved floor space and draws beneath its pot', () => {
  const s = scene(), space = s.CAULDRON_SIGIL.space;
  s.reconcile({ agents: Array.from({ length: 12 }, (_, i) => agent(`cauldron-${i}`)) });
  for (const d of s.desks) {
    const b = s.deskSpace(d.x, d.y, d.w);
    assert.ok(b.x >= space.x + space.w || b.x + b.w <= space.x || b.y >= space.y + space.h || b.y + b.h <= space.y);
  }
  const order = [], floor = s.SP.PR.floorSigil, pot = s.SP.PR.cauldron;
  s.SP.PR.floorSigil = (...args) => { order.push(['sigil', ...args.slice(1, 4)]); floor(...args); };
  s.SP.PR.cauldron = (...args) => { order.push(['pot']); pot(...args); };
  s.calls.length = 0; s.draw(1);
  assert.deepEqual(order[0], ['sigil', 72, 176, 40]);
  assert.ok(order.findIndex(c => c[0] === 'pot') > 0);
  assert.ok(!s.calls.some(c => c[0] === 'clip' && c[1] === 'evenodd'));
});
test('personal sigils retain identity and react to observed tool activity once', () => {
  const s = scene(), a = { ...agent('sigil-tools'), tool: 'Read', detail: 'book.py' };
  s.reconcile({ agents: [a] });
  const w = s.wizards.get(a.id), seed = w.sigil.seed, charge = w.sigil.charge;
  s.reconcile({ agents: [a] });
  assert.equal(w.sigil.charge, charge);
  for (const [tool, mode] of [['Read', 'read'], ['Edit', 'weave'], ['Bash', 'run']]) {
    s.reconcile({ agents: [{ ...a, tool, title: 'A renamed quest' }] });
    assert.equal(w.sigil.mode, mode);
    assert.equal(w.sigil.seed, seed);
  }
  const before = w.sigil.charge;
  const next = { ...a, tool: 'Bash', history: [{ ts: 100, kind: 'tool_result', tool: 'Bash', text: 'Tests finished' }] };
  s.reconcile({ agents: [next] }); s.reconcile({ agents: [next] });
  assert.equal(w.sigil.charge, before + 1);
});
test('questions leave an open sigil without a completion ceremony', () => {
  const s = scene(), a = agent('sigil-question');
  s.reconcile({ agents: [a] });
  const w = s.wizards.get(a.id);
  assert.ok(w.desk);
  s.reconcile({ agents: [{ ...a, tool: 'request_user_input' }] });
  assert.equal(w.station, 'cafe');
  assert.equal(w.desk, null);
  assert.equal(w.sigil.mode, 'ask');
  assert.equal(s.RITUALS.length, 0);
  [w.x, w.y] = w.home; w.path = []; w.walk = false;
  const modes = [];
  s.SP.PR.workSigil = (...args) => modes.push(args[6]);
  s.drawFloorSigils(1);
  assert.ok(modes.includes('ask'));
  s.reconcile({ agents: [{ ...a, tool: 'request_user_input', status: 'responding' }] });
  s.reconcile({ agents: [{ ...a, tool: 'request_user_input', status: 'waiting' }] });
  assert.notEqual(w.sigil.mode, 'ask');
  assert.equal(s.RITUALS.length, 1);
});
test('namespaced asynchronous question tools also open a waiting sigil', () => {
  const s = scene(), a = agent('async-question');
  s.reconcile({ agents: [a] });
  s.reconcile({ agents: [{ ...a, tool: 'functions.request_user_input_async' }] });
  const w = s.wizards.get(a.id);
  assert.equal(w.sigil.mode, 'ask');
  assert.equal(w.station, 'cafe');
});
test('new apprentices materialize at the circle before traveling to their desks', () => {
  const s = scene(), parent = agent('summoner'), child = agent('summoned', 'working', parent.id);
  s.reconcile({ agents: [parent] });
  assert.equal(s.SIGIL_EVENTS.length, 0);
  s.reconcile({ agents: [parent, child] });
  const w = s.wizards.get(child.id), start = [w.x, w.y], until = w.summon.until;
  w.r = () => 1;
  assert.ok(Math.hypot(w.x - 430, w.y - 220) < 10);
  assert.equal(s.SIGIL_LINKS.length, 1);
  s.update(.1, until - .2);
  assert.deepEqual([w.x, w.y], start);
  assert.equal(w.desk.elapsed, 0);
  assert.ok(w.alpha > 0 && w.alpha < 1);
  s.update(.1, until + .1);
  assert.equal(w.summon, null);
  assert.ok(w.path.length);
  assert.equal(s.SIGIL_LINKS.length, 2);
});
test('desk relayout and replacement preserve a wizard still materializing', () => {
  const s = scene(), locals = Array.from({ length: 6 }, (_, i) => agent(`local-${i + 1}`));
  const a = { ...agent('relayout-summon'), origin: 'remote', title: 'Short title' };
  s.reconcile({ agents: locals }); s.reconcile({ agents: [...locals, a] });
  const w = s.wizards.get(a.id), start = [w.x, w.y], steps = s.layout().labSteps, until = w.summon.until;
  const renamed = { ...a, title: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen' };
  s.reconcile({ agents: [...locals, renamed] });
  assert.ok(s.layout().labSteps > steps);
  assert.deepEqual([w.x, w.y], start);
  w.desk.x = 220; w.desk.y = 70; w.home = [220, 70]; w.r = () => 0;
  const replaced = w.desk;
  s.reconcile({ agents: [...locals, renamed] });
  assert.notEqual(w.desk, replaced);
  assert.deepEqual([w.x, w.y], start);
  assert.equal(w.summon.until, until);
  assert.equal(w.path.length, 0);
  s.update(.1, until + .1);
  assert.equal(w.summon, null);
});
test('circle arrivals do not also cast an entrance teleport at their desk', () => {
  const s = scene(), parent = agent('portal-parent');
  const id = Array.from({ length: 100 }, (_, i) => `portal-child-${i}`)
    .find(id => s.SP.rng(s.SP.hash(id) ^ 0xbeef)() < .05);
  assert.ok(id);
  s.reconcile({ agents: [parent] });
  s.reconcile({ agents: [parent, agent(id, 'working', parent.id)] });
  assert.ok(s.wizards.get(id).summon);
  assert.equal(s.SPELLS.filter(s => s.kind === 'teleport').length, 0);
  assert.equal(s.PARTS.length, 0);
});
test('remote arrivals ignite the circle and interrupted summons can leave', () => {
  const s = scene(), a = { ...agent('infernal-arrival'), origin: 'remote' };
  s.reconcile({ agents: [] }); s.reconcile({ agents: [a] });
  const w = s.wizards.get(a.id);
  assert.equal(s.SIGIL_EVENTS.at(-1).demon, true);
  assert.ok(w.summon);
  s.reconcile({ agents: [] }); s.update(.1, .5);
  assert.equal(w.summon, null);
  assert.ok(w.leaving);
});
test('a simultaneous apprentice arrival does not extinguish a demon portal', () => {
  const s = scene(), parent = agent('mixed-parent');
  s.reconcile({ agents: [parent] });
  s.reconcile({ agents: [parent, { ...agent('mixed-demon'), origin: 'remote' }, agent('mixed-child', 'working', parent.id)] });
  let portal;
  s.SP.PR.circle = (...args) => { portal = args[5]; };
  s.drawFloorSigils(1);
  assert.equal(portal.demon, true);
});
test('apprentice results pulse back once and all short-lived sigils expire', () => {
  const s = scene(), parent = agent('result-parent'), child = agent('result-child', 'working', parent.id);
  s.reconcile({ agents: [parent, child] });
  assert.equal(s.SIGIL_EVENTS.length, 0);
  s.reconcile({ agents: [parent, { ...child, status: 'done' }] });
  s.reconcile({ agents: [parent, { ...child, status: 'done' }] });
  assert.equal(s.SIGIL_LINKS.length, 1);
  assert.equal(s.SIGIL_LINKS[0].returning, true);
  assert.equal(s.RITUALS[0].sigilSeed, s.wizards.get(child.id).sigil.seed);
  s.update(.1, 4);
  assert.equal(s.SIGIL_LINKS.length, 0);
  assert.equal(s.RITUALS.length, 0);
});
test('Biggles sits in the circle and accidentally summons Lucipurr', () => {
  const s = scene();
  s.SUMMON_CIRCLE.nextCat = 0; s.demonCat.summonAt = 0;
  s.catThink(30);
  assert.equal(s.cat.dest, 'sigil');
  assert.equal(s.canUseCat(), false);
  s.cat.path = []; s.cat.x = 430; s.cat.y = 220;
  s.update(.1, 30.1);
  assert.equal(s.cat.state, 'sit');
  assert.equal(s.demonCat.active, false);
  s.updateDemonCat(.1, 32);
  assert.equal(s.demonCat.active, true);
  assert.equal(s.SIGIL_EVENTS.at(-1).demon, true);
  s.updateDemonCat(.1, 33.5);
  assert.ok(s.demonCat.path.length);
});
test('Earl Grey lands once and disturbs nearby sigils briefly', () => {
  const s = scene();
  s.dragon.path = []; s.dragon.dest = 'bar'; s.dragon.mode = 'fly';
  s.finishDragonTravel(10); s.finishDragonTravel(10.1);
  assert.equal(s.SIGIL_EVENTS.length, 1);
  assert.equal(s.SIGIL_EVENTS[0].kind, 'landing');
  assert.notEqual(s.sigilGust(s.dragon.x + 20, s.dragon.y, 10.3), 0);
  s.update(.1, 12);
  assert.equal(s.SIGIL_EVENTS.length, 0);
});
test('sigil bursts remain bounded when many events arrive together', () => {
  const s = scene(), parent = agent('burst-parent'), child = agent('burst-child', 'working', parent.id);
  s.reconcile({ agents: [parent, child] });
  for (let i = 0; i < 40; i++) { s.sigilEvent({ kind: 'cat' }); s.sigilLink(s.wizards.get(child.id), false); }
  assert.equal(s.SIGIL_EVENTS.length, 24);
  assert.equal(s.SIGIL_LINKS.length, 16);
});
test('startup agents are visible at their stations without entrance effects', () => {
  const s = scene(), agents = ['working', 'thinking', 'responding', 'waiting', 'attention', 'idle', 'done'].map(status => agent(status, status));
  agents.push(agent('child', 'working', 'working'));
  s.reconcile({ agents });
  for (const w of s.wizards.values()) {
    assert.equal(w.alpha, 1);
    assert.equal(w.walk, false);
    assert.equal(w.path.length, 0);
    assert.equal(s.blocked(w.x, w.y, 5), false);
    if (w.desk) {
      assert.deepEqual([w.x, w.y], [w.desk.x, w.desk.y]);
      assert.equal(w.desk.alpha, 1);
    } else assert.deepEqual([w.x, w.y], Array.from(w.home));
  }
  assert.equal(s.PARTS.length, 0);
  assert.equal(s.SPELLS.length, 0);
});
test('later arrivals and station changes still animate after startup', () => {
  for (const agents of [[], [agent('existing')]]) {
    const s = scene();
    s.reconcile({ agents });
    s.reconcile({ agents: [...agents, agent('arrival')] });
    const w = s.wizards.get('arrival');
    assert.equal(w.alpha, 0);
    assert.ok(w.path.length || s.SPELLS.some(spell => spell.kind === 'teleport'));
    assert.ok(s.PARTS.length);
    if (agents.length) {
      s.reconcile({ agents: [agent('existing', 'waiting'), agent('arrival')] });
      const existing = s.wizards.get('existing');
      assert.equal(existing.station, 'cafe');
      assert.ok(existing.path.length || s.SPELLS.some(spell => spell.kind === 'teleport'));
    }
  }
});
test('duels recruit only each fighter’s apprentices', () => {
  const s = scene(), agents = [agent('wizard'), agent('demon'), agent('bystander'), agent('w-child', 'working', 'wizard'),
    agent('d-child', 'working', 'demon'), agent('other-child', 'working', 'bystander')];
  for (const a of agents) if (a.id.startsWith('d')) a.origin = 'remote';
  s.reconcile({ agents });
  for (const w of s.wizards.values()) { w.alpha = 1; w.walk = false; }
  s.castRay(s.wizards.get('wizard'), s.wizards.get('demon'));
  const ray = s.SPELLS.at(-1);
  assert.deepEqual(Array.from(ray.attackers), ['w-child']);
  assert.deepEqual(Array.from(ray.defenders), ['d-child']);
  assert.equal(ray.source, 'wizard');
  assert.equal(ray.target, 'demon');
});
test('a cat with nobody to fight skips the battle while every wizard is at a game', () => {
  const s = scene(), agents = [agent('seated-a', 'waiting'), agent('seated-b', 'waiting')];
  s.reconcile({ agents });
  for (const w of s.wizards.values()) w.game = 't1';
  assert.doesNotThrow(() => s.updateBattle(1e6));
  assert.ok(s.SPELLS.every(spell => spell.kind !== 'ray' || spell.target === 'dragon'));
});
test('each battle schedules one encounter', () => {
  const s = scene(), agents = [agent('wizard'), { ...agent('demon'), origin: 'remote' }];
  s.reconcile({ agents });
  for (const w of s.wizards.values()) { w.alpha = 1; w.walk = false; }
  s.updateBattle(1000);
  assert.equal(s.SPELLS.filter(spell => spell.kind === 'ray').length, 1);
  s.updateBattle(1001);
  assert.equal(s.SPELLS.filter(spell => spell.kind === 'ray').length, 1);
});
test('a same-faction tower still gets a cat encounter', () => {
  const s = scene(), agents = Array.from({ length: 10 }, (_, i) => agent(`wizard-${i}`));
  s.reconcile({ agents });
  for (const w of s.wizards.values()) { w.alpha = 1; w.walk = false; }
  s.updateBattle(1000);
  const rays = s.SPELLS.filter(spell => spell.kind === 'ray');
  assert.equal(rays.length, 1);
  assert.equal(rays[0].source, 'cat');
});
test('work keeps its seat through tool changes and renames, then dissolves', () => {
  const s = scene(), a = agent('main');
  s.reconcile({ agents: [a] });
  const w = s.wizards.get(a.id), desk = w.desk;
  assert.equal(w.station, 'work');
  for (const status of ['thinking', 'responding', 'working']) {
    s.reconcile({ agents: [{ ...a, status, tool: 'Read', title: 'Renamed task' }] });
    assert.equal(w.desk, desk);
    assert.equal(desk.w.a.title, 'Renamed task');
  }
  s.reconcile({ agents: [{ ...a, status: 'waiting' }] });
  assert.equal(w.station, 'cafe');
  assert.equal(w.desk, null);
  assert.equal(desk.active, false);
  s.update(.6, 0);
  assert.equal(s.desks.length, 0);
  s.reconcile({ agents: [a] });
  assert.ok(w.desk);
  s.reconcile({ agents: [] });
  assert.equal(w.desk, null);
});
test('mimic steals a desk item and retreats behind the shelf', () => {
  const s = scene(), a = agent('mimic-target');
  s.reconcile({ agents: [a] });
  const desk = s.wizards.get(a.id).desk;
  assert.equal(s.startMimic(desk), true);
  s.MIMIC.path.length = 0;
  s.updateMimic(.1, 0);
  assert.equal(s.MIMIC.phase, 'steal');
  assert.equal(desk.robbed, true);
  s.updateMimic(.1, 1.1);
  assert.equal(s.MIMIC.phase, 'escape');
  s.MIMIC.path.length = 0;
  s.updateMimic(.1, 2);
  assert.equal(s.MIMIC.active, false);
  assert.equal(desk.robbed, false);
});
test('mimic reroutes to a moved desk and abandons a released one', () => {
  const s = scene(), a = agent('moving-mimic-target');
  s.reconcile({ agents: [a] });
  const desk = s.wizards.get(a.id).desk;
  assert.equal(s.startMimic(desk), true);
  desk.x += 40; desk.y += 20;
  s.updateMimic(.1, 0);
  assert.equal(s.MIMIC.targetX, desk.x);
  assert.equal(s.MIMIC.targetY, desk.y);
  desk.active = false;
  s.updateMimic(.1, .1);
  assert.equal(s.MIMIC.phase, 'escape');
  assert.notEqual(desk.robbed, true);
});
test('haunted TODO keeps its original wizard as its target', () => {
  const s = scene(), a = agent('todo-target');
  s.reconcile({ agents: [a] });
  const w = s.wizards.get(a.id), desk = w.desk;
  assert.equal(s.spawnHauntedTodo(w, desk, 0), true);
  const todo = s.HAUNTED_TODOS[0];
  todo.x = w.x + (w.dir < 0 ? 8 : -8); todo.y = w.y - 18;
  s.updateHauntedTodos(.1, 1);
  assert.ok(todo.caughtAt);
  assert.equal(todo.owner, a.id);
  s.updateHauntedTodos(.1, 2.3);
  assert.equal(s.HAUNTED_TODOS.length, 0);
  assert.notEqual(w.emote, 'alert');
});
test('doorway standoff pauses both wizards before one yields', () => {
  const s = scene(), agents = [agent('entering'), agent('leaving')];
  s.reconcile({ agents });
  const [a, b] = agents.map(x => s.wizards.get(x.id));
  a.x = 432; a.y = 302; a.path = [[300, 120]];
  b.x = 440; b.y = 306; b.path = [[436, 326]];
  assert.equal(s.startDoorStandoff(a, b, 0), true);
  const beforePause = [[a.x, a.y], [b.x, b.y]];
  s.update(.1, .2);
  assert.equal(a.stuckAt, 0);
  assert.equal(b.stuckAt, 0);
  assert.deepEqual([[a.x, a.y], [b.x, b.y]], beforePause);
  const stand = s.getDoorStandoff(), yielding = s.wizards.get(stand.yielding), before = yielding.x;
  assert.equal(s.standoffMove(yielding, .1, 1.2), true);
  assert.notEqual(yielding.x, before);
});
test('fellowship sorting groups status, then wizard name', () => {
  const s = scene(), agents = [agent('waiting', 'waiting'), agent('work-a'), agent('work-b'), agent('attention', 'attention')];
  s.reconcile({ agents });
  const sorted = s.sortAgents(agents);
  assert.deepEqual(Array.from(sorted, a => a.status), ['attention', 'working', 'working', 'waiting']);
  const working = sorted.filter(a => a.status === 'working');
  assert.deepEqual(Array.from(working, a => s.wizards.get(a.id).sp.name), [...working]
    .sort((a, b) => s.wizards.get(a.id).sp.name.localeCompare(s.wizards.get(b.id).sp.name))
    .map(a => s.wizards.get(a.id).sp.name).slice());
});
test('apprentices use nearby distinct desks even when listed before their parent', () => {
  const s = scene();
  s.reconcile({ agents: [agent('child', 'working', 'parent'), agent('parent')] });
  const p = s.wizards.get('parent'), c = s.wizards.get('child');
  assert.ok(c.sp.sub);
  assert.ok(Math.hypot(p.desk.x - c.desk.x, p.desk.y - c.desk.y) <= 80);
  assert.notDeepEqual(p.home, c.home);
  for (const w of [p, c]) { [w.x, w.y] = w.home; w.path = []; w.alpha = 1; }
  const home = [...p.home];
  c.x = p.x + 1; c.y = p.y;
  s.separateActors();
  assert.deepEqual([p.x, p.y], home);
});
test('desks reserve the bottle row even before quota data arrives and when crowded', () => {
  const s = scene();
  s.reconcile({ agents: Array.from({ length: 30 }, (_, i) => agent(String(i))) });
  const quotas = Array.from({ length: 6 }, (_, i) => ({ id: String(i), origins: [] }));
  s.setData({ quotas });
  for (const q of quotas) {
    const bottle = s.usageProbe(`usage:${q.id}`);
    for (const d of s.desks) {
      const overlaps = d.x + 30 > bottle.x - 4 && d.x - 30 < bottle.x + 20 &&
        d.y + 30 > bottle.y - 12 && d.y - 30 < bottle.y + 44;
      assert.equal(overlaps, false, `Desk at ${d.x},${d.y} overlaps bottle ${q.id}`);
    }
  }
});

test('served drinks follow wizards back to their desks; unfinished orders are cancelled', () => {
  const s = scene(), a = agent('coffee', 'waiting');
  s.reconcile({ agents: [a] });
  const w = s.wizards.get(a.id), order = { stage: 'served', drink: w.sp.drink, servedAt: 0 };
  w.order = order;
  s.reconcile({ agents: [{ ...a, status: 'working' }] });
  assert.equal(w.order, order);
  [w.x, w.y] = w.home; w.path = []; w.alpha = 1;
  const cups = [];
  s.SP.PR.cup = (...args) => cups.push(args);
  s.drawWorkDesk(w.desk, true, 1);
  assert.equal(cups.length, 1);
  assert.equal(cups[0][3], w.sp.drink.key);
  assert.ok(Math.abs(cups[0][1] - w.desk.x) < 24);
  w.order = { ...order, stage: 'brewing' };
  s.reconcile({ agents: [{ ...a, status: 'working' }] });
  assert.equal(w.order, null);
});
test('task and bottle labels render after sprites and thought bubbles', () => {
  const s = scene(), a = agent('label');
  s.reconcile({ agents: [a] });
  const w = s.wizards.get(a.id);
  [w.x, w.y] = w.home; w.path = []; w.walk = false; w.alpha = 1; w.desk.alpha = 1;
  s.setData({ quotas: [{ id: 'a', origins: ['local'], left: 50, resets_at: Date.now()/1000 + 864000, resets_left: 0 }] });
  s.calls.length = 0;
  s.draw(1);
  const bubble = s.calls.findIndex(c => c[0] === 'drawEmote');
  const title = s.calls.findIndex(c => c[0] === 'drawText' && c[3] === 'FIX WIZARD');
  const bottle = s.calls.findIndex(c => c[0] === 'drawText' && c[3] === 'LOC');
  const sprite = s.calls.findLastIndex(c => c[0] === 'drawImage' && Object.values(w.sp.frames).includes(c[1]));
  assert.ok(sprite >= 0 && bubble > sprite && title > bubble && bottle > title);
});
test('long task labels truncate at the end of the fifth line', () => {
  const s = scene(), a = { ...agent('long-label'), title: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen' };
  s.reconcile({ agents: [a] });
  s.calls.length = 0;
  s.drawTaskLabel(s.wizards.get(a.id).desk);
  const lines = s.calls.filter(c => c[0] === 'drawText').map(c => c[3]);
  assert.equal(lines.length, 5);
  assert.match(lines[4], /\.\.\.$/);
});
test('long placards relocate desks instead of overlapping', () => {
  const s = scene(), agents = Array.from({ length: 9 }, (_, i) => agent(String(i)));
  s.reconcile({ agents });
  const before = new Map(s.desks.map(d => [d.w.a.id, `${d.x},${d.y}`])), steps = s.layout().labSteps;
  s.reconcile({ agents: agents.map(a => ({ ...a, title: 'review the complete architecture and document every correctness boundary in detail' })) });
  const spaces = s.desks.map(d => s.deskSpace(d.x, d.y, d.w));
  for (let i = 0; i < spaces.length; i++) for (let j = i + 1; j < spaces.length; j++) {
    const a = spaces[i], b = spaces[j];
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
      `Placards overlap at desks ${i} and ${j}`);
  }
  const moved = s.desks.filter(d => before.get(d.w.a.id) !== `${d.x},${d.y}`);
  assert.ok(moved.length);
  assert.ok(s.layout().labSteps > steps);
  for (const d of moved) assert.deepEqual(Array.from(d.w.path.at(-1) || [d.w.x, d.w.y]), [d.x, d.y]);
});
test('usage tooltips omit zero resets and retain positive or unknown credits', () => {
  const s = scene();
  for (const count of [0, 1, 2, null]) {
    s.showUsageTip({ i: 0, q: {name:'Test', origins:[], left:50, resets_at:Date.now()/1000+864000, resets_left:count}}, 0, 0);
    if (count === 0) assert.doesNotMatch(s.element.innerHTML, /RESETS? LEFT/);
    else assert.match(s.element.innerHTML, new RegExp((count ?? '\\?') + ' RESETS? LEFT'));
  }
});
test('usage tooltip shows detailed reset timing for each quota', () => {
  const s = scene();
  s.showUsageTip({ q: { name: 'Work', origins: [], left: 50,
    resets_at: Date.now() / 1000 + 86400, reset_detail: '1 Day 2 Hours 3 Minutes', resets_left: 0 } }, 0, 0);
  assert.match(s.element.innerHTML, /RESETS IN 1 Day 2 Hours 3 Minutes/);
  s.setData({ quotas: [
    { id: 'claude:active', name: 'Work Claude', account: 'Work', model: 'Claude', provider: 'claude', origins: [], left: 50,
      resets_at: Date.now() / 1000 + 86400, reset_detail: '1 Day 2 Hours 3 Minutes' },
    { id: 'claude:Fable', name: 'Work Fable', account: 'Work', model: 'Fable', provider: 'claude', origins: [], left: 40,
      resets_at: Date.now() / 1000 + 172800, reset_detail: '2 Days 4 Hours 5 Minutes' },
  ] });
  s.showUsageTip(s.usageProbe('usage:claude:active'), 0, 0);
  assert.match(s.element.innerHTML, /Claude: RESETS IN 1 Day 2 Hours 3 Minutes/);
  assert.match(s.element.innerHTML, /Fable: RESETS IN 2 Days 4 Hours 5 Minutes/);
});
test('unused reset credits show one expiration per line including missing details', () => {
  const s = scene();
  const q = { id: 'claude', name: 'Work', account: 'Work', model: 'Claude', provider: 'claude',
    origins: [], left: 50, resets_left: 3, reset_expirations: [1800000000, null] };
  for (const paired of [false, true]) {
    s.setData({ quotas: paired ? [q, { ...q, id: 'fable', model: 'Fable' }] : [q] });
    s.showUsageTip(s.usageProbe('usage:claude'), 0, 0);
    const lines = s.element.innerHTML.match(/<div class="tt-age tt-credit">RESET \d: [^<]+<\/div>/g);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /RESET 1: EXPIRES /);
    assert.match(lines[1], /RESET 2: DOES NOT EXPIRE/);
    assert.match(lines[2], /RESET 3: EXPIRATION UNAVAILABLE/);
    assert.doesNotMatch(s.element.innerHTML, /RESETS AT/);
  }
  s.showUsageTip({ q: { ...q, resets_left: 0 } }, 0, 0);
  assert.doesNotMatch(s.element.innerHTML, /RESET \d:/);
});
test('additional quota accounts render distinct bottles and remain hoverable', () => {
  const s = scene(), bottles = [];
  s.SP.PR.quotaVat = (g, x, y, shape, fill) => bottles.push({ x, y, fill });
  for (const count of [3, 4, 5, 6]) {
    const quotas = Array.from({ length: count }, (_, i) => ({
      id: `account-${i}`, name: `Account ${i + 1}`, origins: i === 0 ? ['remote'] : [],
      left: 10 + i * 15, resets_at: Date.now() / 1000 + 864000, resets_left: i,
    }));
    s.setData({ quotas });
    bottles.length = 0;
    s.draw(1);
    assert.equal(bottles.length, count);
    assert.equal(new Set(bottles.map(b => `${b.x},${b.y}`)).size, count);
    bottles.forEach((b, i) => {
      assert.equal(b.fill, quotas[i].left);
      assert.ok(b.x > 122, 'Bottle clears the fixed workbench');
      assert.ok(b.x >= 8 && b.x + 20 <= 264 && b.y - 12 >= 0 && b.y + 44 <= 260);
      const id = s.pickAt({ clientX: b.x + 8, clientY: b.y + 14 });
      assert.equal(id, `usage:${quotas[i].id}`);
      s.showUsageTip(s.usageProbe(id), 0, 0);
      assert.ok(s.element.innerHTML.includes(quotas[i].name));
      assert.ok(s.element.innerHTML.includes(`${quotas[i].left}% REMAINING`));
    });
  }
});
test('each account pairs Claude and Fable in one cylinder sized by plan tier', () => {
  const s = scene(), bottles = [];
  s.SP.PR.quotaVat = (g, x, y, shape, fill, color) => bottles.push({ x, y, shape, fill, color });
  const row = (account, model, tier, left, origins) => ({ id: `claude:${account} ${model}`, name: `${account} ${model}`,
    account, model, tier, provider: 'claude', origins, left, resets_left: null });
  s.setData({ quotas: [
    row('Espresso', 'Claude', 10, 100, ['local']), row('Espresso', 'Fable', 10, 90, ['remote']),
    row('Mirasume', 'Claude', 20, 40, []), row('Mirasume', 'Fable', 20, 100, []),
    row('Standard', 'Claude', 1, 50, []), row('Standard', 'Fable', 1, 100, []),
  ] });
  s.drawUsageProbes(0);
  assert.deepEqual(bottles.map(b => b.shape), ['half', 'vat', 'small']);
  assert.deepEqual(bottles.map(b => [...b.fill].map(part => part.value)), [[45, 55], [40, 0], [50, 0]]);
  assert.notEqual(bottles[0].fill[0].color, bottles[0].fill[1].color);
  const combined = s.usageProbe('usage:claude:Espresso Claude');
  assert.equal(combined.q.name, 'Espresso');
  assert.equal(combined.q.left, 100);
  assert.equal(s.usageProbe('usage:claude:Espresso Fable').q.name, 'Espresso');
  s.showUsageTip(combined, 0, 0);
  assert.match(s.element.innerHTML, /Claude: 100% REMAINING/);
  assert.match(s.element.innerHTML, /Fable: 90% REMAINING/);
  assert.doesNotMatch(s.element.innerHTML, /95% REMAINING|10x/);
});
test('reset tooltips show days, hours, and minutes without CLI detail', () => {
  const s = scene();
  for (const [seconds, label] of [[15 * 3600 + 53 * 60, '15 Hours 53 Minutes'], [3601, '1 Hour 1 Minute'], [3599, '1 Hour 0 Minutes'], [30, '1 Minute'], [-1, '0 Minutes'], [86400, '1 Day 0 Minutes'], [2 * 86400, '2 Days 0 Minutes']]) {
    s.showUsageTip({ q: { name: 'Test', origins: [], resets_left: 0, resets_at: Date.now() / 1000 + seconds } }, 0, 0);
    assert.ok(s.element.innerHTML.includes(`RESETS IN ${label}<`), s.element.innerHTML);
  }
});

test('cloud lightning follows its caster, lights yellow eyes, and expires without an impact', () => {
  const s = scene();
  s.reconcile({ agents: [agent('storm')] });
  const w = s.wizards.get('storm');
  w.r = () => .99;
  s.castSpell(w, 0);
  const spell = s.SPELLS[0];
  assert.equal(spell.kind, 'storm');
  w.x = 120; w.y = 180;
  assert.deepEqual([...s.cloudAnchor(spell)], [120, 145]);
  s.drawGlowingEyes(w, 'idleA', 1);
  assert.equal(s.ctx.fillStyle, '#ffd84a');
  w.path = []; w.walk = false; w.alpha = 1;
  s.calls.length = 0;
  s.draw(1);
  assert.equal(s.calls.some(c => c[0] === 'drawEmote'), false);
  const particles = s.PARTS.length;
  s.updateSpells(spell.life + .1, 4);
  assert.equal(s.SPELLS.length, 0);
  assert.equal(s.PARTS.length, particles);
});

test('arriving wizards sit exactly behind the desk with their lower body hidden', () => {
  const s = scene();
  s.reconcile({ agents: [agent('seated', 'thinking')] });
  const w = s.wizards.get('seated');
  w.x = w.desk.x; w.y = w.desk.y + 2; w.path = []; w.alpha = 1;
  s.update(.1, 0);
  assert.deepEqual([w.x, w.y], [w.desk.x, w.desk.y]);
  assert.equal(w.walk, false);
  s.calls.length = 0;
  s.draw(1);
  const clip = s.calls.findIndex(c => c[0] === 'rect' && c[3] === 20 && c[4] === 16);
  const sprite = s.calls.findIndex((c, i) => i > clip && c[0] === 'drawImage');
  const desktop = s.calls.findIndex(c => c[0] === 'fillRect' && c[1] === w.desk.x - 24 && c[2] === w.desk.y - 7 && c[3] === 48 && c[4] === 8);
  assert.ok(sprite >= 0 && desktop > sprite);
  assert.ok(clip >= 0 && sprite > clip);
});

function racketGame(type) {
  const s = scene(), agents = [agent('left', 'waiting'), agent('right', 'waiting')];
  s.reconcile({ agents });
  s.COURT.types = [type];
  s.startGame(s.COURT, agents.map(a => ({ kind: 'wizard', id: a.id })), -2);
  for (const w of s.wizards.values()) {
    [w.x, w.y] = w.home; w.path = []; w.walk = false; w.alpha = 1;
    w.order = { stage: 'served', drink: w.sp.drink, servedAt: 0 };
  }
  s.updateRally(s.COURT, 0);
  return s;
}
for (const type of ['badminton', 'pingpong']) {
  test(`${type} rallies alternate sides while both players move to return shots`, () => {
    const s = racketGame(type), ys = [new Set(), new Set()], directions = new Set();
    for (let i = 1; i <= 120; i++) {
      const t = i / 10;
      s.update(.1, t);
      const game = s.COURT.game, r = game.rally;
      assert.equal(game.type, type);
      directions.add(Math.sign(r.to[0] - r.from[0]));
      const pos = s.rallyPosition(game, t);
      assert.ok(pos.every(Number.isFinite));
      [...s.wizards.values()].forEach((w, j) => ys[j].add(Math.round(w.y)));
    }
    assert.equal(directions.size, 2);
    assert.ok(s.COURT.game.rally.hits >= 6);
    assert.ok(ys.every(values => values.size > 5));
    s.calls.length = 0;
    s.draw(12);
    assert.ok(s.calls.some(c => c[0] === 'fillRect' && c.slice(1).every(Number.isFinite)));
  });
}
for (const type of ['badminton', 'pingpong']) {
  test(`${type} awards points once, celebrates winners, and serves again after a pause`, () => {
    const s = racketGame(type), game = s.COURT.game, winners = new Set(), shots = new Set();
    let points = 0;
    for (let i = 0; i < 160; i++) {
      const r = game.rally, end = r.start + r.duration;
      for (const w of s.wizards.values()) { [w.x, w.y] = w.home; w.path = []; }
      if (r.winner !== undefined) {
        assert.ok(r.exchanges >= 6 && r.exchanges <= 10);
        winners.add(r.winner); shots.add(r.shot);
        s.calls.length = 0;
        s.drawRally(end - .05);
        assert.ok(s.calls.some(c => c[0] === 'lineTo'), 'winning projectile leaves a trail');
        s.updateRally(s.COURT, end);
        points++;
        assert.equal(game.score[0] + game.score[1], points);
        s.updateRally(s.COURT, end + .5);
        assert.equal(game.rally, r, 'pause before the next serve');
        assert.equal(game.score[0] + game.score[1], points, 'a point cannot score twice');
        s.calls.length = 0;
        s.drawRally(end + .2);
        assert.ok(!s.calls.some(c => c[0] === 'drawText'), 'scoring effects contain no text');
        assert.ok(s.calls.some(c => c[0] === 'lineTo'), 'scoring burst remains animated');
        s.updateRally(s.COURT, end + 1.4);
        assert.equal(game.rally.receiver, 1 - r.winner, 'winner serves the next point');
        assert.equal(game.rally.exchanges, 1);
      } else s.updateRally(s.COURT, end);
    }
    assert.ok(points >= 10);
    assert.equal(winners.size, 2, 'both players can score');
    assert.ok(shots.has(type === 'pingpong' ? 'slam' : 'smash'));
    assert.ok([...shots].some(shot => shot !== 'slam' && shot !== 'smash'));
  });
}
test('racket games end and release the opponent when a wizard resumes work', () => {
  const s = racketGame('pingpong');
  s.reconcile({ agents: [agent('left', 'working'), agent('right', 'waiting')] });
  s.update(.1, .1);
  assert.equal(s.COURT.game, null);
  assert.equal(s.wizards.get('left').station, 'work');
  assert.ok(s.wizards.get('left').desk);
  assert.equal(s.wizards.get('right').game, null);
  assert.equal(s.wizards.get('right').station, 'cafe');
});
test('badminton flies higher than ping pong and both meet the rackets', () => {
  const s = racketGame('badminton'), game = s.COURT.game, r = game.rally;
  assert.deepEqual([...s.rallyPosition(game, 0)], [...r.from]);
  assert.deepEqual([...s.rallyPosition(game, r.duration)].map(Math.round), [...r.to].map(Math.round));
  const birdie = s.rallyPosition(game, r.duration / 2);
  const ball = s.rallyPosition({ ...game, type: 'pingpong' }, r.duration / 2);
  assert.ok(birdie[1] < ball[1] - 10);
});

test('ping pong rotates through normal, slice, backhand, topspin, and slam shots', () => {
  const s = racketGame('pingpong'), game = s.COURT.game, shots = [];
  for (let i = 0; i < 5; i++) {
    shots.push(game.rally.shot);
    const mid = s.rallyPosition(game, game.rally.start + game.rally.duration / 2);
    assert.ok(mid.every(Number.isFinite));
    for (const w of s.wizards.values()) { [w.x, w.y] = w.home; w.path = []; }
    s.updateRally(s.COURT, game.rally.start + game.rally.duration);
  }
  assert.deepEqual(shots, ['normal', 'slice', 'backhand', 'topspin', 'slam']);
});

test('badminton uses clear, drop, drive, and smash trajectories with shuttle drag', () => {
  const s = racketGame('badminton'), game = s.COURT.game, shots = [];
  for (let i = 0; i < 4; i++) {
    const r = game.rally;
    shots.push(r.shot);
    const early = s.rallyPosition(game, r.start + r.duration * .25);
    assert.ok(Math.abs(early[0] - r.from[0]) > Math.abs(r.to[0] - r.from[0]) * .25);
    if (r.shot === 'smash') {
      const ys = Array.from({ length: 9 }, (_, j) => s.rallyPosition(game, r.start + r.duration * j / 8)[1]);
      assert.ok(ys.every((y, j) => !j || y >= ys[j - 1]), 'smash descends continuously from overhead contact');
    }
    assert.deepEqual([...s.rallyPosition(game, r.start + r.duration)].map(Math.round), [...r.to].map(Math.round));
    for (const w of s.wizards.values()) { [w.x, w.y] = w.home; w.path = []; }
    s.updateRally(s.COURT, r.start + r.duration);
    assert.deepEqual([...game.rally.from], [...r.to], 'the next shot begins at the previous contact point');
  }
  assert.deepEqual(shots, ['clear', 'drop', 'drive', 'smash']);
});

test('go players take visible turns that change the tabletop state', () => {
  const s = scene(), agents = [agent('go-one', 'waiting'), agent('go-two', 'waiting')], table = s.TABLES[1];
  s.reconcile({ agents });
  s.startGame(table, agents.map(a => ({ kind: 'wizard', id: a.id })), -2);
  for (const w of s.wizards.values()) { [w.x, w.y] = w.home; w.path = []; w.alpha = 1; }
  const before = JSON.stringify(table.game.stones);
  s.updateBoardGame(table.game, 0);
  assert.notEqual(JSON.stringify(table.game.stones), before);
  assert.equal(table.game.move.player, 0);
  s.calls.length = 0;
  s.drawTableGame(s.ctx, table, .3);
  assert.ok(s.calls.some(c => c[0] === 'lineTo'), 'player reaches toward the move');
  assert.ok(s.calls.filter(c => c[0] === 'fillRect').every(c => c.slice(1, 5).every(Number.isFinite)));
});

function magicGame(statuses = ['waiting', 'waiting']) {
  const s = scene(), agents = statuses.map((status, i) => agent(`duelist-${i}`, status));
  s.reconcile({ agents });
  s.startGame(s.MTG, agents.map(a => ({ kind: 'wizard', id: a.id })), -2);
  for (const w of s.wizards.values()) { [w.x, w.y] = w.home; w.path = []; w.walk = false; w.alpha = 1; }
  return { s, agents, game: s.MTG.game };
}
const playMagic = (s, game, until, from = 0) => {
  const seen = new Set();
  for (let t = from; t < until && game.finishedAt === undefined; t += .1) {
    s.updateMagic(game, t); s.updateMagicCards(.1, t);
    if (game.ev) seen.add(game.ev.type);
  }
  return seen;
};
test('Magic duelists face each other, deal hands, and put cards and creatures on the mat', () => {
  const { s, game } = magicGame();
  assert.deepEqual(game.players.map(p => p.seat), [0, 1]);
  assert.equal(game.mtg.sides.length, 2);
  const seen = playMagic(s, game, 90);
  assert.ok(['shuffle', 'roll', 'draw', 'land', 'cast', 'enter'].every(type => seen.has(type)), [...seen].join());
  assert.deepEqual(game.players.map(p => s.wizards.get(p.id).dir), [1, -1]);
  const field = game.mtg.sides.flatMap(me => me.field);
  assert.ok(field.length && field.every(c => [c.vx, c.vy, c.vz].every(Number.isFinite)));
  s.calls.length = 0;
  s.draw(90);
  const rects = s.calls.filter(c => c[0] === 'fillRect');
  assert.ok(rects.length > 60 && rects.every(c => c.slice(1, 5).every(Number.isFinite)));
  const minis = field.filter(c => c.type === 'creature' && c.key !== 'sorcerer').map(c => s.SP.cardArt(c.key));
  assert.ok(minis.length && minis.every(art => s.calls.some(c => c[0] === 'drawImage' && c[1] === art)), 'creatures stand on their cards');
  const w = s.wizards.get(game.players[0].id);
  const [mine, theirs] = [game.mtg.sides[0], game.mtg.sides[1]].map(me => me.life);
  assert.equal(s.statusLine(w.a, w), `PLAYING MAGIC THE GATHERING: ${mine} LIFE VS ${theirs}`);
});
test('board games outlast the court timer and end only when the game does', () => {
  const { s, game } = magicGame();
  let t = 0;
  for (; t < 1500 && s.MTG.game; t += .25) s.update(.25, t);
  assert.equal(s.MTG.game, null);
  assert.ok(t > 90, 'a duel takes minutes, not seconds');
  assert.ok(game.mtg.winner === 0 || game.mtg.winner === 1);
  const loser = game.mtg.sides[1 - game.mtg.winner];
  assert.ok(loser.life <= 0 || !loser.library.length || game.mtg.turn > 40);
  const go = scene(), pair = [agent('go-a', 'waiting'), agent('go-b', 'waiting')], table = go.TABLES[1];
  go.reconcile({ agents: pair });
  go.startGame(table, pair.map(a => ({ kind: 'wizard', id: a.id })), -2);
  for (const w of go.wizards.values()) { [w.x, w.y] = w.home; w.path = []; }
  const record = table.game.record = { black: 'A', white: 'B', date: '2000', moves: Array.from({ length: 60 }, (_, i) => [i % 19, i / 19 | 0, i % 2]) };
  for (t = 0; t < 150; t += .5) go.updateTableGames(t);
  assert.equal(table.game.record, record, 'the whole record replays, long past the court timer');
  assert.equal(table.game.ply, 60);
  assert.ok(table.game.finishedAt > 100);
});
test('a duelist called back to work ends the duel and frees the opponent', () => {
  const { s, game, agents } = magicGame();
  playMagic(s, game, 5);
  s.reconcile({ agents: [agent('duelist-0', 'working'), agents[1]] });
  s.update(.1, 5.1);
  assert.equal(s.MTG.game, null);
  assert.equal(s.wizards.get('duelist-0').station, 'work');
  assert.equal(s.wizards.get('duelist-1').game, null);
  assert.equal(s.wizards.get('duelist-1').station, 'cafe');
});
test('idle duelists finish their game before dozing by the hearth', () => {
  const { s, game, agents } = magicGame();
  playMagic(s, game, 5);
  s.reconcile({ agents: [agent('duelist-0', 'idle'), agents[1]] });
  s.update(.1, 5.1);
  const w = s.wizards.get('duelist-0');
  assert.equal(s.MTG.game, game);
  assert.equal(w.game, 'mtg');
  assert.match(s.statusLine(w.a, w), /^PLAYING MAGIC/);
  game.finishedAt = 5;
  s.update(.1, 14.2);
  assert.equal(s.MTG.game, null);
  assert.equal(w.station, 'hearth');
});
test('Biggles answers a judge call, rules, and wanders off again', () => {
  const { s, game } = magicGame();
  Object.assign(s.cat, { state: 'sit', path: [], game: null });
  s.callJudge(game, 0);
  assert.ok(game.players.some(p => p.judge && p.seat === 2));
  assert.equal(s.cat.game, 'mtg');
  Object.assign(s.cat, { state: 'game', path: [] });
  game.nextMove = 99;
  s.updateMagic(game, 1);
  assert.deepEqual([game.say.who, game.say.text], ['cat', 'MRRP.']);
  s.updateMagic(game, 19);
  assert.ok(!game.players.some(p => p.judge));
  assert.equal(s.cat.game, null);
  assert.equal(s.MTG.game, game);
  const { S, labExtra } = s.layout(), at = (x, y) => s.pickAt({ clientX: (x + labExtra) * S, clientY: y * S });
  Object.assign(s.cat, { x: 318, y: 250 });
  assert.equal(at(318, 246), 'cat', 'the judge stays hoverable');
  assert.equal(at(352, 275), 'mtg');
});
test('Biggles blinks past a stall on his way to the table instead of freezing the duel', () => {
  const s = scene(() => .5);
  s.reconcile({ agents: [agent('solo', 'waiting')] });
  Object.assign(s.cat, { x: 104, y: 130, state: 'sit', path: [], dest: null, game: null, until: 1e9 });
  s.startGame(s.MTG, [{ kind: 'wizard', id: 'solo' }, { kind: 'cat' }], 0);
  const game = s.MTG.game;
  for (let t = 0; t < 120 && !game.ev; t += 1 / 30) s.update(1 / 30, t);
  assert.equal(s.cat.state, 'game');
  assert.ok(game.ev, 'the duel gets under way');
});
test('Magic decks take the colour of the robe each wizard wears, job uniforms included', () => {
  const s = scene(), agents = [agent('white-mage', 'waiting'), agent('red-mage', 'waiting')];
  s.reconcile({ agents });
  const [white, red] = agents.map(a => s.wizards.get(a.id));
  Object.assign(white.sp, { robe: '#eeeae0', hue: 225 }); Object.assign(red.sp, { robe: '#b42a2a', hue: 120 });
  s.startGame(s.MTG, agents.map(a => ({ kind: 'wizard', id: a.id })), 0);
  assert.deepEqual([...s.MTG.game.mtg.sides.map(me => me.colors.join(''))], ['W', 'R']);
});
test("a Black Lotus alarm hands back the opponent's emote unless they now need attention", () => {
  for (const status of ['waiting', 'attention']) {
    const { s, game } = magicGame(), foe = s.wizards.get(game.players[1].id), lotus = { ...s.MAGIC.CARDS.lotus, vx: 320, vy: 260 };
    foe.emote = 'drink:latte';
    s.magicEvent(game, { type: 'cast', side: 0, card: lotus, lotus, dur: 1 }, 0);
    assert.equal(foe.emote, 'alert');
    if (status === 'attention') { foe.a = { ...foe.a, status }; foe.emote = 'alert'; }
    s.updateMagicCards(.1, 2.1);
    assert.equal(foe.emote, status === 'attention' ? 'alert' : 'drink:latte');
  }
});
test('the Magic table tooltip names both duelists without previewing an unrelated card', () => {
  const { s, game } = magicGame();
  playMagic(s, game, 30);
  const html = s.magicTipHTML(), last = game.mtg.last;
  assert.ok(last);
  assert.match(html, /MAGIC: THE GATHERING <span>TURN \d+<\/span>/);
  for (const me of game.mtg.sides) assert.ok(html.includes(`${me.name} · `) && html.includes(`${me.life} LIFE`));
  assert.doesNotMatch(html, /mtg-card/);
});

test('Magic hover follows visible cards, miniatures, tapped bounds and stack order', () => {
  const { s, game } = magicGame(), state = game.mtg;
  const card = (key, id, x, y, more = {}) => ({ ...s.MAGIC.CARDS[key], key, id, side: 0, vx: x, vy: y, vz: 0, ...more });
  const land = card('swamp', 101, 320, 260, { tapped: true });
  const creature = card('zombies', 102, 340, 270, { color: 'B' });
  const buried = card('forest', 103, 302, 278), grave = card('plains', 104, 302, 278);
  for (const me of state.sides) { me.field = []; me.grave = []; }
  state.sides[0].field = [land, creature]; state.sides[0].grave = [buried, grave]; state.stack = [];
  const { S, labExtra } = s.layout();
  const at = (x, y) => s.pickAt({ clientX: (x + labExtra) * S, clientY: y * S });
  s.drawMagic(s.ctx, 10);
  for (const [x, y, c] of [[324.5, 262, land], [341, 268, creature], [303, 279, grave]]) {
    const id = at(x, y);
    assert.equal(id, `mtg:${c.id}`);
    assert.ok(s.magicTipHTML(id).includes(c.name));
  }
  assert.equal(at(325, 262), 'mtg', 'tapped card ends at its rendered edge');
  assert.equal(at(360, 280), 'mtg', 'empty table only shows the game summary');
  assert.doesNotMatch(s.magicTipHTML(at(360, 280)), /mtg-card/);
  const spell = card('counter', 105, 337, 253, { color: 'U', vz: 1 });
  state.stack = [{ c: spell }]; s.drawMagic(s.ctx, 10);
  assert.equal(at(341, 268), 'mtg:105', 'stack card covers the creature underneath');
  state.stack = []; state.sides[0].field = []; state.sides[0].grave = [];
  s.drawMagic(s.ctx, 11);
  assert.equal(at(341, 268), 'mtg', 'removed cards lose their hover targets');
});

test('Go remains a two-player game when a cat is available', () => {
  const s = scene(), agents = [agent('go-a', 'waiting'), agent('go-b', 'waiting')], table = s.TABLES[1];
  s.reconcile({ agents }); table.types = ['go'];
  s.startGame(table, [...agents.map(a => ({ kind: 'wizard', id: a.id })), { kind: 'cat', id: 'cat' }], 0);
  assert.equal(table.game.players.length, 2);
  assert.equal(s.COURT.game, null);
});

test('Go captures connected groups and multiple groups with no liberties', () => {
  const { playGo } = scene();
  const stones = [[0, 0, 0], [2, 0, 0], [0, 1, 0], [2, 1, 0], [1, 0, 1], [1, 1, 1]]
    .map(([x, y, side]) => ({ x, y, side }));
  const next = playGo(stones, { x: 1, y: 2, side: 0 });
  assert.equal(next.length, 5);
  assert.ok(next.every(s => s.side === 0));
  const split = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [1, 0, 1], [0, 1, 1]]
    .map(([x, y, side]) => ({ x, y, side }));
  assert.equal(playGo(split, { x: 1, y: 1, side: 0 }).length, 4);
});

test('Go rejects occupied points and suicide', () => {
  const { playGo } = scene();
  const surround = [[1, 0], [0, 1], [2, 1], [1, 2]].map(([x, y]) => ({ x, y, side: 0 }));
  assert.equal(playGo(surround, { x: 1, y: 1, side: 1 }), null);
  assert.equal(playGo(surround, { x: 0, y: 1, side: 1 }), null);
});

test('Go keeps the finished professional record on the board', () => {
  let random = 0;
  const s = scene(() => random), agents = [agent('go-black', 'waiting'), agent('go-white', 'waiting')], table = s.TABLES[1];
  s.reconcile({ agents }); table.types = ['go'];
  s.startGame(table, agents.map(a => ({ kind: 'wizard', id: a.id })), -2);
  for (const w of s.wizards.values()) { [w.x, w.y] = w.home; w.path = []; }
  const game = table.game, record = game.record;
  assert.ok(s.gameName(game).startsWith(`GO: ${record.black} VS ${record.white}`.toUpperCase()));
  for (const [turn, [x, y, side]] of record.moves.entries()) {
    game.nextMove = turn;
    s.updateBoardGame(game, turn);
    assert.deepEqual([...game.move.to, game.stones.at(-1).side], [x, y, side]);
    assert.equal(game.move.seat, game.players[side].seat);
  }
  const stones = JSON.stringify(game.stones), finishedAt = record.moves.length - 1;
  random = .99;
  for (const turn of [100, 101]) { game.nextMove = turn; s.updateBoardGame(game, turn); }
  assert.equal(game.record, record);
  assert.equal(game.finishedAt, finishedAt);
  assert.equal(JSON.stringify(game.stones), stones);
});

test('Go turns remove captured stones and keep the placement animation', () => {
  const s = scene(), agents = [agent('go-black', 'waiting'), agent('go-white', 'waiting')], table = s.TABLES[1];
  s.reconcile({ agents }); table.types = ['go'];
  s.startGame(table, agents.map(a => ({ kind: 'wizard', id: a.id })), -2);
  for (const w of s.wizards.values()) { [w.x, w.y] = w.home; w.path = []; }
  table.game.stones = [[0, 0, 0], [2, 0, 0], [0, 1, 0], [2, 1, 0], [1, 0, 1], [1, 1, 1]]
    .map(([x, y, side]) => ({ x, y, side }));
  Object.assign(table.game, { record: { moves: [[1, 2, 0]] }, ply: 0 });
  s.updateBoardGame(table.game, 0);
  assert.deepEqual(Array.from(table.game.move.to), [1, 2]);
  assert.equal(table.game.stones.length, 5);
  assert.equal(table.game.stones.at(-1).side, 0);
  s.calls.length = 0; s.drawTableGame(s.ctx, table, .3);
  assert.ok(s.calls.some(c => c[0] === 'lineTo'));
});


for (const type of ['badminton', 'pingpong']) {
  test(`${type} materializes before rallying and has no court label`, () => {
    const s = racketGame(type), game = s.COURT.game;
    game.started = 0; delete game.rally;
    for (const w of s.wizards.values()) { [w.x,w.y] = w.home; w.path = []; }
    s.updateRally(s.COURT, 1);
    assert.equal(game.rally, undefined);
    const phases = [];
    s.SP.PR.summon = (g, x, y, p) => phases.push(p);
    s.calls.length = 0;
    s.drawCourt(s.ctx, 1);
    assert.deepEqual(phases, [.5]);
    assert.equal(s.calls.some(c => c[0] === 'drawText'), false);
    s.updateRally(s.COURT, 2);
    assert.ok(game.rally);
    s.drawCourt(s.ctx, 3);
    assert.equal(phases.length, 1);
  });
}
test('cauldron changes color, ignites and sometimes strikes without changing color', () => {
  const s = scene(), initial = s.BREW.color;
  s.updateBrew(7);
  assert.notEqual(s.BREW.color, initial);
  assert.equal(s.BREW.strike, 7);
  assert.ok(s.BREW.fire > 7);
  assert.equal(s.BREW.from, initial);
  s.updateBrew(s.BREW.next);
  const color = s.BREW.color, third = s.BREW.next;
  s.updateBrew(third);
  assert.equal(s.BREW.color, color);
  assert.equal(s.BREW.strike, third);
});
test('work builds runes, completion celebrates once, and the celebration expires', () => {
  const s = scene(), a = agent('ritual');
  s.reconcile({agents:[a]});
  const w = s.wizards.get(a.id);
  [w.x,w.y] = w.home; w.path = [];
  s.update(1, 1);
  assert.equal(w.desk.elapsed, 1);
  const x = w.desk.x;
  s.reconcile({agents:[{...a,status:'waiting'}]});
  s.reconcile({agents:[{...a,status:'waiting'}]});
  assert.equal(s.RITUALS.length, 1);
  assert.equal(s.RITUALS[0].x, x);
  s.update(.1, 4.1);
  assert.equal(s.RITUALS.length, 0);
});

test('quota tooltips show origins only for accounts in use', () => {
  const s = scene();
  for (const origins of [[], ['local'], ['remote'], ['local', 'remote']]) {
    s.showUsageTip({ i: 0, q: { name: 'Account', origins, left: 50, resets_left: 0 } }, 0, 0);
    assert.doesNotMatch(s.element.innerHTML, /USAGE|NOT IN USE/);
    assert.equal(s.element.innerHTML.includes('tt-meta'), origins.length > 0);
    if (origins.length) assert.ok(s.element.innerHTML.includes(origins.join(' + ').toUpperCase()));
  }
});

test('completion draws only the celebrating pet while its old desk fades', () => {
  const s = scene(), a = agent('celebrating');
  s.reconcile({agents:[a]});
  s.wizards.get(a.id).desk.alpha = 1;
  s.reconcile({agents:[{...a,status:'waiting'}]});
  const pets = [];
  s.SP.PR.deskPet = (g,x,y,seed,t,excited) => pets.push(excited);
  s.draw(.1);
  assert.deepEqual(pets, [true]);
});

test('laboratory grows instead of overlapping fixtures or existing desks', () => {
  const s = scene(), agents = Array.from({ length: 30 }, (_, i) => agent(String(i)));
  s.reconcile({ agents: agents.slice(0, 4) });
  const original = s.desks.map(d => [d, d.x, d.y]);
  s.reconcile({ agents });
  assert.ok(s.layout().labExtra > 0);
  assert.ok(s.blocked(21 - s.layout().labExtra, 75, 5) && !s.blocked(21, 75, 5));
  for (const [d, x, y] of original) assert.deepEqual([d.x, d.y], [x, y]);
  const fixtures = [[56, 150, 30, 26], [8 - s.layout().labExtra, 58, 26, 70], [88, 42, 34, 20],
    ...s.RESOURCE_BALLS.map(b => [b.x, b.y, 16, b.metric === 'disk' ? 30 : 24]), [124, 30, 136, 58]];
  s.desks.forEach((d, i) => {
    assert.ok(d.x - 32 >= 8 - s.layout().labExtra && d.x + 32 <= 264);
    assert.ok(d.y - 30 >= 34 && d.y + 24 <= 240 + s.layout().labDown);
    const obstacles = [...fixtures, ...s.desks.slice(0, i).map(other => [other.x - 32, other.y - 30, 64, 54])];
    for (const [x, y, width, height] of obstacles)
      assert.ok(d.x + 32 <= x || d.x - 32 >= x + width || d.y + 24 <= y || d.y - 30 >= y + height);
  });
  const { labExtra, S } = s.layout();
  for (const w of s.wizards.values()) { [w.x, w.y] = w.home; w.path = []; }
  const left = [...s.wizards.values()].sort((a, b) => a.x - b.x)[0];
  assert.equal(s.pickAt({ clientX: (left.x + labExtra) * S, clientY: (left.y - 10) * S }), left.a.id);
  s.setData({ quotas: [{ id: 'claude', origins: ['remote'] }] });
  const bottle = s.usageProbe('usage:claude');
  assert.equal(s.pickAt({ clientX: (bottle.x + 8 + labExtra) * S, clientY: (bottle.y + 14) * S }), 'usage:claude');
});

test('new quota bottles relocate conflicting desks after the laboratory has expanded', () => {
  const s = scene(), agents = Array.from({ length: 30 }, (_, i) => agent(String(i)));
  s.reconcile({ agents });
  const quotas = Array.from({ length: 12 }, (_, i) => ({ id: String(i), origins: [] }));
  s.setData({ quotas });
  s.reconcile({ agents });
  assert.equal(s.desks.length, agents.length);
  for (const q of quotas) {
    const bottle = s.usageProbe(`usage:${q.id}`);
    for (const d of s.desks)
      assert.ok(d.x + 32 <= bottle.x - 4 || d.x - 32 >= bottle.x + 20 || d.y - 30 >= bottle.y + 44);
  }
});

test('quota symbols distinguish exhausted and unavailable readings in their bottle color', () => {
  const s = scene(), colors = [];
  s.ctx.stroke = () => colors.push(s.ctx.strokeStyle);
  for (const [left, error, arcs, strokes, loginExpired] of [[0, null, 1, 2], [null, null, 0, 2], [0, 'offline', 0, 2], [50, null, 0, 0], [null, 'expired', 1, 2, true]]) {
    s.setData({ quotas: [{ id: 'a', origins: [], left, error, loginExpired }] });
    s.calls.length = 0;
    colors.length = 0;
    s.drawUsageProbes(0);
    assert.equal(s.calls.filter(c => c[0] === 'arc').length, arcs);
    assert.equal(colors.length, strokes);
    assert.ok(colors.every(color => color === s.usageProbe('usage:a').color));
  }
});

test('laboratory shrinks after removed desks fade and compacts a surviving outer desk', () => {
  const s = scene(), agents = Array.from({ length: 25 }, (_, i) => agent(String(i)));
  s.reconcile({ agents });
  s.update(.4, 0);
  const survivor = s.desks.find(d => d.y + 24 > 300).w;
  s.reconcile({ agents: [survivor.a] });
  assert.ok(s.layout().labSteps > 0);
  s.update(.6, .6);
  assert.equal(s.desks.length, 1);
  assert.equal(s.layout().labSteps, 0);
  assert.equal(s.layout().labExtra, 0);
  assert.equal(s.layout().labDown, 60, 'the base storey stays');
  assert.ok(survivor.desk.y + 24 <= 300);
  assert.deepEqual(Array.from(survivor.home), [survivor.desk.x, survivor.desk.y]);
  assert.ok(survivor.path.every(([x, y]) => !s.blocked(x, y, 5)));
});

test('vertical extension keeps cafe bounds and wall while allowing routes to lower desks', () => {
  const s = scene();
  s.reconcile({ agents: Array.from({ length: 30 }, (_, i) => agent(String(i))) });
  const d = s.desks.find(d => d.y > 332);
  assert.ok(d);
  assert.equal(s.blocked(d.x, d.y, 5), false);
  assert.equal(s.blocked(268, d.y, 5), true);
  assert.equal(s.blocked(320, d.y, 5), true);
  const path = s.route(436, 310, d.x, d.y, 5);
  assert.ok(path.length > 1);
  assert.ok(path.every(([x, y]) => !s.blocked(x, y, 5)));
  assert.deepEqual(Array.from(path.at(-1)), [d.x, d.y]);
});

test('shrinking leaves the barista at its counter and preserves flight paths', () => {
  for (const flying of [false, true]) {
    const s = scene();
    s.reconcile({ agents: Array.from({ length: 15 }, (_, i) => agent(String(i))) });
    if (flying) { s.dragon.x = 310; s.dragon.y = 180; s.dragon.dest = 'bar'; s.dragon.mode = 'fly'; s.dragon.path = [[338, 196]]; }
    const before = JSON.stringify({ ...s.dragon, frames: undefined });
    s.desks.splice(0);
    s.shrinkLab();
    assert.equal(s.layout().labSteps, 0);
    assert.equal(JSON.stringify({ ...s.dragon, frames: undefined }), before);
    assert.equal(s.dragonAtBar(), !flying);
  }
});

test('dragon reports aggregate factory state', () => {
  const s = scene();
  s.setData({ agents: [] }); s.update(.1, 0);
  assert.equal(s.dragon.signal, 'empty');
  s.setData({ agents: [agent('busy')] }); s.update(.1, 1);
  assert.equal(s.dragon.signal, 'active');
  s.update(.1, 1.1);
  assert.ok(s.dragon.roastUntil > 1);
  s.setData({ agents: [agent('help', 'attention')] }); s.update(.1, 2);
  assert.equal(s.dragon.signal, 'attention');
  assert.equal(s.dragon.dest, 'alert');
  assert.equal(s.dragon.mode, 'fly');
});

test('crystal fills red and flares above 75 percent cpu', () => {
  const s = scene(), fills = [];
  s.ctx.fillRect = (...args) => fills.push({ args, color: s.ctx.fillStyle });
  s.SP.PR.crystal(s.ctx, 216, 98, 1, 50);
  assert.ok(fills.some(x => x.color === '#d84a5f'));
  assert.ok(fills.some(x => x.color === '#8fd0ff'));
  assert.ok(fills.some(x => x.args[2] === 10), 'crystal orb reaches ten pixels wide');
  fills.length = 0;
  s.SP.PR.crystal(s.ctx, 216, 98, 1, 80);
  assert.ok(fills.some(x => x.color === '#ff4a4a'));
  assert.ok(fills.some(x => x.color === '#ffe89a'));
});

test('crystal colored area matches usage across the full range', () => {
  const s = scene(), fills = [];
  s.ctx.fillRect = (...args) => fills.push({ args, color: s.ctx.fillStyle });
  for (const usage of [-10, 0, 1, 5, 10, 25, 33.3, 50, 75, 80, 99, 100, 110]) {
    fills.length = 0;
    s.SP.PR.crystal(s.ctx, 0, 0, 0, usage);
    const liquid = fills.filter(f => ['#d84a5f', '#ff4a4a'].includes(f.color));
    const area = liquid.reduce((sum, { args: [, , w, h] }) => sum + w * h, 0);
    assert.ok(Math.abs(area / 68 * 100 - Math.max(0, Math.min(100, usage))) < 1e-10,
      `colored area matches ${usage}% usage`);
    for (const { args: [x, y, w, h] } of liquid) {
      assert.ok(y >= 1 && y + h <= 9 && h > 0 && h <= 1);
      assert.equal(x + w / 2, 7);
    }
  }
});

test('pixel font renders percent signs instead of question marks', () => {
  const s = scene(), render = text => {
    s.calls.length = 0; s.SP.drawText(s.ctx, 0, 0, text, '#fff');
    return s.calls.filter(c => c[0] === 'fillRect').map(c => c.slice(1));
  };
  assert.notDeepEqual(render('%'), render('?'));
});

test('text sprites retain glyphs across colors and scales and bound old labels', () => {
  const s = scene(), render = (text, color = '#fff', scale = 1) => {
    s.calls.length = 0;
    s.SP.drawText(s.ctx, 0, 0, text, color, scale);
    return s.calls.find(c => c[0] === 'drawImage')[1];
  };
  const first = render('CACHE');
  assert.equal(render('CACHE'), first);
  assert.equal(first.width, s.SP.textW('CACHE'));
  assert.notEqual(render('CACHE', '#f00'), first);
  assert.equal(render('CACHE', '#fff', 3).width, first.width * 3);
  assert.equal(s.SP.textW('É→…'), s.SP.textW('E>…'));
  for (let i = 0; i < 1100; i++) render(String(i));
  assert.notEqual(render('CACHE'), first);
});

test('all resource balls have separate hit targets and capacity tooltips', () => {
  const s = scene();
  s.setData({ resources: {
    local: { host: 'local-test', cpu: 50, cores: 12, memoryUsed: 8 * 2**30, memoryTotal: 32 * 2**30, diskUsed: 100 * 2**30, diskTotal: 500 * 2**30 },
    remote: { host: 'mage-tower', cpu: 80, cores: 64, memoryUsed: 64 * 2**30, memoryTotal: 128 * 2**30, diskUsed: 900 * 2**30, diskTotal: 1000 * 2**30 },
  } });
  const { S } = s.layout();
  assert.equal(s.RESOURCE_BALLS.length, 6);
  for (const ball of s.RESOURCE_BALLS) {
    assert.equal(s.pickAt({ clientX: (ball.x + 7) * S, clientY: (ball.y + 5) * S }), ball.id);
    s.showResourceTip(ball, 0, 0);
    assert.match(s.element.innerHTML, ball.origin === 'local' ? /local-test/ : /mage-tower/);
    assert.match(s.element.innerHTML, ball.metric === 'cpu' ? /LOGICAL CORES/ : ball.metric === 'memory' ? /GiB RAM/ : /GiB DISK/);
    assert.ok(s.blocked(ball.x + 7, ball.y + 15, 5), 'walking actors avoid each pedestal');
  }
  assert.equal(s.ballReading(s.RESOURCE_BALLS[2]), 25);
  assert.equal(s.ballReading(s.RESOURCE_BALLS[4]), 20);
  assert.equal(s.ballReading(s.RESOURCE_BALLS[5]), 90);
  s.setData({ resources: { local: {} } });
  s.showResourceTip(s.RESOURCE_BALLS[3], 0, 0);
  assert.match(s.element.innerHTML, /USAGE UNAVAILABLE/);
  assert.match(s.element.innerHTML, /MEMORY CAPACITY UNAVAILABLE/);
  s.showResourceTip(s.RESOURCE_BALLS[5], 0, 0);
  assert.match(s.element.innerHTML, /USAGE UNAVAILABLE/);
  assert.match(s.element.innerHTML, /DISK CAPACITY UNAVAILABLE/);
});

test('memory crystal remains blue at high usage', () => {
  const s = scene(), fills = [];
  s.ctx.fillRect = () => fills.push(s.ctx.fillStyle);
  const ball = s.RESOURCE_BALLS.find(b => b.metric === 'memory');
  s.SP.PR.crystal(s.ctx, ball.x, ball.y, 1, 0, ball.color, ball.hotColor, ball.accents);
  assert.ok(fills.includes('#8fd0ff'));
  assert.ok(!fills.includes(ball.color));
  fills.length = 0;
  s.SP.PR.crystal(s.ctx, ball.x, ball.y, 1, 80, ball.color, ball.hotColor, ball.accents);
  assert.ok(fills.includes('#8fd0ff'));
  assert.ok(fills.includes('#3972d5'));
  assert.ok(!fills.includes('#ff4a4a'));
});

test('missives fly once, even when the recipient is resolved later', () => {
  const s = scene(), agents = [agent('a', 'waiting'), agent('b', 'waiting')];
  s.reconcile({ agents });
  const said = to => ({ now: 100, agents: [{ ...agents[0], missives: [{ ts: 90, to, text: 'hi' }] }, agents[1]] });
  s.launchMissives({ now: 100, agents });
  s.launchMissives(said(null));
  s.launchMissives(said('b'));
  assert.equal(s.BIRDS.length, 1);
  const fresh = scene();
  fresh.reconcile({ agents });
  fresh.launchMissives(said('b'));  // what was said before the page opened stays on the ground
  assert.equal(fresh.BIRDS.length, 0);
});
test('shell command classes drive status lines and emotes', () => {
  const s = scene(), cases = [['test', 'TESTING', 'flask'], ['search', 'SCOURING', 'search'], ['wait', 'WAITING FOR A RUN', 'hourglass'],
    ['push', 'SUBMITTING WITH GIT', 'write'], ['git', 'CONSULTING THE ANNALS', 'scroll']];
  for (const [act, line, emote] of cases) {
    const a = { ...agent(act), act, detail: 'cmd' };
    s.reconcile({ agents: [a] });
    assert.equal(s.statusLine(a, s.wizards.get(act)), line + ': cmd');
    assert.equal(s.emoteFor(s.wizards.get(act)), emote);
  }
});
test('epithets are earned from transcript facts, most notable first', () => {
  const s = scene();
  assert.equal(s.earned({ feats: { search: 39 } }), undefined);
  assert.equal(s.earned({ feats: { search: 52, rebase: 1 } }).title, 'THE REBASED');
  assert.equal(s.earned({ feats: { search: 52 } }).why, '52 SEARCHES');
  assert.equal(s.earned({ feats: { push: 1 }, cost: { added: 3, removed: 1 } }).title, 'THE SMALL DIFF');
  assert.equal(s.earned({ feats: { push: 1 }, cost: { added: 0, removed: 0 } }).title, 'SHIPWRIGHT');
});
test('remote crystals ignore local agents and strays until a remote host reports', () => {
  const s = scene(), ghosts = [];
  s.SP.PR.ghost = (g, x) => ghosts.push(x);
  s.setData({ agents: [{ ...agent('a'), load: { cpu: 50, rss: 2 ** 30, procs: 3, ports: [] } }], orphans: [{ pid: 7, cmd: 'vite' }],
    resources: { local: { host: 'here', cpu: 10 }, remote: {} } });
  s.drawStrays(0);
  assert.equal(ghosts.length, 1);
  const crystal = origin => s.RESOURCE_BALLS.find(b => b.origin === origin && b.metric === 'cpu');
  s.showResourceTip(crystal('remote'), 0, 0);
  assert.doesNotMatch(s.element.innerHTML, /BIGGEST DRAW|STRAY/);
  s.showResourceTip(crystal('local'), 0, 0);
  assert.match(s.element.innerHTML, /BIGGEST DRAW/);
  assert.match(s.element.innerHTML, /1 STRAY PROCESS/);
});
