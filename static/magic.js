// magic.js — pocket Magic: The Gathering for the cafe table: classic cards, 30-card decks, a rules
// subset and duelists with simple instincts. A game is a generator yielding one animation event per
// visible step ({ type, side, dur, ... }); the scene animates each event, then asks for the next.
'use strict';
window.MAGIC = (() => {
  const land = (name, color) => ({ name, type: 'land', cost: '', color, text: `TAP: ADD ${color}.` });
  const beast = (name, cost, p, t, sub, more) => ({ name, type: 'creature', cost, p, t, sub, ...more });
  const spell = (name, cost, type, text) => ({ name, type, cost, text });
  const CARDS = {
    plains: land('PLAINS', 'W'), island: land('ISLAND', 'U'), swamp: land('SWAMP', 'B'),
    mountain: land('MOUNTAIN', 'R'), forest: land('FOREST', 'G'),
    lotus: { name: 'BLACK LOTUS', type: 'artifact', cost: '0', text: 'SACRIFICE: ADD THREE MANA OF ANY ONE COLOR.' },
    lions: beast('SAVANNAH LIONS', 'W', 2, 1, 'CAT'),
    unicorn: beast('PEARLED UNICORN', '2W', 2, 2, 'UNICORN'),
    serra: beast('SERRA ANGEL', '3WW', 4, 4, 'ANGEL', { fly: true, vigil: true, text: 'FLYING, VIGILANCE.' }),
    swords: spell('SWORDS TO PLOWSHARES', 'W', 'instant', 'EXILE TARGET CREATURE. ITS CONTROLLER GAINS LIFE EQUAL TO ITS POWER.'),
    wrath: spell('WRATH OF GOD', '2WW', 'sorcery', 'DESTROY ALL CREATURES.'),
    merfolk: beast('MERFOLK OF THE PEARL TRIDENT', 'U', 1, 1, 'MERFOLK'),
    sorcerer: beast('PRODIGAL SORCERER', '2U', 1, 1, 'HUMAN WIZARD', { ping: true, text: 'TAP: 1 DAMAGE TO ANY TARGET.' }),
    airel: beast('AIR ELEMENTAL', '3UU', 4, 4, 'ELEMENTAL', { fly: true, text: 'FLYING.' }),
    counter: spell('COUNTERSPELL', 'UU', 'instant', 'COUNTER TARGET SPELL.'),
    recall: spell('ANCESTRAL RECALL', 'U', 'instant', 'DRAW THREE CARDS.'),
    ritual: spell('DARK RITUAL', 'B', 'instant', 'ADD BBB.'),
    specter: beast('HYPNOTIC SPECTER', '1BB', 2, 2, 'SPECTER', { fly: true, text: 'FLYING. A PLAYER IT DAMAGES DISCARDS AT RANDOM.' }),
    zombies: beast('SCATHE ZOMBIES', '2B', 2, 2, 'ZOMBIE'),
    sengir: beast('SENGIR VAMPIRE', '3BB', 4, 4, 'VAMPIRE', { fly: true, text: 'FLYING. GROWS WHEN A CREATURE IT DAMAGED DIES.' }),
    pit: beast('LORD OF THE PIT', '4BBB', 7, 7, 'DEMON', { fly: true, trample: true,
      text: 'FLYING, TRAMPLE. UPKEEP: SACRIFICE ANOTHER CREATURE OR IT DEALS 7 DAMAGE TO YOU.' }),
    terror: spell('TERROR', '1B', 'instant', 'DESTROY TARGET NONBLACK CREATURE.'),
    goblin: beast("MONS'S GOBLIN RAIDERS", 'R', 1, 1, 'GOBLIN'),
    ogre: beast('GRAY OGRE', '2R', 2, 2, 'OGRE'),
    giant: beast('HILL GIANT', '3R', 3, 3, 'GIANT'),
    shivan: beast('SHIVAN DRAGON', '4RR', 5, 5, 'DRAGON', { fly: true, breath: true, text: 'FLYING. R: +1/+0 UNTIL END OF TURN.' }),
    bolt: spell('LIGHTNING BOLT', 'R', 'instant', 'DEALS 3 DAMAGE TO ANY TARGET.'),
    fireball: spell('FIREBALL', 'XR', 'sorcery', 'DEALS X DAMAGE TO ANY TARGET.'),
    elves: beast('LLANOWAR ELVES', 'G', 1, 1, 'ELF DRUID', { mana: 'G', text: 'TAP: ADD G.' }),
    birds: beast('BIRDS OF PARADISE', 'G', 0, 1, 'BIRD', { fly: true, mana: '*', text: 'FLYING. TAP: ADD ONE MANA OF ANY COLOR.' }),
    bears: beast('GRIZZLY BEARS', '1G', 2, 2, 'BEAR'),
    wurm: beast('CRAW WURM', '4GG', 6, 4, 'WURM'),
    growth: spell('GIANT GROWTH', 'G', 'instant', 'TARGET CREATURE GETS +3/+3 UNTIL END OF TURN.'),
    channel: spell('CHANNEL', 'GG', 'sorcery', 'PAY ANY AMOUNT OF LIFE: ADD THAT MUCH COLORLESS MANA.'),
  };
  for (const [key, c] of Object.entries(CARDS)) Object.assign(c, { key, color: c.color ?? (c.cost.match(/[WUBRG]/) || [''])[0] });
  const BASIC = { W: 'plains', U: 'island', B: 'swamp', R: 'mountain', G: 'forest' };
  // Each colour's half-deck: two-colour decks take both halves, mono-colour decks take theirs twice.
  const POOLS = {
    W: ['lions', 'lions', 'unicorn', 'unicorn', 'serra', 'serra', 'swords', 'swords', 'wrath'],
    U: ['merfolk', 'merfolk', 'sorcerer', 'sorcerer', 'airel', 'airel', 'counter', 'counter', 'recall'],
    B: ['ritual', 'specter', 'specter', 'zombies', 'zombies', 'sengir', 'sengir', 'terror', 'terror'],
    R: ['goblin', 'goblin', 'ogre', 'giant', 'giant', 'shivan', 'bolt', 'bolt', 'fireball'],
    G: ['elves', 'elves', 'birds', 'bears', 'bears', 'wurm', 'wurm', 'growth', 'growth'],
  };
  const shuffle = (a, r) => {
    for (let i = a.length - 1; i > 0; i--) { const j = r() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  // 13 basics and 17 spells; only demons summon Lord of the Pit, and one deck in twelve hides a Black Lotus.
  function deck(colors, r, demon) {
    const pool = colors.flatMap(c => demon && c === 'B' ? [...POOLS.B, 'pit'] : POOLS[c]);
    const spells = shuffle(colors.length > 1 ? pool : [...pool, ...pool], r).slice(0, 17);
    if (r() < .08) spells[0] = 'lotus';
    return shuffle([...spells, ...Array.from({ length: 13 }, (_, i) => BASIC[colors[i % colors.length]])], r);
  }

  const pips = c => c.cost.match(/[WUBRG]/g) || [];
  const cmc = c => +(c.cost.match(/\d+/) || 0) + pips(c).length;
  const isCreature = c => c.type === 'creature';
  const pow = c => c.p + c.pump + c.grown + c.fire;
  const tough = c => c.t + c.pump + c.grown;
  const value = c => pow(c) + tough(c) + (c.fly ? 3 : 0) + (c.ping || c.mana ? 2 : 0);
  const team = me => me.field.filter(isCreature);
  const sum = (cards, f) => cards.reduce((n, c) => n + f(c), 0);
  const board = me => sum(team(me), value);
  const isPlayer = target => 'life' in target;
  const FRESH = { tapped: false, sick: false, dmg: 0, pump: 0, grown: 0, fire: 0, attacking: false, blocked: null, bitBy: null };
  function move(me, c, to) {
    for (const zone of [me.hand, me.field, me.grave, me.library]) { const i = zone.indexOf(c); if (i >= 0) zone.splice(i, 1); }
    Object.assign(c, FRESH);
    to?.push(c);
  }
  const draw = (me, n) => me.hand.push(...me.library.splice(0, n));
  // Floating mana empties for both duelists when a phase ends, including Lotus leftovers from answering.
  const drain = s => { for (const me of s.sides) me.pool.length = 0; };
  const hurt = (target, n) => { if (isPlayer(target)) target.life -= n; else target.dmg += n; };

  // Mana units, cheapest to spend first: floating mana, lands, mana creatures, then Black Lotus.
  function sources(me) {
    const ready = me.field.filter(c => !c.tapped);
    return [...me.pool.map(c => ({ c })),
      ...ready.filter(c => c.type === 'land').map(src => ({ c: src.color, src })),
      ...ready.filter(c => c.mana && !c.sick).map(src => ({ c: src.mana, src })),
      ...ready.filter(c => c.key === 'lotus').flatMap(src => [1, 2, 3].map(() => ({ c: '*', src, lotus: true })))];
  }
  // Returns the units that pay for card (plus X), committing them unless asked not to; null if unaffordable.
  function pay(me, card, x = 0, commit = true, units = sources(me)) {
    const used = [], take = ok => { const u = units.find(u => !used.includes(u) && ok(u)); if (u) used.push(u); return u; };
    for (const p of pips(card)) if (!take(u => u.c === p) && !take(u => u.c === '*')) return null;
    for (let n = cmc(card) - pips(card).length + x; n > 0; n--) if (!take(u => u.c !== '*') && !take(() => true)) return null;
    if (!commit) return used;
    for (const u of used) if (!u.src) me.pool.splice(me.pool.indexOf(u.c), 1); else if (!u.lotus) u.src.tapped = true;
    const lotuses = [...new Set(used.filter(u => u.lotus).map(u => u.src))];
    for (const src of lotuses) {
      me.pool.push(...Array(3 - used.filter(u => u.src === src).length).fill('*'));
      move(me, src, me.grave);
    }
    return { used, lotus: lotuses[0] };
  }
  const maxX = (me, c) => { for (let x = sources(me).length - 1; x > 0; x--) if (pay(me, c, x, false)) return x; return 0; };
  const leavesCounter = (me, c, x) => {
    const units = sources(me), used = pay(me, c, x, false, units);
    return !!pay(me, CARDS.counter, 0, false, units.filter(u => !used.includes(u)));
  };

  function* settle(s) {
    const dead = s.sides.flatMap(team).filter(c => c.dmg >= tough(c));
    for (const c of dead) {
      if (c.bitBy && !dead.includes(c.bitBy) && s.sides[c.bitBy.side].field.includes(c.bitBy)) c.bitBy.grown++;
      move(s.sides[c.side], c, s.sides[c.side].grave);
    }
    if (dead.length) yield { type: 'die', cards: dead, dur: .9 };
    const lost = s.sides.filter(me => me.life <= 0);
    if (lost.length && s.winner === undefined) s.winner = lost.length > 1 ? 1 - s.active : 1 - lost[0].i;
  }
  function* cast(s, me, c, target, x, say) {
    const { lotus } = pay(me, c, x);
    me.hand.splice(me.hand.indexOf(c), 1);
    me.acted = true;
    s.stack.push({ c, me, target, x });
    s.last = c;
    yield { type: 'cast', side: me.i, card: c, target, x, lotus, say, dur: 1.3 };
  }
  // Counter the top of the stack? Defend our own spells, our creatures, our life, and big threats.
  function worth(s, who, { c, target, x }) {
    if (c.key === 'counter') return cmc(target.c) + target.x >= 2;
    if (c.key === 'wrath') return board(who) > board(s.sides[1 - who.i]);
    if (target === who) return (c.key === 'bolt' ? 3 : x) >= Math.min(who.life, 6);
    if (target && !isPlayer(target) && target.side === who.i) return value(target) >= 6;
    return (cmc(c) >= 3 || c.key === 'recall') && s.rng() < .85;
  }
  // Casts c, lets each duelist answer the top of the stack with Counterspell in turn, then resolves.
  function* play(s, me, c, target, x = 0, say = null) {
    const foe = s.sides[1 - me.i];
    if (!say && cmc(c) + x >= 4 && sources(foe).filter(u => u.c === 'U').length > 1 && s.rng() < .5) say = 'DOES IT RESOLVE?';
    yield* cast(s, me, c, target, x, say);
    for (let who = foe; ; who = s.sides[1 - who.i]) {
      const top = s.stack.at(-1), counter = who.hand.find(h => h.key === 'counter');
      if (!counter || !pay(who, counter, 0, false) || !worth(s, who, top)) break;
      yield* cast(s, who, counter, top, 0, s.rng() < .7 ? 'IN RESPONSE...' : null);
    }
    while (s.stack.length && s.winner === undefined) yield* resolve(s, s.stack.pop());
  }
  function* resolve(s, sp) {
    const { c, me, target } = sp, ev = { type: c.key, side: me.i, card: c, target, x: sp.x, dur: 1 };
    if (c.type === 'creature' || c.type === 'artifact') {
      me.field.push(c);
      c.sick = true;
      yield { ...ev, type: 'enter', dur: 1.1 };
      return;
    }
    me.grave.push(c);
    if (c.key === 'counter') {
      s.stack.splice(s.stack.indexOf(target), 1);
      target.me.grave.push(target.c);
      yield { ...ev, target: target.c, dur: 1.2 };
      return;
    }
    if (target && !isPlayer(target) && !s.sides[target.side].field.includes(target)) {
      yield { ...ev, type: 'fizzle', dur: .6 };
      return;
    }
    if (c.key === 'bolt') hurt(target, 3);
    else if (c.key === 'fireball') hurt(target, sp.x);
    else if (c.key === 'swords') { const owner = s.sides[target.side]; ev.x = pow(target); owner.life += ev.x; move(owner, target, null); }
    else if (c.key === 'terror') target.dmg = 99;
    else if (c.key === 'wrath') for (const t of s.sides.flatMap(team)) t.dmg = 99;
    else if (c.key === 'growth') target.pump += 3;
    else if (c.key === 'ritual') me.pool.push('B', 'B', 'B');
    else if (c.key === 'recall') draw(me, 3);
    else if (c.key === 'channel') { ev.x = me.life - 1; me.life = 1; me.pool.push(...Array(ev.x).fill('C')); }
    yield ev;
    yield* settle(s);
  }

  // ---------- the duelists' instincts ----------
  function burn(s, foe, n, face) {
    if (n >= foe.life) return { target: foe, score: 100 };
    const prey = team(foe).filter(c => tough(c) - c.dmg <= n).sort((a, b) => value(b) - value(a))[0];
    if (prey && value(prey) >= 4) return { target: prey, score: value(prey) * 3 };
    return (face || s.rng() < .2) && { target: foe, score: 4 };
  }
  function kill(foe, min, ok = () => true) {
    const prey = team(foe).filter(ok).sort((a, b) => value(b) - value(a))[0];
    return prey && value(prey) >= min && { target: prey, score: value(prey) * 3 };
  }
  // Scores for casting each card now; creatures default to 10 + mana value, and null means "hold it".
  const PLANS = {
    bolt: (s, me, foe) => { const p = burn(s, foe, 3); return p && { ...p, say: p.target.key === 'birds' ? 'BOLT THE BIRD' : null }; },
    fireball: (s, me, foe, x) => burn(s, foe, x, x >= 5),
    swords: (s, me, foe) => kill(foe, 8),
    terror: (s, me, foe) => kill(foe, 6, c => c.color !== 'B'),
    wrath: (s, me, foe) => board(foe) - board(me) >= 6 && { score: 50 },
    recall: () => ({ score: 30 }),
    ritual: (s, me) => me.hand.some(c => isCreature(c) && c.cost.includes('B') && !pay(me, c, 0, false) &&
      cmc(c) <= sources(me).length + 2) && { score: 9 },
    channel: (s, me, foe) => me.hand.some(c => c.key === 'fireball') && me.life + sources(me).length - 4 >= foe.life && { score: 200 },
    lotus: (s, me) => ({ score: me.hand.some(c => c.key === 'channel') ? 300 : 1 }),
    counter: () => null,
    growth: () => null,
  };
  function choose(s, me, foe) {
    let best = null;
    for (const c of me.hand) {
      if (c.type === 'land') continue;
      const x = c.cost.includes('X') ? maxX(me, c) : 0;
      if (c.cost.includes('X') ? !x : !pay(me, c, 0, false)) continue;
      const plan = c.key in PLANS ? PLANS[c.key](s, me, foe, x) : { score: 10 + cmc(c) };
      if (!plan || me.hold && c.key !== 'counter' && plan.score < 100 && !leavesCounter(me, c, x)) continue;
      if (!best || plan.score > best.score) best = { c, x, ...plan };
    }
    return best;
  }
  function pickLand(me) {
    const need = col => sum(me.hand, c => pips(c).filter(p => p === col).length) - me.field.filter(c => c.type === 'land' && c.color === col).length;
    return me.hand.filter(c => c.type === 'land').sort((a, b) => need(b.color) - need(a.color))[0];
  }
  function chooseAttackers(s, me, foe) {
    const ready = team(me).filter(c => !c.tapped && !c.sick && pow(c) > 0), guards = team(foe).filter(c => !c.tapped);
    return ready.filter(a => {
      const killers = guards.filter(b => (!a.fly || b.fly) && pow(b) >= tough(a));
      return s.turn > 30 || !killers.length || s.rng() < (killers.every(b => pow(a) >= tough(b)) ? .45 : .08);
    });
  }
  function chooseBlocks(me, attackers) {
    const free = team(me).filter(c => !c.tapped), pairs = [];
    let incoming = sum(attackers, pow);
    for (const a of [...attackers].sort((x, y) => pow(y) - pow(x))) {
      const able = free.filter(b => !a.fly || b.fly).sort((x, y) => value(x) - value(y));
      const b = able.find(b => pow(b) >= tough(a) && pow(a) < tough(b)) || able.find(b => pow(a) < tough(b)) ||
        able.find(b => pow(b) >= tough(a) && value(b) <= value(a)) || (incoming >= me.life ? able[0] : null);
      if (!b) continue;
      free.splice(free.indexOf(b), 1);
      a.blocked = b;
      pairs.push([a, b]);
      incoming -= pow(a);
    }
    return pairs;
  }
  // Giant Growth rescues a creature losing its fight or pushes lethal; the defender bolts a big attacker.
  function* tricks(s, me, foe, attackers) {
    for (const side of [me, foe]) {
      if (s.winner !== undefined) return;
      const growth = side.hand.find(c => c.key === 'growth'), bolt = side.hand.find(c => c.key === 'bolt');
      const fights = attackers.filter(a => a.blocked && me.field.includes(a) && foe.field.includes(a.blocked))
        .map(a => side === me ? [a, a.blocked] : [a.blocked, a]);
      const rescue = fights.find(([mine, theirs]) => pow(theirs) >= tough(mine) - mine.dmg && pow(theirs) < tough(mine) - mine.dmg + 3);
      const open = attackers.filter(a => !a.blocked && me.field.includes(a));
      if (growth && pay(side, growth, 0, false)) {
        if (rescue) yield* play(s, side, growth, rescue[0]);
        else if (side === me && open.length && sum(open, pow) + 3 >= foe.life) yield* play(s, me, growth, open[0]);
      }
      const prey = side === foe && bolt && open.find(a => me.field.includes(a) && tough(a) - a.dmg <= 3 && pow(a) >= 3);
      if (prey && pay(foe, bolt, 0, false) && s.winner === undefined) yield* play(s, foe, bolt, prey);
    }
  }
  const BREATH = { cost: 'R' };
  function* combat(s, me, foe) {
    const attackers = chooseAttackers(s, me, foe);
    if (!attackers.length) return;
    for (const c of attackers) Object.assign(c, { attacking: true, tapped: !c.vigil });
    me.acted = true;
    const lethal = sum(attackers, pow) >= foe.life && !team(foe).some(c => !c.tapped);
    yield { type: 'attack', side: me.i, cards: attackers, say: lethal && s.rng() < .8 ? 'SWING FOR LETHAL' : null, dur: 1.3 };
    const pairs = chooseBlocks(foe, attackers);
    if (pairs.length) yield { type: 'block', side: foe.i, pairs, dur: 1.1 };
    yield* tricks(s, me, foe, attackers);
    if (s.winner !== undefined) return;
    for (const c of attackers.filter(c => c.breath && me.field.includes(c))) {
      while (pay(me, BREATH)) c.fire++;
      if (c.fire) yield { type: 'breath', side: me.i, card: c, x: c.fire, dur: .9 };
    }
    const hits = [];
    for (const a of attackers.filter(c => me.field.includes(c))) {
      const b = a.blocked;
      if (!b) { foe.life -= pow(a); hits.push([a, foe, pow(a)]); continue; }
      if (!foe.field.includes(b)) continue;
      const spill = a.trample ? Math.max(0, pow(a) - (tough(b) - b.dmg)) : 0;
      b.dmg += pow(a) - spill;
      a.dmg += pow(b);
      hits.push([a, b, pow(a) - spill], [b, a, pow(b)]);
      if (spill) { foe.life -= spill; hits.push([a, foe, spill]); }
      if (a.key === 'sengir') b.bitBy = a;
      if (b.key === 'sengir') a.bitBy = b;
    }
    yield { type: 'damage', side: me.i, hits, dur: 1.3 };
    for (const [a, t] of hits) {
      if (a.key !== 'specter' || t !== foe || !foe.hand.length) continue;
      const c = foe.hand[s.rng() * foe.hand.length | 0];
      move(foe, c, foe.grave);
      yield { type: 'discard', side: foe.i, card: c, dur: .7 };
    }
    for (const c of attackers) Object.assign(c, { attacking: false, blocked: null });
    yield* settle(s);
  }
  function* main(s, me, foe, late) {
    const land = !me.landed && pickLand(me);
    if (land) {
      move(me, land, me.field);
      me.landed = true;
      s.last = land;
      yield { type: 'land', side: me.i, card: land, dur: .9 };
    }
    for (let n = 0, best; n < 12 && s.winner === undefined && (best = choose(s, me, foe)); n++)
      yield* play(s, me, best.c, best.target, best.x, best.say);
    for (const p of late ? me.field.filter(c => c.ping && !c.tapped && !c.sick) : []) {
      if (s.winner !== undefined) break;
      const target = team(foe).filter(c => tough(c) - c.dmg <= 1).sort((a, b) => value(b) - value(a))[0] || foe;
      p.tapped = true;
      hurt(target, 1);
      yield { type: 'ping', side: me.i, card: p, target, dur: .8 };
      yield* settle(s);
    }
    drain(s);
  }
  function* turn(s, me, foe) {
    Object.assign(me, { landed: false, acted: false, hold: me.hand.some(c => c.key === 'counter') && s.rng() < .6 });
    if (me.field.some(c => c.tapped || c.sick)) {
      for (const c of me.field) c.tapped = c.sick = false;
      yield { type: 'untap', side: me.i, dur: .5 };
    }
    for (const pit of me.field.filter(c => c.key === 'pit')) {
      const food = team(me).filter(c => c !== pit).sort((a, b) => value(a) - value(b))[0];
      if (food) move(me, food, me.grave);
      else me.life -= 7;
      yield { type: 'devour', side: me.i, card: pit, target: food || me, dur: 1.4 };
      yield* settle(s);
      if (s.winner !== undefined) return;
    }
    if (s.turn > 1) {
      if (!me.library.length) { s.winner = foe.i; return; }
      draw(me, 1);
      yield { type: 'draw', side: me.i, n: 1, dur: .6 };
    }
    yield* main(s, me, foe);
    if (s.winner === undefined) yield* combat(s, me, foe);
    if (s.winner === undefined) yield* main(s, me, foe, true);
    if (s.winner !== undefined) return;
    while (me.hand.length > 7) {
      const c = me.hand[s.rng() * me.hand.length | 0];
      move(me, c, me.grave);
      yield { type: 'discard', side: me.i, card: c, dur: .6 };
    }
    for (const c of [...me.field, ...foe.field]) Object.assign(c, { dmg: 0, pump: 0, fire: 0, bitBy: null });
    drain(s);
    const say = me.acted ? null : me.landed ? s.rng() < .45 && 'LAND, GO' : s.rng() < .2 && 'GO';
    yield { type: 'pass', side: me.i, say: say || null, dur: .8 };
  }
  function* duel(s) {
    yield { type: 'shuffle', dur: 1.4 };
    let rolls;
    do rolls = [1 + s.rng() * 20 | 0, 1 + s.rng() * 20 | 0]; while (rolls[0] === rolls[1]);
    s.active = rolls[0] > rolls[1] ? 0 : 1;
    yield { type: 'roll', side: s.active, rolls, dur: 2.4 };
    for (const me of s.sides) {
      draw(me, 7);
      yield { type: 'draw', side: me.i, n: 7, dur: 1.4 };
      const lands = me.hand.filter(c => c.type === 'land').length;
      if (me.fixed || lands > 1 && lands < 6) continue;
      me.library.push(...me.hand.splice(0));
      shuffle(me.library, s.rng);
      draw(me, 6);
      yield { type: 'mulligan', side: me.i, say: 'MULLIGAN', dur: 2.2 };
    }
    for (s.turn = 1; ; s.turn++, s.active = 1 - s.active) {
      if (s.turn > 40) s.winner = s.sides[0].life >= s.sides[1].life ? 0 : 1;
      else yield* turn(s, s.sides[s.active], s.sides[1 - s.active]);
      if (s.winner !== undefined) break;
    }
    yield { type: 'win', side: s.winner, dur: 3 };
  }

  let uid = 0;
  // players: [{ name, colors, demon, cards? }]; cards fixes a library (top first). The stacked side opens
  // with Black Lotus, Channel, Fireball and a Mountain.
  function newGame(players, rng, stacked = -1) {
    const s = { rng, stack: [], turn: 0, active: 0, last: null, winner: undefined };
    s.sides = players.map((p, i) => {
      const keys = p.cards || [...i === stacked ? ['lotus', 'channel', 'fireball', 'mountain'] : [], ...deck(p.colors, rng, p.demon)];
      return { ...p, i, life: 20, hand: [], field: [], grave: [], pool: [], fixed: !!p.cards || i === stacked,
        library: keys.map(key => ({ ...CARDS[key], ...FRESH, id: ++uid, side: i })) };
    });
    s.play = duel(s);
    return s;
  }
  return { CARDS, POOLS, deck, newGame, pay, pow, tough };
})();
