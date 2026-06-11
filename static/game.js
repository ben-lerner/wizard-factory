// game.js — the tower: world, movement, polling, UI.
'use strict';
(() => {
  const VW = 480, VH = 272, POLL = 1500, SPEED = 42;
  const $ = q => document.querySelector(q);
  const cv = $('#view'), g = cv.getContext('2d');
  const { drawText, textW, rng, hash, PR, drawEmote, WARM_MILK } = SP;

  // ---------- stations ----------
  const ST = {
    cauldron: { spots: [[50, 162], [94, 162]], emote: 'brew' },
    shelf:    { spots: [[40, 78], [40, 114], [40, 148]], emote: 'book' },
    bench:    { spots: [[132, 68], [152, 68], [172, 68]], emote: 'flask' },
    desk:     { spots: [[109, 198], [153, 198]], emote: 'write' },
    crystal:  { spots: [[223, 128], [204, 120]], emote: 'scry' },
    circle:   { spots: [[186, 162], [164, 178], [208, 178]], emote: 'summon' },
    board:    { spots: [[306, 56], [330, 56], [284, 58]], emote: 'scroll' },
    odesk:    { spots: [[313, 92], [373, 112], [336, 130]], emote: null },
    cafe:     { spots: [[308, 226], [330, 226], [352, 226], [374, 226], [394, 224]], emote: 'coffee' },
    hearth:   { spots: [[425, 90], [425, 112]], emote: null },
    door:     { spots: [[436, 248]], emote: 'star' },
  };
  for (const k in ST) ST[k].occ = ST[k].spots.map(() => null);

  function toolStation(tool) {
    const t = (tool || '').toLowerCase();
    if (t.startsWith('mcp__') || /^web|fetch|page|click|snapshot|script|console/.test(t)) return 'crystal';
    if (/bash|^kill|monitor|exec|shell|stdin/.test(t)) return 'cauldron';
    if (/^(read|grep|glob|ls$|lsp|toolsearch|notebookread)/.test(t)) return 'shelf';
    if (/^(edit|write|notebookedit|apply)/.test(t)) return 'desk';
    if (/task|agent|workflow|skill/.test(t)) return 'circle';
    if (/todo|plan|question|sharepoint|onboarding/.test(t)) return 'board';
    return 'bench';
  }
  const TOOL_EMOTE = { grep: 'search', glob: 'search', toolsearch: 'search' };

  // ---------- entities ----------
  const wizards = new Map();
  let sel = null, hover = null, offline = false, isDemo = false, serverSkew = 0, lastData = { agents: [] };

  function clampZone(x, y) {
    const lab = x < 264;
    return [Math.max(lab ? 18 : 282, Math.min(lab ? 252 : 462, x)), Math.max(46, Math.min(250, y))];
  }
  function pathTo(w, tx, ty) {
    w.path = (w.x < 268) !== (tx < 268) ? [[w.x, 142], [tx, 142], [tx, ty]] : [[tx, w.y], [tx, ty]];
  }
  function release(w) {
    if (w.station && w.spotI >= 0) ST[w.station].occ[w.spotI] = null;
    w.spotI = -1;
  }
  function retarget(w) {
    const key = placeFor(w);
    if (key === w.station && w.home) { w.emote = emoteFor(w); return; }
    release(w);
    const st = ST[key], i = st.occ.findIndex(o => !o);
    let pos;
    if (i >= 0) { st.occ[i] = w.a.id; w.spotI = i; pos = st.spots[i]; }
    else pos = clampZone(st.spots[0][0] + ((w.r() * 56 - 28) | 0), st.spots[0][1] + ((w.r() * 22 - 6) | 0));
    w.station = key; w.home = pos;
    pathTo(w, pos[0], pos[1]);
    w.emote = emoteFor(w);
  }
  function placeFor(w) {
    const s = w.a.status;
    if (s === 'working') return toolStation(w.a.tool);
    if (s === 'attention') return 'board';
    if (s === 'waiting') return 'cafe';
    if (s === 'idle') return 'hearth';
    if (s === 'done') return 'door';
    return w.station || 'bench';
  }
  function emoteFor(w) {
    const s = w.a.status;
    if (s === 'working') return TOOL_EMOTE[(w.a.tool || '').toLowerCase()] || ST[w.station].emote || 'flask';
    return { attention: 'alert', thinking: 'think', responding: 'write', idle: 'sleep', done: 'star',
             waiting: w.station === 'cafe' ? 'drink:' + ((w.order && w.order.drink || w.sp.drink).key) : null }[s] || null;
  }

  function reconcile(data) {
    const seen = new Set();
    for (const a of data.agents) {
      seen.add(a.id);
      let w = wizards.get(a.id);
      if (!w) {
        w = { a, sp: SP.makeWizard(a.id, a.kind, a.engine), x: 436 + ((hash(a.id) % 9) - 4), y: 250, dir: -1, path: [], walk: false,
              station: null, spotI: -1, home: null, order: null, paceAt: 0, leaving: false,
              alpha: 0, ph: (hash(a.id) % 100) / 16, r: rng(hash(a.id) ^ 0xbeef), emote: null };
        wizards.set(a.id, w);
        sparkleAt(436, 252);
        w.a = a; retarget(w);
        continue;
      }
      const changed = w.a.status !== a.status || (a.status === 'working' && w.a.tool !== a.tool) || w.leaving;
      w.a = a;
      w.leaving = false;
      if (a.status !== 'waiting') w.order = null;
      if (changed) retarget(w);
    }
    for (const [id, w] of wizards) if (!seen.has(id) && !w.leaving) { w.leaving = true; release(w); w.station = null; pathTo(w, 436, 250); w.path.push([436, 266]); }
  }

  // ---------- cat & barista ----------
  const catFrames = SP.makeCat();
  const cat = { x: 446, y: 110, state: 'sit', until: 4, path: [], dir: -1, dest: null, order: null };
  const catR = rng(99);
  function catThink(t) {
    if (cat.state === 'milk') cat.order = null;
    cat.dest = null;
    const roll = catR();
    if (roll < .16) sendCatToCafe(t);
    else if (roll < .42) { cat.state = 'sleep'; cat.until = t + 6 + catR() * 8; cat.path = [[440, 112]]; }
    else if (roll < .64) { cat.state = 'sit'; cat.until = t + 4 + catR() * 5; }
    else {
      const ws = [...wizards.values()];
      const pal = ws.length && catR() < .5 ? ws[catR() * ws.length | 0] : null;
      const target = pal ? [pal.x + 12, pal.y] : clampZone(catR() * VW, 60 + catR() * 180);
      cat.path = (cat.x < 268) !== (target[0] < 268) ? [[cat.x, 142], [target[0], 142], target] : [[target[0], cat.y], target];
      cat.state = 'walk'; cat.until = t + 20;
    }
  }
  // Earl Grey roasts the house beans himself.
  const dragon = { frames: SP.makeDragon(), x: 338, roastAt: 7, roastUntil: -9, flapAt: 13, flapUntil: -9, task: null };
  const PAN = [324, 196];
  const CUP = [316, 187], CAT_CAFE = [404, 226];

  function sendCatToCafe(t) {
    pathTo(cat, CAT_CAFE[0], CAT_CAFE[1]);
    cat.state = 'walk';
    cat.dest = 'cafe';
    cat.until = t + 40;
  }
  function cafeReady(w) {
    return w.a.status === 'waiting' && w.station === 'cafe' && !w.walk && !w.leaving && w.alpha > .8;
  }
  function ensureOrder(w, t) {
    if (cafeReady(w) && !w.order) w.order = { drink: w.sp.drink, stage: 'queued', askAt: t + w.r() * 1.2, servedAt: 0 };
  }
  function cafeCustomers() {
    const cs = [];
    for (const w of wizards.values()) if (cafeReady(w) && w.order) cs.push({ kind: 'wizard', id: w.a.id, order: w.order, drink: w.order.drink, x: w.x, y: w.y });
    if (cat.state === 'milk' && !cat.path.length && cat.order) cs.push({ kind: 'cat', id: 'cat', order: cat.order, drink: cat.order.drink, x: cat.x, y: cat.y });
    return cs;
  }
  function taskCustomer(task) {
    if (task.kind === 'cat') return cat.state === 'milk' && cat.order === task.order ? { kind: 'cat', id: 'cat', order: cat.order, drink: cat.order.drink, x: cat.x, y: cat.y } : null;
    const w = wizards.get(task.id);
    return w && cafeReady(w) && w.order === task.order ? { kind: 'wizard', id: w.a.id, order: w.order, drink: w.order.drink, x: w.x, y: w.y } : null;
  }
  function startDrink(c, t) {
    c.order.stage = 'brewing';
    dragon.roastUntil = dragon.flapUntil = -9;
    dragon.task = { kind: c.kind, id: c.id, order: c.order, drink: c.drink, phase: 'brew', until: t + 1.45 };
  }
  function cafeService(t) {
    for (const w of wizards.values()) ensureOrder(w, t);
    if (dragon.task && t >= dragon.task.until) {
      const c = taskCustomer(dragon.task);
      if (!c) dragon.task = null;
      else if (dragon.task.phase === 'brew' && c.drink.milk) {
        c.order.stage = 'milk';
        dragon.task = { ...dragon.task, phase: 'milk', until: t + 1.15 };
      } else {
        c.order.stage = 'served';
        c.order.servedAt = t;
        dragon.task = null;
        sparkleAt(c.x, c.y - 8);
      }
    }
    if (!dragon.task) {
      const next = cafeCustomers().filter(c => c.order.stage === 'queued' && t >= c.order.askAt).sort((a, b) => a.order.askAt - b.order.askAt)[0];
      if (next) startDrink(next, t);
    }
  }

  // ---------- particles ----------
  const PARTS = [];
  function spark(x, y, c, vy, life, kind) {
    if (PARTS.length > 220) return;
    PARTS.push({ x: x + Math.random() * 4 - 2, y, vx: Math.random() * 8 - 4, vy, c, life, t: 0, kind });
  }
  const sparkleAt = (x, y) => { for (let i = 0; i < 6; i++) spark(x, y - 10 - Math.random() * 10, '#ffe89a', -4, .8); };

  // ---------- world ----------
  const WALL = '#3a3144', WALL_D = '#262032', WALL_HI = '#4a3f5c';
  const bg = document.createElement('canvas'); bg.width = VW; bg.height = VH;
  (() => {
    const b = bg.getContext('2d'), r = rng(5);
    b.fillStyle = '#46414f'; b.fillRect(8, 34, 256, 226);
    for (let ty = 34; ty < 260; ty += 16) for (let tx = 8; tx < 264; tx += 16)
      if (((tx + ty) / 16) % 2) { b.fillStyle = '#423d4b'; b.fillRect(tx, ty, 16, 16); }
    for (let i = 0; i < 70; i++) { b.fillStyle = r() < .5 ? '#3c3846' : '#4c4756'; b.fillRect(8 + (r() * 254 | 0), 34 + (r() * 222 | 0), r() < .3 ? 2 : 1, 1); }
    for (let ry = 34; ry < 260; ry += 8) {
      b.fillStyle = ((ry / 8) | 0) % 2 ? '#684832' : '#5f422c'; b.fillRect(264, ry, 208, 8);
      b.fillStyle = '#53391f';
      for (let sx = 264 + ((ry / 8) % 3) * 24; sx < 472; sx += 72) b.fillRect(sx, ry, 1, 8);
      b.fillRect(264, ry + 7, 208, 1);
    }
    b.fillStyle = WALL; b.fillRect(0, 0, VW, 34); b.fillRect(0, 0, 8, VH); b.fillRect(472, 0, 8, VH); b.fillRect(0, 260, VW, 12);
    b.fillStyle = WALL_HI; b.fillRect(0, 0, VW, 2);
    b.fillStyle = WALL_D; b.fillRect(0, 32, VW, 2); b.fillRect(0, 260, VW, 2); b.fillRect(6, 0, 2, VH); b.fillRect(472, 0, 2, VH);
    b.fillStyle = WALL; b.fillRect(264, 0, 8, 112); b.fillRect(264, 168, 8, 92);
    b.fillStyle = WALL_D; b.fillRect(264, 110, 8, 2); b.fillRect(264, 168, 8, 2); b.fillRect(264, 0, 1, 112); b.fillRect(271, 0, 1, 112); b.fillRect(264, 168, 1, 92); b.fillRect(271, 168, 1, 92);
    for (let i = 0; i < 26; i++) { b.fillStyle = '#352d3e'; b.fillRect((r() * 470 | 0), (r() * 30 | 0) + 2, 2, 1); }
    PR.banner(b, 88, 6, '#7a3b4a'); PR.banner(b, 168, 6, '#3f5b9b'); PR.banner(b, 352, 6, '#3f7b4c');
    PR.rug(b, 318, 96);
    b.fillStyle = '#53391f'; b.fillRect(296, 252, 96, 1);
    drawText(b, 320, 240, 'MANA CAFE', '#ffd84a');
    drawText(b, 60, 240, 'LABORATORIVM', '#8a84a0');
  })();

  // animated props, y-sorted with sprites: [sortY, drawFn]
  const props = t => [
    [174, gg => PR.cauldron(gg, 56, 150, t, occupied('cauldron'))],
    [91, gg => PR.shelf(gg, 10, 60, 11)], [127, gg => PR.shelf(gg, 10, 96, 23)],
    [62, gg => PR.bench(gg, 120, 42, t)],
    [214, gg => PR.desk(gg, 96, 200, t)], [214.1, gg => PR.desk(gg, 140, 200, t + 3)],
    [120, gg => PR.crystal(gg, 216, 98, occupied('crystal') ? t : 0)],
    [29, gg => PR.board(gg, 300, 8)],
    [106, gg => PR.desk(gg, 300, 96, t + 1)], [126, gg => PR.desk(gg, 360, 116, t + 2)],
    [94, gg => PR.hearth(gg, 440, 70, t)],
    [95, gg => PR.chair(gg, 418, 82, false)], [117, gg => PR.chair(gg, 418, 104, false)],
    [214.5, gg => PR.counter(gg, 296, 196)], [215, gg => PR.espresso(gg, 306, 186, t)],
    [215.2, gg => PR.beans(gg, PAN[0], PAN[1], t < dragon.roastUntil + 4)],
    [215.3, gg => { if (dragon.task) PR.cup(gg, CUP[0], CUP[1], dragon.task.drink.key, t); }],
    [52, gg => PR.plant(gg, 452, 38)],
    [274, gg => PR.doorway(gg, 424, 258, t)],
  ];
  const occupied = key => [...wizards.values()].some(w => w.station === key && !w.path.length && (w.a.status === 'working' || w.a.status === 'attention'));

  // ---------- update ----------
  function moveAlong(e, dt, speed) {
    if (!e.path.length) return false;
    const [tx, ty] = e.path[0], dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy), step = speed * dt;
    if (d <= step) { e.x = tx; e.y = ty; e.path.shift(); }
    else { e.x += dx / d * step; e.y += dy / d * step; if (Math.abs(dx) > .5) e.dir = dx < 0 ? -1 : 1; }
    return true;
  }

  function update(dt, t) {
    for (const [id, w] of wizards) {
      w.walk = moveAlong(w, dt, SPEED);
      w.alpha = Math.max(0, Math.min(1, w.alpha + (w.leaving && !w.path.length ? -3 : w.leaving && w.y > 252 ? -1.2 : 3) * dt));
      if (w.leaving && w.alpha <= 0) { wizards.delete(id); continue; }
      if (!w.walk && !w.leaving && (w.a.status === 'thinking') && t > w.paceAt) {
        w.paceAt = t + 2.5 + w.r() * 3;
        if (w.home && w.r() < .7) { const [hx, hy] = w.home; w.path = [[hx + ((w.r() * 14 - 7) | 0), hy + ((w.r() * 6 - 3) | 0)]]; }
      }
      if (w.a.status === 'idle' && Math.random() < dt * .5) spark(w.x + 6, w.y - 24, '#a8a2c8', -6, 1.4, 'z');
      if (w.a.status === 'attention' && Math.random() < dt * 2) spark(w.x, w.y - 26, '#ff5a5a', -10, .5);
    }
    cafeService(t);
    // ambient particles
    if (occupied('cauldron') && Math.random() < dt * 7) spark(70 + Math.random() * 14, 152, '#58d878', -14, .8);
    if (occupied('circle') && Math.random() < dt * 6) { const a = Math.random() * 6.28; spark(186 + Math.cos(a) * 22, 178 + Math.sin(a) * 9, '#9a7cf0', -12, .9); }
    if (occupied('crystal') && Math.random() < dt * 3) spark(223, 100, '#cfe8ff', -8, .7);
    if ([...wizards.values()].some(w => w.station === 'cafe') && Math.random() < dt * 4) spark(312, 184, '#d8d4e4', -9, 1);
    if (!dragon.task && Math.random() < dt * 3) spark(450 + Math.random() * 6, 86, '#f0a83c', -11, .7);
    // the dragon's roasting and wing-stretching schedules (never both at once)
    if (!dragon.task && t > dragon.roastAt && t >= dragon.flapUntil) { dragon.roastUntil = t + 1.8; dragon.roastAt = t + 14 + Math.random() * 20; }
    if (!dragon.task && t > dragon.flapAt && t >= dragon.roastUntil) { dragon.flapUntil = t + 3; dragon.flapAt = t + 18 + Math.random() * 25; }
    if (!dragon.task && t < dragon.flapUntil && Math.random() < dt * 9) spark(dragon.x - 14 + Math.random() * 28, barY - 4, '#b8b2cc', -3, .5);
    if ((dragon.task && dragon.task.phase === 'brew') || t < dragon.roastUntil) {
      if (Math.random() < dt * 22) spark(PAN[0] + 2 + Math.random() * 5, PAN[1] - 1, Math.random() < .5 ? '#ffd84a' : '#f08a2a', -8 - Math.random() * 8, .45);
    } else if (!dragon.task && t < dragon.roastUntil + 4 && Math.random() < dt * 6) {
      spark(PAN[0] + 4, PAN[1] - 2, '#9a93b0', -8, 1.2);                 // fresh-roast smoke
    } else if (!dragon.task && Math.random() < dt * .15) {
      spark(dragon.x - 13, barY - 21, '#9a93b0', -5, .9);                // idle nostril puff
    }
    if (dragon.task && dragon.task.phase === 'milk' && Math.random() < dt * 10) spark(CUP[0] + 5, CUP[1] + 3, '#f7f3e8', -4, .45);
    for (let i = PARTS.length - 1; i >= 0; i--) {
      const p = PARTS[i]; p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.t > p.life) PARTS.splice(i, 1);
    }
    // cat
    if (cat.state === 'walk') {
      if (!moveAlong(cat, dt, 26)) {
        if (cat.dest === 'cafe') {
          cat.state = 'milk';
          cat.dest = null;
          cat.until = t + 22 + catR() * 8;
          cat.order = { drink: WARM_MILK, stage: 'queued', askAt: t, servedAt: 0 };
        } else catThink(t);
      }
    }
    else if (t > cat.until) catThink(t);
  }

  // ---------- draw ----------
  function drawWizardSprite(w, t) {
    const f = w.walk ? ((t * 6 | 0) % 2 ? 'walkA' : 'walkB') : ((t + w.ph) % 2.6 < 1.3 ? 'idleA' : 'idleB');
    const img = w.sp.frames[f];
    g.globalAlpha = .3 * w.alpha; g.fillStyle = '#0a0810'; g.fillRect(w.x - 5, w.y - 1, 10, 2);
    g.globalAlpha = w.alpha;
    if (w.dir < 0) { g.save(); g.translate(w.x + 10, w.y - 23); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore(); }
    else g.drawImage(img, w.x - 10, w.y - 23);
    if (w.a.id === sel || w.a.status === 'attention') {
      const c = w.a.status === 'attention' ? '#ff5a5a' : '#ffd84a';
      g.globalAlpha = (Math.sin(t * 5) + 1.6) / 3;
      g.fillStyle = c;
      [[-8, -26, 4, 1], [-8, -26, 1, 4], [4, -26, 4, 1], [7, -26, 1, 4], [-8, 1, 4, 1], [-8, -2, 1, 3], [4, 1, 4, 1], [7, -2, 1, 3]].forEach(([a, b2, ww, hh]) => g.fillRect(w.x + a, w.y + b2, ww, hh));
    }
    g.globalAlpha = 1;
  }

  function drawMilkPour(t) {
    const sx = dragon.x - 7, sy = barY - 22, tx = CUP[0] + 5, ty = CUP[1] + 5;
    g.fillStyle = '#d8def0'; g.fillRect(sx, sy, 6, 3); g.fillRect(sx + 4, sy + 3, 2, 2);
    g.fillStyle = '#f7f3e8'; g.fillRect(sx + 1, sy + 1, 3, 1);
    for (let i = 0; i < 9; i++) {
      const k = i / 8, wiggle = Math.sin(t * 12 + i) * .7;
      g.fillRect(sx + 4 + (tx - sx - 4) * k + wiggle, sy + 4 + (ty - sy - 4) * k, 1, i > 5 ? 2 : 1);
    }
  }

  function draw(t) {
    g.drawImage(bg, 0, 0);
    for (let i = 0; i < 5; i++) PR.window(g, [48, 128, 208, 312, 392][i], 8, t, i * 7 + 3);
    PR.torch(g, 24, 14, t); PR.torch(g, 240, 14, t + .5); PR.torch(g, 282, 14, t + .2); PR.torch(g, 444, 14, t + .8);
    PR.circle(g, 160, 152 + 12, t, occupied('circle'));
    const items = props(t).map(([y, f]) => ({ y, f: () => f(g) }));
    for (const w of wizards.values()) items.push({ y: w.y, f: () => drawWizardSprite(w, t) });
    items.push({ y: barY, f: () => {
      const busy = !!dragon.task, brewing = busy && dragon.task.phase === 'brew', flap = !busy && t < dragon.flapUntil, p = flap ? 1 - (dragon.flapUntil - t) / 3 : 0;
      const lift = Math.sin(p * Math.PI) * 7;
      g.globalAlpha = .3; g.fillStyle = '#0a0810';
      g.fillRect(dragon.x - 9 + lift / 2, barY - 1, 18 - lift, 2);
      g.globalAlpha = 1;
      if (flap) {
        const sway = Math.sin(t * 2.8) * 3 * Math.sin(p * Math.PI);
        g.drawImage(dragon.frames[(t * 7 | 0) % 2 ? 'flapA' : 'flapB'], Math.round(dragon.x - 22 + sway), Math.round(barY - 29 - lift));
      } else {
        const fr = brewing || t < dragon.roastUntil ? ((t * 8 | 0) % 2 ? 'roastA' : 'roastB') : (t % 2.6 < 1.3 ? 'idleA' : 'idleB');
        g.drawImage(dragon.frames[fr], dragon.x - 15, barY - 25);
      }
    } });
    items.push({ y: cat.y, f: () => { const fr = cat.state === 'sleep' ? 'sleep' : cat.state === 'walk' ? ((t * 5 | 0) % 2 ? 'walkA' : 'walkB') : ((t * 1.3 | 0) % 2 ? 'sitA' : 'sitB');
      const img = catFrames[fr]; if (cat.dir < 0) { g.save(); g.translate(cat.x + 7, cat.y - 9); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore(); } else g.drawImage(img, cat.x - 7, cat.y - 9); } });
    items.sort((a, b) => a.y - b.y).forEach(i => i.f());
    const fireTarget = dragon.task && dragon.task.phase === 'brew' ? [CUP[0] + 5, CUP[1] + 4] : t < dragon.roastUntil ? [PAN[0] + 4, PAN[1] - 2] : null;
    if (fireTarget) {  // fire breath, drawn over the counter
      const mx = dragon.x - 13, my = barY - 15, tx = fireTarget[0], ty2 = fireTarget[1];
      for (let i = 0; i < 16; i++) {
        const k = i / 15, s = k > .45 ? 2 : 1;
        g.fillStyle = ['#ffe89a', '#ffd84a', '#f0a83c', '#f08a2a'][(Math.random() * 4) | 0];
        g.fillRect(mx + (tx - mx) * k + (Math.random() * 4 - 2) * k, my + (ty2 - my) * k, s, s);
      }
    }
    if (dragon.task && dragon.task.phase === 'milk') drawMilkPour(t);
    for (const p of PARTS) {
      g.globalAlpha = Math.max(0, 1 - p.t / p.life);
      if (p.kind === 'z') drawText(g, p.x, p.y, 'Z', p.c);
      else { g.fillStyle = p.c; g.fillRect(p.x, p.y, p.t < p.life / 2 ? 2 : 1, p.t < p.life / 2 ? 2 : 1); }
    }
    g.globalAlpha = 1;
    for (const w of wizards.values()) {
      if (w.emote && !w.walk && w.alpha > .8) drawEmote(g, w.x, w.y - 26, w.emote, t + w.ph);
      if (w.order && w.order.stage === 'served' && !w.walk && w.alpha > .8) PR.cup(g, w.x + (w.dir < 0 ? -14 : 4), w.y - 11, w.order.drink.key, t + w.ph);
      if (w.order && w.order.stage !== 'served' && !w.walk && w.alpha > .8 && ((t + w.ph) % 6) < 2.4) tag(w.x, w.y - 45, w.order.drink.name);
      if ((hover === w.a.id || sel === w.a.id) && w.alpha > .5) tag(w.x, w.y - 38, w.sp.name);
    }
    if (cat.order && cat.order.stage === 'served') PR.cup(g, cat.x + 5, cat.y - 6, WARM_MILK.key, t);
    if (cat.order && cat.order.stage !== 'served' && ((t + 1.7) % 6) < 2.4) tag(cat.x, cat.y - 25, WARM_MILK.name);
    if (hover === 'cat') tag(cat.x, cat.y - 20, 'BIGGLES, STAFF CAT');
    if (hover === 'barista') tag(338, barY - 32, 'EARL GREY, DRAGON BARISTA');
    if (!wizards.size) {
      g.fillStyle = 'rgba(12,9,20,.55)'; g.fillRect(90, 110, 300, 44);
      drawText(g, 240 - textW('THE TOWER SLEEPS', 2) / 2, 120, 'THE TOWER SLEEPS', '#cdc6e0', 2);
      drawText(g, 240 - textW('NO CLAUDE AGENTS ABOUT - START ONE!') / 2, 138, 'NO CLAUDE AGENTS ABOUT - START ONE!', '#8a84a0');
    }
    if (offline) {
      g.fillStyle = 'rgba(20,8,8,.6)'; g.fillRect(0, 0, VW, VH);
      drawText(g, 240 - textW('LINK TO THE TOWER SEVERED', 2) / 2, 124, 'LINK TO THE TOWER SEVERED', '#ff8a8a', 2);
      drawText(g, 240 - textW('IS SERVER.PY STILL RUNNING?') / 2, 142, 'IS SERVER.PY STILL RUNNING?', '#c8a0a0');
    }
  }
  const barY = 196;
  function tag(cx, y, txt) {
    const w2 = textW(txt) + 4;
    g.fillStyle = 'rgba(12,9,20,.85)'; g.fillRect(cx - w2 / 2, y - 2, w2, 9);
    drawText(g, cx - w2 / 2 + 2, y, txt, '#f0ecdc');
  }

  // ---------- scale / input ----------
  let S = 1;
  function resize() {
    const box = $('#stage').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    S = Math.max(1, Math.floor(Math.min(box.width / VW, (box.height - 4) / VH)));
    cv.width = VW * S * dpr; cv.height = VH * S * dpr;
    cv.style.width = VW * S + 'px'; cv.style.height = VH * S + 'px';
    g.setTransform(S * dpr, 0, 0, S * dpr, 0, 0);
    g.imageSmoothingEnabled = false;
  }
  window.addEventListener('resize', resize);

  function pickAt(e) {
    const r = cv.getBoundingClientRect(), mx = (e.clientX - r.left) / S, my = (e.clientY - r.top) / S;
    for (const w of [...wizards.values()].sort((a, b) => b.y - a.y))
      if (Math.abs(mx - w.x) <= 9 && my >= w.y - 26 && my <= w.y + 3) return w.a.id;
    if (mx >= dragon.x - 25 && mx <= dragon.x + 25 && my >= barY - 36 && my <= barY + 3) return 'barista';
    if (Math.abs(mx - cat.x) <= 8 && Math.abs(my - cat.y + 4) <= 7) return 'cat';
    return null;
  }
  cv.addEventListener('mousemove', e => {
    hover = pickAt(e);
    cv.style.cursor = hover ? 'pointer' : 'default';
    const tip = $('#tip'), w = wizards.get(hover);
    if (w) {
      tip.innerHTML = tipHTML(w);
      tip.hidden = false;
      const sr = $('#stage').getBoundingClientRect();
      tip.style.left = Math.min(e.clientX - sr.left + 14, sr.width - 240) + 'px';
      tip.style.top = Math.min(e.clientY - sr.top + 10, sr.height - 120) + 'px';
    } else tip.hidden = true;
  });
  cv.addEventListener('mouseleave', () => { hover = null; $('#tip').hidden = true; });
  cv.addEventListener('click', e => { const id = pickAt(e); sel = (id && wizards.has(id)) ? (sel === id ? null : id) : null; renderSide(); });

  // ---------- status text ----------
  const VERB = { Bash: 'BREWING', Read: 'READING', Edit: 'INSCRIBING', Write: 'SCRIBING', Grep: 'SCOURING FOR', Glob: 'SCOURING FOR',
    WebFetch: 'SCRYING', WebSearch: 'SCRYING', Task: 'SUMMONING', Agent: 'SUMMONING', Workflow: 'GRAND RITE', Skill: 'INVOKING',
    TodoWrite: 'UPDATING THE QUESTBOOK', LSP: 'DIVINING', ToolSearch: 'RUMMAGING FOR', AskUserQuestion: 'PETITIONING YOU',
    EnterPlanMode: 'PLOTTING', ExitPlanMode: 'PRESENTING A PLAN', KillShell: 'DOUSING A POTION', Monitor: 'WATCHING A POTION',
    exec_command: 'BREWING', write_stdin: 'STIRRING', apply_patch: 'INSCRIBING', update_plan: 'UPDATING THE QUESTBOOK', web_search: 'SCRYING' };
  const drinkName = d => (d.article === '' ? '' : d.article ? d.article + ' ' : /^(AMERICANO|ESPRESSO)/.test(d.name) ? 'AN ' : 'A ') + d.name;
  function cafeStatus(w) {
    if (!w || w.station !== 'cafe') return 'AWAITING YOUR COUNSEL AT THE CAFE';
    const d = w.order && w.order.drink || w.sp.drink, name = drinkName(d);
    if (!w.order) return 'ASKING EARL GREY FOR ' + name;
    if (w.order.stage === 'brewing') return 'HAVING ' + name + ' BREWED WITH FIRE';
    if (w.order.stage === 'milk') return 'EARL GREY IS POURING MILK FOR ' + name;
    if (w.order.stage === 'served') return 'SIPPING ' + name;
    return 'ASKING EARL GREY FOR ' + name;
  }
  function statusLine(a, w) {
    const d = a.detail ? ': ' + a.detail : '';
    switch (a.status) {
      case 'working': {
        if ((a.tool || '').startsWith('mcp__')) return 'FAR-SCRYING' + ': ' + a.tool.slice(5).replace('__', ' / ') + (a.detail ? ' — ' + a.detail : '');
        if (/page|click|snapshot|script|console/.test((a.tool || '').toLowerCase())) return 'FAR-SCRYING: ' + a.tool + (a.detail ? ' — ' + a.detail : '');
        return (VERB[a.tool] || 'CONJURING ' + (a.tool || '?')) + d;
      }
      case 'thinking': return 'PONDERING…';
      case 'responding': return 'COMPOSING A MISSIVE…';
      case 'waiting': return cafeStatus(w);
      case 'attention': return (a.engine === 'codex' ? 'Codex needs your help' : a.msg || 'SEEKS YOUR BLESSING') + ' (!)';
      case 'idle': return 'DOZING BY THE HEARTH…';
      case 'done': return 'QUEST COMPLETE!';
    }
    return a.status;
  }
  const AGE = sIn => { const s = Math.max(0, sIn); return s < 90 ? (s | 0) + 'S' : s < 5400 ? ((s / 60) | 0) + 'M' : ((s / 3600) | 0) + 'H' + (((s % 3600) / 60) | 0) + 'M'; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function tipHTML(w) {
    const a = w.a, now = Date.now() / 1000 - serverSkew;
    return `<div class="tt-name">${esc(w.sp.name)} <span>${esc(w.sp.epithet)}</span></div>
      <div class="tt-meta">${a.engine === 'codex' ? 'CODEX · ' : ''}${a.kind === 'sub' ? 'APPRENTICE · ' : ''}${esc(a.project || '?')}${a.branch ? ' · ' + esc(a.branch) : ''}${a.model ? ' · ' + esc(a.model.replace('claude-', '')) : ''}</div>
      <div class="tt-status st-${a.status}">${esc(statusLine(a, w))}</div>
      ${a.title ? `<div class="tt-title">${esc(a.title)}</div>` : ''}
      ${a.quest ? `<div class="tt-quest">"${esc(a.quest.slice(0, 130))}"</div>` : ''}
      <div class="tt-age">IN STATE ${AGE(now - (a.since || now))} · LAST SIGN ${AGE(now - (a.last || now))} AGO</div>`;
  }

  // ---------- sidebar ----------
  const ORDER = { attention: 0, working: 1, thinking: 2, responding: 3, waiting: 4, done: 5, idle: 6 };
  function renderSide() {
    const now = Date.now() / 1000 - serverSkew;
    const ags = [...lastData.agents].sort((x, y) => (ORDER[x.status] ?? 9) - (ORDER[y.status] ?? 9) || (x.started || 0) - (y.started || 0));
    $('#num').textContent = ags.length || '';
    $('#rows').innerHTML = ags.map(a => {
      const w = wizards.get(a.id);
      if (!w) return '';
      return `<div class="row st-${a.status} ${sel === a.id ? 'sel' : ''} ${a.kind}" data-id="${esc(a.id)}">
        <img class="pt" src="${w.sp.portrait}" alt="">
        <div class="mid">
          <div class="nm">${a.kind === 'sub' ? '<span class="sub-arrow">&#8627;</span> ' : ''}${esc(w.sp.name)} <span class="ep">${esc(w.sp.epithet)}</span></div>
          <div class="ln">${esc(statusLine(a, w))}</div>
          <div class="ch"><span class="chip">${esc(a.project || '?')}</span>${a.engine === 'codex' ? '<span class="chip cdx">codex</span>' : ''}${a.branch ? `<span class="chip alt">${esc(a.branch)}</span>` : ''}<span class="time">${AGE(now - (a.since || now))}</span></div>
        </div></div>`;
    }).join('');
    document.querySelectorAll('#rows .row').forEach(el => el.onclick = () => {
      const id = el.dataset.id;
      sel = sel === id ? null : id;
      const w = wizards.get(id);
      if (w && sel) sparkleAt(w.x, w.y - 16);
      renderSide();
    });
    const counts = { working: 0, thinking: 0, responding: 0, attention: 0, waiting: 0, idle: 0, done: 0 };
    ags.forEach(a => counts[a.status] !== undefined && counts[a.status]++);
    const toil = counts.working + counts.thinking + counts.responding;
    $('#counts').innerHTML = `<span class="c-work">&#9874; ${toil} TOILING</span><span class="c-attn ${counts.attention ? 'hot' : ''}">&#9995; ${counts.attention} NEED YOU</span><span class="c-wait">&#9749; ${counts.waiting} AWAITING</span><span class="c-doze">&#9790; ${counts.idle + counts.done} RESTING</span>${isDemo ? '<span class="c-demo">DEMO</span>' : ''}`;
    const attn = counts.attention;
    document.title = (attn ? `(${attn}!) ` : '') + 'Wizard Factory';
    favicon(attn > 0);
  }

  let favLast = null;
  function favicon(hot) {
    if (favLast === hot) return;
    favLast = hot;
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const f = c.getContext('2d');
    f.fillStyle = '#6a4fd0'; f.fillRect(7, 2, 2, 3); f.fillRect(6, 5, 4, 3); f.fillRect(5, 8, 6, 3);
    f.fillStyle = '#523aa8'; f.fillRect(3, 11, 10, 2);
    f.fillStyle = '#ffd84a'; f.fillRect(7, 6, 1, 1);
    if (hot) { f.fillStyle = '#ff4a4a'; f.fillRect(11, 1, 4, 4); }
    let l = document.querySelector('link[rel=icon]');
    if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); }
    l.href = c.toDataURL();
  }

  // ---------- polling ----------
  async function poll() {
    try {
      const res = await fetch('/api/state');
      lastData = await res.json();
      serverSkew = Date.now() / 1000 - lastData.now;
      isDemo = lastData.demo;
      offline = false;
      reconcile(lastData);
      renderSide();
    } catch {
      offline = true;
    }
    setTimeout(poll, POLL);
  }

  // ---------- logo ----------
  (() => {
    const lc = $('#logo'), lg = lc.getContext('2d');
    lg.fillStyle = '#6a4fd0'; lg.fillRect(10, 2, 4, 6); lg.fillRect(8, 8, 8, 6); lg.fillRect(6, 14, 12, 6);
    lg.fillStyle = '#523aa8'; lg.fillRect(2, 20, 20, 4);
    lg.fillStyle = '#ffd84a'; lg.fillRect(10, 10, 2, 2);
    drawText(lg, 30, 4, 'WIZARD FACTORY', '#ffd84a', 3);
    drawText(lg, 31, 24, 'A CLAUDE CODE AGENT OBSERVATORY', '#8a84a0', 1);
  })();

  $('#helpBtn').onclick = () => { $('#help').hidden = !$('#help').hidden; };
  $('#help').onclick = e => { if (e.target.id === 'help') $('#help').hidden = true; };

  // ---------- main loop ----------
  // rAF drives rendering; a fallback interval keeps the simulation flowing (in 0.1s
  // catch-up steps) while the tab is backgrounded and rAF is starved.
  let last = performance.now(), simT = 0, lastTick = 0;
  function tick(ms) {
    let gap = Math.min(3, (ms - last) / 1000);
    last = lastTick = ms;
    while (gap > 0) { const d = Math.min(.1, gap); simT += d; update(d, simT); gap -= d; }
    draw(simT);
  }
  function frame(ms) { requestAnimationFrame(frame); tick(ms); }
  setInterval(() => { const n = performance.now(); if (n - lastTick > 450) tick(n); }, 300);
  resize();
  catThink(0);
  poll();
  requestAnimationFrame(frame);
  window.WF = { wizards, ST, cat, dragon };
})();
