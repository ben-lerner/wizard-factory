// Run with node --test test_desks.js. Exercise the real scene without a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function scene() {
  const calls = [];
  const ctx = new Proxy({}, { get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]) });
  const element = { getContext: () => ctx, toDataURL: () => '', addEventListener() {}, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 544 }), clientLeft: 0, clientTop: 0, offsetWidth: 200, offsetHeight: 80 };
  const sandbox = { console, ResizeObserver: class { observe() {} }, document: { querySelector: () => element, createElement: () => element }, window: { addEventListener() {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('static/sprites.js', 'utf8'), sandbox);
  sandbox.SP = sandbox.window.SP;
  for (const name of ['drawText', 'drawEmote']) {
    const draw = sandbox.SP[name];
    sandbox.SP[name] = (...args) => { calls.push([name, ...args.slice(1)]); draw(...args); };
  }
  const source = fs.readFileSync('static/game.js', 'utf8').split('  // ---------- logo ----------')[0];
  vm.runInContext(source + 'window.test = { reconcile, update, wizards, desks, separateActors, draw, drawWorkDesk, drawUsageProbes, showUsageTip, pickAt, usageProbe, castSpell, updateSpells, drawGlowingEyes, cloudAnchor, SPELLS, PARTS, COURT, startGame, updateRally, rallyPosition, drawCourt, BREW, updateBrew, RITUALS, blocked, route, dragon, dragonAtBar, shrinkLab, layout: () => ({ labExtra, labDown, labSteps, S }), setData: data => { lastData = data; } }; })();', sandbox);
  return { ...sandbox.window.test, calls, element, SP: sandbox.SP, ctx };
}
const agent = (id, status = 'working', parent = null) => ({ id, status, parent, kind: parent ? 'sub' : 'main', title: 'Fix wizard desks', tool: 'Bash', detail: 'npm test' });
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
test('questions release desks, running commands do not', () => {
  const s = scene(), a = agent('main');
  s.reconcile({ agents: [a] });
  const w = s.wizards.get(a.id);
  assert.ok(w.desk);
  s.reconcile({ agents: [{ ...a, tool: 'request_user_input' }] });
  assert.equal(w.station, 'cafe');
  assert.equal(w.desk, null);
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
test('crowded scenes allocate distinct desks', () => {
  const s = scene();
  s.reconcile({ agents: Array.from({ length: 30 }, (_, i) => agent(String(i))) });
  assert.equal(new Set(s.desks.map(d => `${d.x},${d.y}`)).size, 30);
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
  assert.ok(bubble >= 0 && title > bubble && bottle > title);
  assert.equal(s.calls.slice(bottle).some(c => c[0] === 'drawImage'), false);
});
test('usage tooltips omit zero resets and retain positive or unknown credits', () => {
  const s = scene();
  for (const count of [0, 1, 2, null]) {
    s.showUsageTip({ i: 0, q: {name:'Test', origins:[], left:50, resets_at:Date.now()/1000+864000, resets_left:count}}, 0, 0);
    if (count === 0) assert.doesNotMatch(s.element.innerHTML, /RESETS? LEFT/);
    else assert.match(s.element.innerHTML, new RegExp((count ?? '\\?') + ' RESETS? LEFT'));
  }
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
test('Claude and Fable share one cylinder with half-height liquid segments', () => {
  const s = scene(), bottles = [];
  s.SP.PR.quotaVat = (g, x, y, shape, fill, color) => bottles.push({ x, y, shape, fill, color });
  s.setData({ quotas: [
    { id: 'claude:active', name: 'Claude', provider: 'claude', origins: ['local'], left: 100, resets_left: null },
    { id: 'claude:Fable', name: 'Fable', provider: 'claude', origins: ['remote'], left: 90, resets_left: null },
  ] });
  s.drawUsageProbes(0);
  assert.equal(bottles.length, 1);
  assert.equal(bottles[0].shape, 'vat');
  assert.deepEqual([...bottles[0].fill].map(part => part.value), [50, 45]);
  assert.notEqual(bottles[0].fill[0].color, bottles[0].fill[1].color);
  const combined = s.usageProbe('usage:claude:active');
  assert.equal(combined.q.name, 'Claude + Fable');
  assert.equal(combined.q.left, 95);
  assert.equal(s.usageProbe('usage:claude:Fable').q.left, combined.q.left);
});
test('reset countdowns round up hours and retain minutes below one hour', () => {
  const s = scene();
  for (const [seconds, label] of [[15 * 3600 + 53 * 60, '16H'], [3601, '2H'], [3599, '59M'], [30, '0M'], [-1, '0M'], [86400, '24H'], [2 * 86400, '2D']]) {
    s.showUsageTip({ q: { name: 'Test', origins: [], resets_left: 0, resets_at: Date.now() / 1000 + seconds } }, 0, 0);
    assert.ok(s.element.innerHTML.includes(`RESETS IN ${label}<`), s.element.innerHTML);
  }
});
test('desk decorations are stable per wizard and vary between wizards', () => {
  const s = scene();
  const render = id => {
    s.calls.length = 0;
    s.SP.PR.deskDecor(s.ctx, 100, 100, 48, s.SP.hash(id + ':desk'), null, 1);
    return JSON.stringify(s.calls);
  };
  const first = render('one');
  assert.equal(render('one'), first);
  assert.notEqual(render('two'), first);
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


test('desk decorations include regular and rotating black holes', () => {
  const s = scene(), variants = new Set();
  s.SP.PR.blackHole = (g, x, y, rotating) => variants.add(rotating);
  for (let seed = 1; seed <= 100; seed++) s.SP.PR.deskDecor(s.ctx, 100, 100, 48, seed, null, 1);
  assert.deepEqual([...variants].sort(), [false, true]);
});
test('only rotating black holes have an animated white ring', () => {
  const s = scene();
  const render = (rotating, angle) => {
    const pixels = [], ctx = { fillStyle: '', fillRect(...args) { pixels.push([this.fillStyle, ...args]); } };
    s.SP.PR.blackHole(ctx, 30, 30, rotating, angle);
    return pixels;
  };
  const regular = render(false, 0), rotating = render(true, 0);
  assert.ok(regular.some(p => p[0] === '#030208'));
  assert.equal(regular.some(p => p[0] === '#ffffff'), false);
  assert.deepEqual(regular, render(false, 1));
  assert.ok(rotating.some(p => p[0] === '#ffffff'));
  assert.notDeepEqual(rotating, render(true, 1));
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
test('desk experiments include only storms, moons and crystals', () => {
  const s = scene(), kinds = new Set();
  s.SP.PR.experiment = (g,x,y,kind) => kinds.add(kind);
  for (let seed = 1; seed < 200; seed++) s.SP.PR.deskDecor(s.ctx,100,100,48,seed,null,10);
  assert.deepEqual([...kinds].sort(), [5,6,7]);
});
test('desk pets are deterministic and react to completion', () => {
  const s = scene();
  const render = excited => {
    s.calls.length = 0;
    s.SP.PR.deskPet(s.ctx,100,100,1234,1,excited);
    return JSON.stringify(s.calls);
  };
  const idle = render(false);
  assert.equal(render(false),idle);
  assert.notEqual(render(true),idle);
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
test('One Ring is a possible decoration with animated fiery lettering and an open center', () => {
  const s = scene(), draw = s.SP.PR.oneRing;
  let count = 0;
  s.SP.PR.oneRing = () => count++;
  for (let seed = 1; seed <= 100; seed++) s.SP.PR.deskDecor(s.ctx, 100, 100, 48, seed, null, 1);
  assert.ok(count > 0 && count < 100);
  const render = angle => {
    const pixels = [], ctx = { fillStyle: '', fillRect(...args) { pixels.push([this.fillStyle, ...args]); } };
    draw(ctx, 30, 30, angle);
    return pixels;
  };
  const first = render(0);
  assert.ok(first.some(p => p[0] === '#ff6b25'));
  assert.equal(first.some(p => p[1] === 30 && p[2] === 30), false);
  assert.notDeepEqual(first, render(1));
});
test('Claude quota tooltip labels the provider without reset credits', () => {
  const s = scene();
  s.showUsageTip({ i: 3, q: { name: 'Claude', provider: 'claude', origins: ['remote'], left: 65, resets_left: null } }, 0, 0);
  assert.match(s.element.innerHTML, /<span>CLAUDE<\/span>/);
  assert.match(s.element.innerHTML, /REMOTE/);
  assert.doesNotMatch(s.element.innerHTML, /RESETS? LEFT|CODEX/);
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
  for (const [d, x, y] of original) assert.deepEqual([d.x, d.y], [x, y]);
  const fixtures = [[56, 150, 30, 26], [8, 58, 26, 70], [88, 42, 34, 20],
    [216, 98, 16, 24], [160, 164, 52, 26], [124, 30, 136, 58]];
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
  for (const [left, error, arcs, strokes] of [[0, null, 1, 2], [null, null, 0, 2], [0, 'offline', 0, 2], [50, null, 0, 0]]) {
    s.setData({ quotas: [{ id: 'a', origins: [], left, error }] });
    s.calls.length = 0;
    colors.length = 0;
    s.drawUsageProbes(0);
    assert.equal(s.calls.filter(c => c[0] === 'arc').length, arcs);
    assert.equal(colors.length, strokes);
    assert.ok(colors.every(color => color === s.usageProbe('usage:a').color));
  }
});

test('laboratory fills its current floor before growing two rows then a column', () => {
  const s = scene(), agents = [], growth = [];
  const fixtures = [[56, 150, 30, 26], [8, 58, 26, 70], [88, 42, 34, 20],
    [216, 98, 16, 24], [160, 164, 52, 26], [124, 30, 136, 58]];
  while (growth.length < 6) {
    const before = s.layout(), occupied = [...fixtures, ...s.desks.map(d => [d.x - 32, d.y - 30, 64, 54])];
    agents.push(agent(String(agents.length)));
    s.reconcile({ agents });
    const after = s.layout();
    if (after.labSteps === before.labSteps) continue;
    assert.equal(after.labSteps, before.labSteps + 1);
    for (let y = 64; y <= 216 + before.labDown; y += 4) for (let x = 40 - before.labExtra; x <= 232; x += 8)
      assert.ok(occupied.some(([bx, by, w, h]) => x - 32 < bx + w && x + 32 > bx && y - 30 < by + h && y + 24 > by));
    growth.push([after.labExtra - before.labExtra, after.labDown - before.labDown]);
  }
  assert.deepEqual(growth, [[0, 60], [0, 60], [72, 0], [0, 60], [0, 60], [72, 0]]);
});

test('laboratory shrinks after removed desks fade and compacts a surviving outer desk', () => {
  const s = scene(), agents = Array.from({ length: 25 }, (_, i) => agent(String(i)));
  s.reconcile({ agents });
  s.update(.4, 0);
  const survivor = s.desks.find(d => d.y > 240).w;
  s.reconcile({ agents: [survivor.a] });
  assert.ok(s.layout().labSteps > 0);
  s.update(.6, .6);
  assert.equal(s.desks.length, 1);
  assert.equal(s.layout().labSteps, 0);
  assert.equal(s.layout().labExtra, 0);
  assert.equal(s.layout().labDown, 0);
  assert.ok(survivor.desk.y + 24 <= 240);
  assert.deepEqual(Array.from(survivor.home), [survivor.desk.x, survivor.desk.y]);
  assert.ok(survivor.path.every(([x, y]) => !s.blocked(x, y, 5)));
});

test('vertical extension keeps cafe bounds and wall while allowing routes to lower desks', () => {
  const s = scene();
  s.reconcile({ agents: Array.from({ length: 15 }, (_, i) => agent(String(i))) });
  const d = s.desks.find(d => d.y > 272);
  assert.ok(d);
  assert.equal(s.blocked(d.x, d.y, 5), false);
  assert.equal(s.blocked(268, d.y, 5), true);
  assert.equal(s.blocked(320, d.y, 5), true);
  const path = s.route(436, 250, d.x, d.y, 5);
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
