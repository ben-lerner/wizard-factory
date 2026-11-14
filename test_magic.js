// Run with node --test test_magic.js. Plays the cafe's Magic rules engine without a scene.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('static/magic.js', 'utf8'), sandbox);
const { CARDS, deck, newGame, pay } = sandbox.window.MAGIC;
const rng = seed => () => { seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const COLORS = [['R'], ['U'], ['G'], ['W'], ['B'], ['R', 'G'], ['U', 'W'], ['B', 'R'], ['G', 'W'], ['U', 'B'], ['R', 'U']];
function run(players, seed, stacked) {
  const s = newGame(players, rng(seed), stacked), events = [];
  for (let step = s.play.next(); !step.done; step = s.play.next()) {
    events.push(step.value);
    assert.ok(events.length < 4000, 'the duel ends');
  }
  return { s, events };
}
const duelists = seed => [0, 1].map(i => ({ name: `P${i}`, colors: COLORS[(seed * 7 + i * 3) % COLORS.length], demon: i === 1 && seed % 3 === 0 }));

test('seeded duels end with a winner and well-formed events', () => {
  for (let seed = 1; seed <= 250; seed++) {
    const { s, events } = run(duelists(seed), seed);
    assert.ok(s.winner === 0 || s.winner === 1);
    assert.equal(events.at(-1).type, 'win');
    assert.ok(events.every(e => typeof e.type === 'string' && e.dur > 0));
    const loser = s.sides[1 - s.winner];
    assert.ok(loser.life <= 0 || !loser.library.length || s.turn > 40, `seed ${seed}: the loser has a reason to lose`);
    for (const me of s.sides) for (const c of me.field) assert.ok(c.type !== 'instant' && c.type !== 'sorcery');
  }
});

test('the card pool shows up in play, including the stack and combat tricks', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 400; seed++) for (const e of run(duelists(seed), seed).events) {
    seen.add(e.type);
    if (e.type === 'cast') seen.add('cast:' + e.card.key);
  }
  for (const type of ['shuffle', 'roll', 'draw', 'mulligan', 'land', 'enter', 'attack', 'block', 'damage', 'die', 'pass',
    'counter', 'bolt', 'fireball', 'swords', 'terror', 'wrath', 'growth', 'ritual', 'recall', 'ping', 'breath', 'discard', 'devour'])
    assert.ok(seen.has(type), `${type} happens`);
  for (const key of Object.keys(CARDS).filter(k => CARDS[k].type !== 'land' && !['lotus', 'channel'].includes(k)))
    assert.ok(seen.has('cast:' + key), `${key} gets cast`);
});

test('decks hold 13 basics and 17 spells, at most four of each', () => {
  for (const colors of COLORS) for (let seed = 1; seed < 30; seed++) {
    const cards = deck(colors, rng(seed), true), counts = {};
    for (const key of cards) counts[key] = (counts[key] || 0) + 1;
    assert.equal(cards.length, 30);
    assert.equal(cards.filter(key => CARDS[key].type === 'land').length, 13);
    assert.ok(cards.every(key => CARDS[key].type === 'land' || key === 'lotus' || colors.includes(CARDS[key].color)));
    assert.ok(Object.entries(counts).every(([key, n]) => CARDS[key].type === 'land' || n <= 4));
  }
  const pits = demon => Array.from({ length: 60 }, (_, seed) => deck(['B'], rng(seed), demon)).flat().filter(key => key === 'pit').length;
  assert.equal(pits(false), 0);
  assert.ok(pits(true) > 0);
});

test('Black Lotus, Channel and Fireball win on the first turn', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { s, events } = run([{ name: 'A', colors: ['G'] }, { name: 'B', colors: ['W'] }], seed, 0);
    const fireball = events.find(e => e.type === 'fireball');
    assert.equal(s.winner, 0);
    assert.ok(s.turn <= 2);
    assert.ok(events.some(e => e.type === 'channel' && e.x === 19));
    assert.ok(fireball.x >= 20 && fireball.target === s.sides[1]);
    assert.equal(s.sides[0].life, 1);
  }
});

test('Counterspell answers a dragon and flying attackers meet only flying blockers', () => {
  const mountains = Array(25).fill('mountain'), islands = Array(25).fill('island');
  const { events } = run([
    { name: 'RED', colors: ['R'], cards: [...mountains.slice(0, 5), 'shivan', 'shivan', 'mountain', 'shivan', ...mountains] },
    { name: 'BLUE', colors: ['U'], cards: [...islands.slice(0, 5), 'counter', 'counter', ...islands] },
  ], 3);
  assert.deepEqual(events.filter(e => e.type === 'cast').map(e => e.card.key), ['shivan', 'counter', 'shivan', 'counter', 'shivan']);
  assert.ok(events.some(e => e.type === 'counter' && e.target.key === 'shivan'));
  assert.ok(events.some(e => e.type === 'enter' && e.card.key === 'shivan'));
  for (let seed = 1; seed <= 150; seed++) for (const e of run(duelists(seed), seed).events)
    if (e.type === 'block') for (const [a, b] of e.pairs) assert.ok(!a.fly || b.fly);
});

test('Lord of the Pit eats its own side when it has nothing else to eat', () => {
  const { s, events } = run([
    { name: 'DEMON', colors: ['B'], demon: true, cards: [...Array(7).fill('swamp'), 'pit', ...Array(20).fill('swamp')] },
    { name: 'PLAINS', colors: ['W'], cards: Array(30).fill('plains') },
  ], 5);
  const devour = events.find(e => e.type === 'devour');
  assert.equal(devour.target, s.sides[0]);
  assert.ok(events.some(e => e.type === 'damage' && e.hits.some(([a, t, n]) => a.key === 'pit' && t === s.sides[1] && n === 7)));
});

test('mana creatures wait out summoning sickness, and Black Lotus floats what a spell leaves unused', () => {
  const fresh = (key, more) => ({ ...CARDS[key], tapped: false, sick: false, ...more });
  const side = field => ({ hand: [], library: [], grave: [], pool: [], field });
  const elves = fresh('elves', { sick: true }), green = side([fresh('forest'), elves]);
  assert.equal(pay(green, CARDS.bears, 0, false), null, 'Elves cast this turn add no mana');
  elves.sick = false;
  assert.ok(pay(green, CARDS.bears));
  assert.ok(green.field.every(c => c.tapped));
  const lotus = fresh('lotus'), rich = side([fresh('forest'), fresh('forest'), fresh('forest'), fresh('forest'), lotus]);
  assert.equal(pay(rich, CARDS.wurm).lotus, lotus);
  assert.deepEqual([...rich.pool], ['*']);
  assert.ok(rich.grave.includes(lotus) && !rich.field.includes(lotus));
  assert.ok(pay(rich, CARDS.goblin), 'the leftover Lotus mana pays for a red spell');
  assert.equal(rich.pool.length, 0);
});

test("a defender's leftover Lotus mana from a Counterspell does not reach their own turn", () => {
  const s = newGame([
    { name: 'RED', colors: ['R'], cards: [...Array(5).fill('mountain'), 'shivan', ...Array(30).fill('mountain')] },
    { name: 'WHITE', colors: ['W'], cards: ['lotus', 'counter', ...Array(30).fill('plains')] },
  ], rng(4));
  const events = [];
  for (let step = s.play.next(); !step.done; step = s.play.next()) {
    const e = step.value;
    events.push(e);
    if (e.type === 'draw' && s.turn > 1) assert.equal(s.sides[e.side].pool.length, 0, `turn ${s.turn} starts with no floating mana`);
  }
  assert.ok(events.some(e => e.type === 'cast' && e.card.key === 'counter' && e.lotus), 'Black Lotus pays for the Counterspell');
});
