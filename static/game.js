// game.js — the tower: world, movement, polling, UI.
'use strict';
(() => {
  const VW = 480, VH = 272, POLL = 1500, SPEED = 42;
  let labExtra = 0, labDown = 0, labSteps = 0;
  const $ = q => document.querySelector(q);
  const cv = $('#view'), g = cv.getContext('2d');
  const { drawText, textW, rng, hash, PR, drawEmote, WARM_MILK, DRINKS, INFERNAL_DRINKS } = SP;

  // ---------- stations ----------
  const ST = {
    work:     { spots: [], emote: 'write' },
    cauldron: { spots: [[50, 162], [94, 162]], emote: 'brew' },
    shelf:    { spots: [[40, 78], [40, 114], [40, 148]], emote: 'book' },
    bench:    { spots: [[98, 68], [112, 68]], emote: 'flask' },
    submit:   { spots: [[98, 108], [124, 108], [76, 132], [148, 132]], emote: 'write' },
    labwait:  { spots: [[76, 132], [148, 132], [112, 104]], emote: 'think' },
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

  // ---------- collision ----------
  const GRID = 8, WIZ_R = 5, CAT_R = 4, DRAGON_R = 8, TELEPORT_CHANCE = .05;
  const BLOCKERS = [
    { x: 264, y: 34, w: 8, h: 78 }, { x: 264, y: 168, w: 8, h: 92 },
    { x: 58, y: 154, w: 24, h: 18 },
    { x: 8, y: 58, w: 26, h: 34 }, { x: 8, y: 94, w: 26, h: 34 },
    { x: 86, y: 46, w: 38, h: 16 },
    { x: 216, y: 104, w: 16, h: 18 },
    { x: 299, y: 96, w: 28, h: 14 }, { x: 359, y: 116, w: 28, h: 14 },
    { x: 438, y: 72, w: 32, h: 24 },
    { x: 294, y: 194, w: 102, h: 25 },
    { x: 452, y: 40, w: 13, h: 14 },
  ];
  const bodyR = e => e && e.sp ? WIZ_R : e && e.frames ? DRAGON_R : CAT_R;
  const snap = v => Math.round(v / GRID) * GRID;
  const hitRect = (x, y, r, b) => x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h;
  const blocked = (x, y, r) => x < 18 - labExtra + r || x > 462 - r || y < 42 + r || y > (x < 264 ? 266 + labDown : 266) ||
    (labDown > 0 && hitRect(x, y, r, { x: 264, y: 260, w: 8, h: labDown })) || BLOCKERS.some(b => hitRect(x, y, r, b));
  function gridOpenNear(x, y, r) {
    let best = null, bd = 1e9, sx = snap(x), sy = snap(y);
    for (let d = 0; d <= 48; d += GRID) {
      for (let gx = sx - d; gx <= sx + d; gx += GRID) for (let gy = sy - d; gy <= sy + d; gy += GRID) {
        const ds = Math.hypot(gx - x, gy - y);
        if (ds < bd && !blocked(gx, gy, r)) { best = [gx, gy]; bd = ds; }
      }
      if (best) return best;
    }
    return clampZone(x, y);
  }
  function lineOpen(x1, y1, x2, y2, r) {
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 4));
    for (let i = 1; i <= n; i++) if (blocked(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n, r)) return false;
    return true;
  }
  function compactPath(pts) {
    const out = [];
    for (const p of pts) {
      const a = out[out.length - 2], b = out[out.length - 1];
      if (a && b && ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1]))) out[out.length - 1] = p;
      else out.push(p);
    }
    return out;
  }
  function route(sx, sy, tx, ty, r) {
    const dest = blocked(tx, ty, r) ? gridOpenNear(tx, ty, r) : [tx, ty];
    if (lineOpen(sx, sy, dest[0], dest[1], r)) return [[dest[0], dest[1]]];
    const start = gridOpenNear(sx, sy, r), goal = gridOpenNear(dest[0], dest[1], r), key = p => p[0] + ',' + p[1];
    const open = [{ p: start, g: 0, f: Math.hypot(goal[0] - start[0], goal[1] - start[1]), from: null }], seen = new Map([[key(start), open[0]]]);
    let found = null;
    while (open.length) {
      open.sort((a, b) => b.f - a.f);
      const cur = open.pop();
      if (cur.p[0] === goal[0] && cur.p[1] === goal[1]) { found = cur; break; }
      for (const [dx, dy] of [[GRID, 0], [-GRID, 0], [0, GRID], [0, -GRID]]) {
        const p = [cur.p[0] + dx, cur.p[1] + dy], k = key(p), g2 = cur.g + GRID;
        if (blocked(p[0], p[1], r) || (seen.has(k) && seen.get(k).g <= g2)) continue;
        const n = { p, g: g2, f: g2 + Math.hypot(goal[0] - p[0], goal[1] - p[1]), from: cur };
        seen.set(k, n); open.push(n);
      }
    }
    if (!found) return [[dest[0], dest[1]]];
    const pts = [];
    for (let n = found; n; n = n.from) pts.push(n.p);
    pts.reverse();
    const path = compactPath(pts).filter(p => Math.hypot(p[0] - sx, p[1] - sy) > 2);
    if (!path.length) path.push(goal);
    const last = path[path.length - 1];
    if (Math.hypot(last[0] - dest[0], last[1] - dest[1]) > 2 && lineOpen(last[0], last[1], dest[0], dest[1], r)) path.push(dest);
    return path;
  }

  const toolText = a => ((a && a.tool) || '') + ' ' + ((a && a.detail) || '');
  function submitKind(a) {
    const tool = ((a && a.tool) || '').toLowerCase(), detail = ((a && a.detail) || '').toLowerCase(), t = tool + ' ' + detail;
    const commandish = /bash|exec|shell|stdin|^git$|^gh$|^gt$|^jj$|graphite|jujutsu/.test(tool) || /(^|\s)(git|gh|gt|jj)\s+/.test(detail);
    if (!commandish && !/pull request|merge request/.test(t)) return null;
    if (/\b(graphite|gt\s+(submit|stack|sync|modify|restack|track|create|checkout))\b/.test(t)) return 'graphite';
    if (/\b(jujutsu|jj\s+(git|describe|new|squash|bookmark|rebase|status|diff|commit))\b/.test(t)) return 'jujutsu';
    if (/\b(git|gh)\b|pull request|merge request/.test(t)) return 'git';
    return null;
  }
  function testingMcp(a) {
    const t = ((a && a.tool) || '').toLowerCase();
    return t.startsWith('mcp__') || /^web|fetch|page|click|snapshot|script|console|chrome|browser|devtools|playwright/.test(t);
  }
  function testingActivity(a) {
    const t = ((a && a.tool) || '').toLowerCase();
    return t.startsWith('mcp__') || /^page|click|snapshot|script|console|chrome|browser|devtools|playwright/.test(t);
  }
  function waitingOnRun(a) {
    const tool = ((a && a.tool) || '').toLowerCase(), detail = ((a && a.detail) || '').toLowerCase();
    if (/\b(monitor|write_stdin|wait|watch|tail)\b/.test(tool)) return true;
    if (!/bash|exec|shell|stdin/.test(tool)) return false;
    return /\b(wait|watch|tail|test|tests|pytest|vitest|jest|playwright|npm|pnpm|yarn|bun|cargo|make|build|compile|lint|typecheck|server|dev server|running)\b/.test(detail);
  }
  function waitingOnQuestion(a) {
    const t = ((a && a.tool) || '').toLowerCase();
    return t === 'request_user_input' || /(^|[_-])ask[_-]?user/.test(t) || /question/.test(t);
  }
  function cafeWait(a) {
    return a && (a.status === 'waiting' || (a.status === 'working' && waitingOnQuestion(a)));
  }
  function toolStation(a) {
    const t = ((a && a.tool) || '').toLowerCase();
    if (cafeWait(a)) return 'cafe';
    if (submitKind(a)) return 'submit';
    if (testingMcp(a)) return 'crystal';
    if (/bash|^kill|exec|shell|stdin/.test(t)) return 'cauldron';
    if (/^(read|grep|glob|ls$|lsp|toolsearch|notebookread)/.test(t)) return 'shelf';
    if (/^(edit|write|notebookedit|apply)/.test(t)) return 'desk';
    if (/task|agent|workflow|skill/.test(t)) return 'circle';
    if (/todo|plan|sharepoint|onboarding/.test(t)) return 'desk';
    return 'bench';
  }
  const TOOL_EMOTE = { grep: 'search', glob: 'search', toolsearch: 'search' };

  // ---------- entities ----------
  const wizards = new Map();
  const desks = [], RITUALS = [];
  let sceneTime = 0;
  const atDesk = w => w.desk && !w.path.length && !w.leaving && !w.blast;
  let sel = null, hover = null, cafeChat = null, nextCafeChat = 10;
  let offline = false, isDemo = false, serverSkew = 0, lastData = { agents: [] };

  function clampZone(x, y) {
    const lab = x < 264;
    return [Math.max(lab ? 18 - labExtra : 282, Math.min(lab ? 252 : 462, x)), Math.max(46, Math.min(lab ? 250 + labDown : 250, y))];
  }
  function pathTo(w, tx, ty) {
    const path = route(w.x, w.y, tx, ty, bodyR(w)), last = path[path.length - 1], r = w.r || catR;
    if (last && Math.hypot(last[0] - w.x, last[1] - w.y) > 8 && r() < TELEPORT_CHANCE) {
      castTeleport(w, last[0], last[1], r);
      w.path = [];
      if (Math.abs(last[0] - w.x) > .4) w.dir = last[0] < w.x ? -1 : 1;
      w.x = last[0]; w.y = last[1];
    } else w.path = path;
    w.stuckAt = 0; w.lastX = w.x; w.lastY = w.y;
  }
  const DESK_FIXTURES = [
    { x: 56, y: 150, w: 30, h: 26 }, // cauldron
    { x: 8, y: 58, w: 26, h: 70 }, // shelves
    { x: 88, y: 42, w: 34, h: 20 }, // bench
    { x: 216, y: 98, w: 16, h: 24 }, // crystal
    { x: 160, y: 164, w: 52, h: 26 }, // summoning circle
  ];
  const quotaSpace = () => {
    const x = 236 - (Math.max(6, (lastData.quotas || []).length) - 1) * 22;
    return { x, y: 30, w: 260 - x, h: 58 };
  };
  const deskBounds = (x, y) => ({ x: x - 32, y: y - 30, w: 64, h: 54 });
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const labSize = steps => [Math.floor(steps / 3) * 72, (steps - Math.floor(steps / 3)) * 60];
  const fitsLab = (d, width, height) => d.x - 32 >= 8 - width && d.x + 32 <= 264 && d.y - 30 >= 34 && d.y + 24 <= 240 + height;
  function deskPosition(anchor, occupied, steps) {
    const [width, height] = labSize(steps);
    let best, distance = Infinity;
    // Search the whole usable floor, including gaps between fixtures.
    for (let y = 64; y <= 216 + height; y += 4) for (let x = 40 - width; x <= 232; x += 8) {
      const score = Math.hypot(x - anchor[0], y - anchor[1]);
      if (score >= distance || occupied.some(b => overlaps(deskBounds(x, y), b))) continue;
      best = [x, y]; distance = score;
    }
    return best;
  }
  function sizeLab(steps) {
    labSteps = steps;
    [labExtra, labDown] = labSize(steps);
    drawBackground(); resize();
  }
  function shrinkLab() {
    const before = labSteps;
    while (labSteps) {
      const [width, height] = labSize(labSteps - 1);
      const outside = desks.filter(d => !fitsLab(d, width, height));
      const occupied = [...DESK_FIXTURES, quotaSpace(), ...desks.filter(d => fitsLab(d, width, height)).map(d => deskBounds(d.x, d.y))];
      const moves = [];
      for (const d of outside) {
        const pos = d.active && deskPosition([d.x, d.y], occupied, labSteps - 1);
        if (!pos) break;
        moves.push([d, pos]); occupied.push(deskBounds(...pos));
      }
      if (moves.length !== outside.length) break;
      for (const [d, pos] of moves) { [d.x, d.y] = pos; d.w.home = pos; }
      labSteps--;
    }
    if (labSteps === before) return;
    sizeLab(labSteps);
    for (const actor of [...wizards.values(), cat, demonCat]) {
      const dest = actor.desk ? actor.home : actor.path.at(-1);
      if (actor.x < 18 - labExtra + bodyR(actor) || actor.x < 264 && actor.y > 266 + labDown)
        [actor.x, actor.y] = gridOpenNear(...clampZone(actor.x, actor.y), bodyR(actor));
      if (dest) actor.path = route(actor.x, actor.y, ...clampZone(...dest), bodyR(actor));
    }
  }
  function makeDesk(w) {
    const parent = wizards.get(w.a.parent), anchor = parent && parent.home || [100, 80];
    const occupied = [...DESK_FIXTURES, quotaSpace(), ...desks.filter(d => d.active || d.alpha > 0).map(d => deskBounds(d.x, d.y))];
    let pos, steps = 0;
    while (!(pos = deskPosition(anchor, occupied, steps))) steps++;
    if (steps > labSteps) sizeLab(steps);
    const [x, y] = pos;
    w.desk = { x, y, active: true, alpha: 0, elapsed: 0, w };
    desks.push(w.desk);
    return pos;
  }
  function release(w) {
    if (w.desk) { w.desk.active = false; w.desk = null; }
    if (w.station && w.spotI >= 0) ST[w.station].occ[w.spotI] = null;
    w.spotI = -1;
  }
  function retarget(w) {
    const key = placeFor(w);
    if (key === w.station && w.home) { w.emote = emoteFor(w); return; }
    release(w);
    const st = ST[key], i = st.occ.findIndex(o => !o);
    let pos;
    if (key === 'work') pos = makeDesk(w);
    else if (i >= 0) { st.occ[i] = w.a.id; w.spotI = i; pos = st.spots[i]; }
    else pos = clampZone(st.spots[0][0] + ((w.r() * 56 - 28) | 0), st.spots[0][1] + ((w.r() * 22 - 6) | 0));
    w.station = key; w.home = pos;
    pathTo(w, pos[0], pos[1]);
    w.emote = emoteFor(w);
  }
  function placeFor(w) {
    const s = w.a.status;
    if (cafeWait(w.a)) return 'cafe';
    if (['working', 'thinking', 'responding'].includes(s)) return 'work';
    if (s === 'attention') return 'board';
    if (s === 'idle') return 'hearth';
    if (s === 'done') return 'door';
    return w.station || 'bench';
  }
  function emoteFor(w) {
    const s = w.a.status;
    if (cafeWait(w.a)) return w.station === 'cafe' ? 'drink:' + ((w.order && w.order.drink || w.sp.drink).key) : null;
    if (s === 'working') return TOOL_EMOTE[(w.a.tool || '').toLowerCase()] || ST[toolStation(w.a)].emote || 'flask';
    return { attention: 'alert', thinking: 'think', responding: 'write', done: 'star',
             waiting: w.station === 'cafe' ? 'drink:' + ((w.order && w.order.drink || w.sp.drink).key) : null }[s] || null;
  }

  function reconcile(data) {
    for (let i = desks.length - 1; i >= 0; i--) {
      const d = desks[i];
      if (!overlaps(deskBounds(d.x, d.y), quotaSpace())) continue;
      if (d.w.desk === d) { d.w.desk = null; d.w.station = null; }
      desks.splice(i, 1);
    }
    const seen = new Set();
    for (const a of [...data.agents].sort((a, b) => Number(!!a.parent) - Number(!!b.parent))) {
      seen.add(a.id);
      let w = wizards.get(a.id);
      const demon = a.origin === 'remote';
      if (!w) {
        w = { a, sp: SP.makeWizard(a.id, a.kind, a.engine, demon), x: 436 + ((hash(a.id) % 9) - 4), y: 250, dir: -1, path: [], walk: false,
              station: null, spotI: -1, home: null, order: null, game: null, castAt: 0, rayAt: 0, blast: null, leaving: false,
              stuckAt: 0, lastX: 436, lastY: 250, alpha: 0, ph: (hash(a.id) % 100) / 16, r: rng(hash(a.id) ^ 0xbeef), emote: null };
        wizards.set(a.id, w);
        sparkleAt(436, 252);
        w.a = a; retarget(w);
        continue;
      }
      if (w.sp.demon !== demon) w.sp = SP.makeWizard(a.id, a.kind, a.engine, demon);
      const changed = !w.station || w.a.status !== a.status || (a.status === 'working' && (w.a.tool !== a.tool || w.a.detail !== a.detail)) || w.leaving;
      if (w.desk && ['waiting', 'done'].includes(a.status) && !['waiting', 'done'].includes(w.a.status)) {
        RITUALS.push({ desk: w.desk, x: w.desk.x, y: w.desk.y, at: sceneTime, seed: hash(w.a.id + ':desk') });
      }
      w.a = a;
      w.leaving = false;
      if (!cafeWait(a)) {
        if (w.order && w.order.stage !== 'served') w.order = null;
        leaveGameForWizard(w, 0);
      }
      if (changed) { w.castAt = 0; retarget(w); }
    }
    for (const [id, w] of wizards) if (!seen.has(id) && !w.leaving) { leaveGameForWizard(w, 0); w.leaving = true; release(w); w.station = null; pathTo(w, 436, 250); w.path.push([436, 266]); }
  }

  // ---------- cat & barista ----------
  const catFrames = SP.makeCat();
  const cat = { x: 446, y: 110, state: 'sit', until: 4, path: [], dir: -1, dest: null, order: null, game: null, castAt: 0, rayAt: 0 };
  const catR = rng(99);
  cat.r = catR;
  const demonCat = { frames: SP.makeCat(true), x: 446, y: 110, active: false, path: [], dir: -1, alpha: 0, until: 0, summonAt: 24, dest: null, order: null, rayAt: 0 };
  const demonCatR = rng(666);
  demonCat.r = demonCatR;
  const CAT_SPECIALS = DRINKS.filter(d => ['health-potion', 'mana-potion', 'antimatter'].includes(d.key));
  const catDrink = () => catR() < .8 ? WARM_MILK : CAT_SPECIALS[catR() * CAT_SPECIALS.length | 0];
  function catThink(t) {
    if (cat.game) return;
    if (cat.state === 'cafe') cat.order = null;
    cat.dest = null;
    const roll = catR();
    if (roll < .08) sendCatToCafe(t);
    else if (roll < .38) { cat.state = 'sleep'; cat.until = t + 6 + catR() * 8; pathTo(cat, 440, 112); }
    else if (roll < .64) { cat.state = 'sit'; cat.until = t + 4 + catR() * 5; }
    else {
      const ws = [...wizards.values()];
      const pal = ws.length && catR() < .5 ? ws[catR() * ws.length | 0] : null;
      const target = pal ? [pal.x + 12, pal.y] : clampZone(catR() * (VW + labExtra) - labExtra, 60 + catR() * 180);
      pathTo(cat, target[0], target[1]);
      cat.state = 'walk'; cat.until = t + 20;
    }
  }
  // Earl Grey roasts the house beans himself.
  const barY = 196, DRAGON_HOME = [338, barY], DRAGON_STRETCH = [[304, 66], [420, 54], [448, 126], [286, 148]], dragonR = rng(777);
  const dragon = { frames: SP.makeDragon(), x: DRAGON_HOME[0], y: DRAGON_HOME[1], dir: -1, path: [], dest: null, mode: null, stretchUntil: -9, roastAt: 7, roastUntil: -9, flapAt: 45 + dragonR() * 60, flapUntil: -9, task: null, game: null, blast: null };
  const PAN = [324, 196];
  const CUP = [316, 187], CAT_CAFE = [404, 226];

  function sendCatToCafe(t) {
    pathTo(cat, CAT_CAFE[0], CAT_CAFE[1]);
    cat.state = 'walk';
    cat.dest = 'cafe';
    cat.until = t + 40;
  }
  function cafeReady(w) {
    return cafeWait(w.a) && w.station === 'cafe' && !w.walk && !w.leaving && w.alpha > .8;
  }
  function chatSubject(a) {
    const raw = a.title || a.quest || a.project || 'THAT QUEST';
    return raw.toUpperCase().replace(/[^A-Z0-9 .!?-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
  }
  function maybeCafeChat(t) {
    if (cafeChat && t >= cafeChat.until) cafeChat = null;
    if (cafeChat || t < nextCafeChat) return;
    const ready = [...wizards.values()].filter(w => cafeReady(w) && w.order && w.order.stage === 'served' && !w.game);
    const pairs = [];
    for (let i = 0; i < ready.length; i++) for (let j = i + 1; j < ready.length; j++)
      if (ready[i].a.project === ready[j].a.project) pairs.push([ready[i], ready[j]]);
    nextCafeChat = t + 28 + Math.random() * 24;
    if (!pairs.length) return;
    const [a, b] = pairs[Math.random() * pairs.length | 0];
    const recent = [...(b.a.history || [])].reverse().find(h => h.tool);
    const tool = recent && String(recent.tool).toUpperCase().replace(/[^A-Z0-9 -]/g, ' ').replace(/\s+/g, ' ').slice(0, 18);
    cafeChat = { a: a.a.id, b: b.a.id, start: t, until: t + 8,
      lines: [`HOW GOES ${chatSubject(b.a)}?`, tool ? `I LAST TRIED ${tool}.` : 'THE RUNES ARE YET UNCLEAR.'] };
  }
  function ensureOrder(w, t) {
    if (cafeReady(w) && !w.order) w.order = { drink: w.sp.drink, stage: 'queued', askAt: t + w.r() * 1.2, servedAt: 0 };
  }
  function cafeCustomers() {
    const cs = [];
    for (const w of wizards.values()) if (cafeReady(w) && w.order) cs.push({ kind: 'wizard', id: w.a.id, order: w.order, drink: w.order.drink, x: w.x, y: w.y });
    if (cat.state === 'cafe' && !cat.path.length && cat.order) cs.push({ kind: 'cat', id: 'cat', order: cat.order, drink: cat.order.drink, x: cat.x, y: cat.y });
    if (demonCat.active && !demonCat.path.length && demonCat.order) cs.push({ kind: 'demon-cat', id: 'demon-cat', order: demonCat.order, drink: demonCat.order.drink, x: demonCat.x, y: demonCat.y });
    return cs;
  }
  function taskCustomer(task) {
    if (task.kind === 'cat') return cat.state === 'cafe' && cat.order === task.order ? { kind: 'cat', id: 'cat', order: cat.order, drink: cat.order.drink, x: cat.x, y: cat.y } : null;
    if (task.kind === 'demon-cat') return demonCat.active && demonCat.order === task.order ? { kind: 'demon-cat', id: 'demon-cat', order: demonCat.order, drink: demonCat.order.drink, x: demonCat.x, y: demonCat.y } : null;
    const w = wizards.get(task.id);
    return w && cafeReady(w) && w.order === task.order ? { kind: 'wizard', id: w.a.id, order: w.order, drink: w.order.drink, x: w.x, y: w.y } : null;
  }
  function dragonAtBar() {
    return !dragon.blast && !dragon.game && !dragon.dest && !dragon.path.length && Math.hypot(dragon.x - DRAGON_HOME[0], dragon.y - DRAGON_HOME[1]) < 2;
  }
  function sendDragonTo(x, y, dest, t) {
    dragon.mode = 'fly';
    dragon.dest = dest;
    dragon.roastUntil = -9;
    dragon.path = [[x, y]];
    dragon.flapUntil = Math.max(dragon.flapUntil, t + 2);
  }
  function sendDragonHome(t) {
    dragon.game = null;
    if (Math.hypot(dragon.x - DRAGON_HOME[0], dragon.y - DRAGON_HOME[1]) < 2) {
      dragon.x = DRAGON_HOME[0]; dragon.y = DRAGON_HOME[1]; dragon.dest = dragon.mode = null; dragon.path = [];
    } else sendDragonTo(DRAGON_HOME[0], DRAGON_HOME[1], 'bar', t);
  }
  function maybeDragonStretch(t) {
    if (!dragonAtBar() || dragon.task || t <= dragon.flapAt || t < dragon.roastUntil) return;
    if (cafeCustomers().some(c => c.order.stage !== 'served')) { dragon.flapAt = t + 12 + dragonR() * 18; return; }
    const p = DRAGON_STRETCH[dragonR() * DRAGON_STRETCH.length | 0];
    sendDragonTo(p[0], p[1], 'stretch', t);
    dragon.flapAt = t + 75 + dragonR() * 90;
  }
  function startDrink(c, t) {
    c.order.stage = 'brewing';
    dragon.roastUntil = dragon.flapUntil = -9;
    dragon.task = { kind: c.kind, id: c.id, order: c.order, drink: c.drink, phase: 'brew', until: t + 1.45 };
  }
  function cafeService(t) {
    for (const w of wizards.values()) ensureOrder(w, t);
    if (dragon.blast) return;
    if (dragon.game && cafeCustomers().some(c => c.order.stage !== 'served')) leaveGameForDragon(t);
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
    if (!dragon.task && dragonAtBar()) {
      const next = cafeCustomers().filter(c => c.order.stage === 'queued' && t >= c.order.askAt).sort((a, b) => a.order.askAt - b.order.askAt)[0];
      if (next) startDrink(next, t);
    }
  }

  // ---------- table games ----------
  const COURT = { id: 'court', x: 368, y: 164, seats: [[310, 170], [426, 170]], types: ['badminton', 'pingpong'], game: null, burnUntil: 0 };
  const TABLES = [
    COURT,
    { id: 't1', x: 313, y: 101, seats: [[292, 112], [332, 112], [313, 84]], game: null, burnUntil: 0 },
    { id: 't2', x: 373, y: 121, seats: [[352, 132], [392, 132], [373, 104]], game: null, burnUntil: 0 },
  ];
  const GAME_TYPES = ['magic', 'chess', 'go'], tableR = rng(4242);
  const tableById = id => TABLES.find(t => t.id === id);
  const gameName = g => g === 'magic' ? 'MAGIC THE GATHERING' : g === 'pingpong' ? 'PING PONG' : g.toUpperCase();
  const gameHas = (table, kind, id) => !!table.game && table.game.players.some(p => p.kind === kind && (!id || p.id === id));
  function waitingForGame(w) {
    return cafeReady(w) && !w.game && w.order && w.order.stage === 'served';
  }
  function releaseGamePlayer(p, t) {
    if (p.kind === 'wizard') {
      const w = wizards.get(p.id);
      if (w) { w.game = null; if (!w.leaving && cafeWait(w.a)) { w.station = null; w.home = null; retarget(w); } }
    } else if (p.kind === 'cat') {
      cat.game = null;
      if (cat.state === 'game' || cat.dest === 'game') { cat.dest = null; catThink(t); }
    } else { dragon.game = null; }
  }
  function leaveGameForWizard(w, t) {
    if (!w || !w.game) return;
    const table = tableById(w.game);
    if (table && table.game) table.game.players = table.game.players.filter(p => !(p.kind === 'wizard' && p.id === w.a.id));
    w.game = null;
  }
  function leaveGameForDragon(t) {
    if (!dragon.game) return;
    const table = tableById(dragon.game);
    if (table && table.game) table.game.players = table.game.players.filter(p => p.kind !== 'dragon');
    sendDragonHome(t);
    if (table && table.game && table.game.players.length < 2) endGame(table, t, false);
  }
  function endGame(table, t, burn) {
    if (!table.game) return;
    const players = table.game.players.slice();
    table.game = null;
    table.nextAt = t + 8;
    if (burn) table.burnUntil = t + 2;
    players.forEach(p => releaseGamePlayer(p, t));
  }
  function seatPlayer(table, p, i, t) {
    p.seat = i;
    const [x, y] = table.seats[i];
    if (p.kind === 'wizard') {
      const w = wizards.get(p.id);
      if (!w) return false;
      release(w); w.game = table.id; w.station = 'cafe'; w.home = [x, y]; w.emote = null; pathTo(w, x, y);
    } else if (p.kind === 'cat') {
      cat.game = table.id; cat.order = null; cat.dest = 'game'; cat.state = 'walk'; cat.until = t + 120; pathTo(cat, x, y);
    } else return false;
    return true;
  }
  function canUseCat() {
    return !cat.game && !cat.path.length && cat.state !== 'walk' && cat.state !== 'sleep' && cat.state !== 'cafe';
  }
  function startGame(table, players, t) {
    const types = table.types || GAME_TYPES;
    table.game = { type: types[tableR() * types.length | 0], players, started: t, until: t + 28 + tableR() * 28 };
    table.game.players = players.filter((p, i) => seatPlayer(table, p, i, t));
    if (table.game.players.length < 2) endGame(table, t, false);
  }
  function updateTableGames(t) {
    for (const table of (tableR() < .5 ? TABLES : [...TABLES].reverse())) {
      if (table.game) {
        table.game.players = table.game.players.filter(p => {
          if (p.kind === 'wizard') {
            const w = wizards.get(p.id);
            return w && !w.leaving && cafeWait(w.a);
          }
          if (p.kind === 'cat') return cat.game === table.id;
          return false;
        });
        if (table.game.players.length < 2 || t > table.game.until) endGame(table, t, false);
        else if (table === COURT) updateRally(table, t);
      }
      if (table.game || t < table.burnUntil || t < (table.nextAt || 0)) continue;
      const ws = [...wizards.values()].filter(w => waitingForGame(w)).sort((a, b) => (a.a.started || 0) - (b.a.started || 0));
      if (!ws.length || (table === COURT && ws.length < 2)) continue;
      const players = [{ kind: 'wizard', id: ws[0].a.id }];
      if (ws[1]) players.push({ kind: 'wizard', id: ws[1].a.id });
      if (table !== COURT && canUseCat()) players.push({ kind: 'cat' });
      if (table !== COURT && players.length > 1 && players.length < 3 && !players.some(p => p.kind === 'cat') && canUseCat() && tableR() < .35) players.push({ kind: 'cat' });
      if (players.length > 1) startGame(table, players, t);
    }
  }
  function updateRally(table, t) {
    const game = table.game, ws = game.players.map(p => wizards.get(p.id));
    if (t < game.started + 2) return;
    ws.forEach((w, i) => { if (w) w.dir = i ? -1 : 1; });
    if (ws.some(w => !w || w.blast || w.path.length)) return;
    ws.forEach(w => { [w.x, w.y] = w.home; });
    if (game.rally && t < game.rally.start + game.rally.duration) return;
    const hitter = game.rally ? game.rally.receiver : 0, receiver = 1 - hitter;
    const w = ws[hitter], other = ws[receiver], seat = table.seats[receiver];
    const x = seat[0] + (tableR() * 8 - 4), y = seat[1] + (tableR() * 20 - 10);
    other.home = [x, y]; other.path = route(other.x, other.y, x, y, WIZ_R);
    game.rally = { start: t, duration: game.type === 'badminton' ? 1.35 : .85, receiver,
      from: [w.x + (hitter ? -10 : 10), w.y - 14], to: [x + (receiver ? -10 : 10), y - 14],
      hits: (game.rally ? game.rally.hits : 0) + 1 };
    game.players[hitter].hitAt = t;
  }
  function rallyPosition(game, t) {
    const r = game.rally, k = Math.max(0, Math.min(1, (t - r.start) / r.duration));
    const arc = game.type === 'badminton' ? Math.sin(k * Math.PI) * 28 :
      k < .75 ? Math.sin(k / .75 * Math.PI) * 12 : Math.sin((k - .75) / .25 * Math.PI) * 5;
    return [r.from[0] + (r.to[0] - r.from[0]) * k, r.from[1] + (r.to[1] - r.from[1]) * k - arc];
  }
  function drawCourt(gg, t) {
    if (!COURT.game) return;
    const { x, y } = COURT, badminton = COURT.game.type === 'badminton';
    const p = Math.min(1, Math.max(0, (t - COURT.game.started) / 2));
    if (p < 1) PR.summon(gg, x, y, p);
    gg.save(); gg.globalAlpha = p;
    gg.beginPath(); gg.rect(x - 58, y + 23 - 66 * p, 116, 66 * p); gg.clip();
    if (badminton) PR.badmintonCourt(gg, x, y);
    else PR.pingPongTable(gg, x, y);
    gg.restore();
  }
  function drawRally(t) {
    const game = COURT.game;
    if (!game) return;
    const badminton = game.type === 'badminton';
    for (const [i, p] of game.players.entries()) {
      const w = wizards.get(p.id);
      if (!w || w.blast) continue;
      const side = i ? -1 : 1, swing = Math.max(0, 1 - (t - (p.hitAt ?? -1)) / .22);
      g.save(); g.globalAlpha = Math.max(0, Math.min(1, (t - game.started - .5) / 1.5));
      g.translate(Math.round(w.x + side * 10), Math.round(w.y - 14)); g.rotate(side * swing * .8);
      g.fillStyle = '#c8a678'; g.fillRect(-1, 2, 2, 6);
      if (badminton) {
        g.strokeStyle = '#eee6c6'; g.lineWidth = 1; g.beginPath(); g.ellipse(0, -2, 4, 6, 0, 0, Math.PI * 2); g.stroke();
        g.fillStyle = '#a4c5cf'; g.fillRect(-2, -2, 5, 1); g.fillRect(0, -4, 1, 6);
      } else { g.fillStyle = i ? '#6c9ade' : '#e77568'; g.fillRect(-3, -4, 6, 6); }
      g.restore();
    }
    if (!game.rally) return;
    const [x, y] = rallyPosition(game, t), r = game.rally;
    g.save(); g.translate(Math.round(x), Math.round(y));
    if (badminton) {
      const [nx, ny] = rallyPosition(game, Math.min(t + .02, r.start + r.duration));
      g.rotate(Math.atan2(ny - y, nx - x));
      g.fillStyle = '#f7f3e8';
      g.fillRect(-6, -3, 2, 7); g.fillRect(-4, -2, 2, 5); g.fillRect(-2, -1, 2, 3);
      g.fillStyle = '#d9b77d'; g.fillRect(0, -1, 3, 3);
    } else { g.fillStyle = '#fff5d6'; g.fillRect(-1, -1, 3, 3); }
    g.restore();
  }
  function burnGameAt(x, y, t) {
    const table = TABLES.find(tb => tb.game && !gameHas(tb, 'cat') && Math.abs(x - tb.x) < 20 && Math.abs(y - tb.y) < 16);
    if (!table) return false;
    endGame(table, t, true);
    for (let i = 0; i < 12; i++) spark(table.x + (Math.random() * 20 - 10), table.y + (Math.random() * 10 - 5), Math.random() < .5 ? '#ffd84a' : '#f08a2a', -10, .7);
    return true;
  }

  // ---------- particles ----------
  const PARTS = [];
  const SPELLS = [];
  const battleR = rng(31337);
  const BATTLE_COOLDOWN = 180, BATTLE_COOLDOWN_JITTER = 120, EARL_GREY_TARGET_CHANCE = .08;
  let nextBattle = 45 + battleR() * 45, battleUntil = 0, battleApprentice = null;
  const SPELL_TARGETS = {
    cauldron: [[68, 154], [80, 154]], shelf: [[24, 68], [24, 104], [24, 140]],
    bench: [[98, 50], [112, 50]], submit: [[112, 118], [84, 126], [140, 126]], labwait: [[112, 118], [92, 130], [132, 130]], desk: [[108, 204], [152, 204]],
    crystal: [[223, 102]], circle: [[186, 176]], board: [[314, 28], [300, 28]],
  };
  function spark(x, y, c, vy, life, kind) {
    if (PARTS.length > 220) return;
    PARTS.push({ x: x + Math.random() * 4 - 2, y, vx: Math.random() * 8 - 4, vy, c, life, t: 0, kind });
  }
  function radialBurst(x, y, colors, n, speed, life) {
    for (let i = 0; i < n && PARTS.length <= 220; i++) {
      const a = i / n * Math.PI * 2 + Math.random() * .25, v = speed * (.65 + Math.random() * .7);
      PARTS.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3,
        c: colors[i % colors.length], life: life * (.7 + Math.random() * .5), t: 0 });
    }
  }
  const sparkleAt = (x, y) => { for (let i = 0; i < 6; i++) spark(x, y - 10 - Math.random() * 10, '#ffe89a', -4, .8); };
  function teleportBurst(x, y, c) {
    for (let i = 0; i < 10; i++) spark(x + Math.cos(i) * 5, y - 13 + Math.sin(i * 2) * 5, c, -4 - Math.random() * 7, .55);
  }
  function castTeleport(e, tx, ty, r, color) {
    const catBlink = !e.sp, c = color || (catBlink ? '#d8ff58' : '#c8b4ff');
    SPELLS.push({ kind: 'teleport', source: catBlink ? null : e.a.id, sx: e.x, sy: e.y - (catBlink ? 8 : 18), tx, ty: ty - (catBlink ? 8 : 18), t: 0, life: .75, seed: r() * 99 | 0, c });
    teleportBurst(e.x, e.y, c);
    teleportBurst(tx, ty, c);
  }
  function spellTarget(w) {
    const spots = SPELL_TARGETS[w.station], p = spots ? spots[w.r() * spots.length | 0] : (w.home || [w.x, w.y]);
    return [p[0] + ((w.r() * 14 - 7) | 0), p[1] + ((w.r() * 10 - 5) | 0)];
  }
  function catSpellTarget() {
    const games = TABLES.filter(t => t.game && !gameHas(t, 'cat'));
    if (games.length && catR() < .35) {
      const table = games[catR() * games.length | 0];
      return [table.x + ((catR() * 14 - 7) | 0), table.y + ((catR() * 10 - 5) | 0)];
    }
    const cafe = cat.x > 268, x = cafe ? 286 + catR() * 160 : 24 + catR() * 220;
    return [x | 0, (52 + catR() * 178) | 0];
  }
  function castSpell(w, t) {
    if (SPELLS.length > 36) return;
    const kinds = w.sp.demon ? ['hellfire', 'brimstone', 'hex', 'void'] : ['fireball', 'bolt', 'missile', 'spark', 'rune', 'rain', 'storm'];
    const kind = kinds[w.r() * kinds.length | 0];
    const [tx, ty] = spellTarget(w), sx = w.x + (w.dir > 0 ? 7 : -7), sy = w.y - 17;
    if (kind === 'rain' || kind === 'storm') {
      SPELLS.push({ kind, source: w.a.id, sx: w.x, sy: w.y - 34, t: 0, life: 2.4 + w.r() * 1.2, seed: w.r() * 99 | 0 });
      spark(w.x, w.y - 30, SPELL_EYES[kind], -4, .4);
      return;
    }
    SPELLS.push({ kind, source: w.a.id, sx, sy, tx, ty, t: 0, life: kind === 'bolt' ? .24 : .65 + w.r() * .35, seed: w.r() * 99 | 0 });
    spark(sx, sy, ['hellfire', 'brimstone'].includes(kind) ? '#f05a3a' : kind === 'fireball' ? '#ffd84a' : kind === 'bolt' ? '#e8f6ff' : '#c8b4ff', -5, .35);
  }
  function castCatSpell(t) {
    if (SPELLS.length > 36) return;
    const kinds = ['missile', 'spark', 'rune', 'bolt', 'rain', 'storm'], kind = kinds[catR() * kinds.length | 0];
    const [tx, ty] = catSpellTarget(), sx = cat.x + (cat.dir > 0 ? 7 : -7), sy = cat.y - 8;
    if (kind === 'rain' || kind === 'storm') {
      SPELLS.push({ kind, cat: true, sx: cat.x, sy: cat.y - 24, t: 0, life: 2 + catR() * 1, seed: catR() * 99 | 0 });
      spark(cat.x, cat.y - 20, SPELL_EYES[kind], -4, .4);
      return;
    }
    SPELLS.push({ kind, sx, sy, tx, ty, t: 0, life: kind === 'bolt' ? .24 : .55 + catR() * .3, seed: catR() * 99 | 0 });
    spark(sx, sy, '#d8ff58', -5, .35);
  }
  function rayOpponent(w) {
    const rivals = [...wizards.values()].filter(v => v !== w && v.sp.demon !== w.sp.demon && !v.leaving && !v.walk && !v.game && !v.blast && v.alpha > .8 &&
      !SPELLS.some(s => s.kind === 'ray' && s.target === v.a.id));
    if (dragonAtBar() && w.r() < EARL_GREY_TARGET_CHANCE && !SPELLS.some(s => s.kind === 'ray' && s.target === 'dragon')) rivals.push(dragon);
    return rivals.length ? rivals[w.r() * rivals.length | 0] : null;
  }
  function combatHelpers(w, opponent) {
    const helpers = [...wizards.values()].filter(v => v !== w && v !== opponent && v.sp.demon === w.sp.demon && v.a.kind !== w.a.kind &&
      !v.leaving && !v.game && !v.blast && v.alpha > .8);
    return helpers.filter(v => v.a.kind !== 'sub' || v.a.id === battleApprentice).map(v => v.a.id);
  }
  function castRay(w, target, catCaster = false) {
    const demon = catCaster ? w === demonCat : w.sp.demon, c = demon ? '#f05a3a' : catCaster ? '#d8ff58' : '#8fd0ff';
    const source = catCaster ? w === cat ? 'cat' : 'demon-cat' : w.a.id, targetId = target === dragon ? 'dragon' : target.a.id;
    const helpers = catCaster ? [] : combatHelpers(w, target);
    const attackers = target === dragon ? helpers.slice(0, 1) : helpers, defenders = catCaster || target === dragon ? [] : combatHelpers(target, w);
    w.dir = target.x < w.x ? -1 : 1;
    const sy = w.y - (catCaster ? 8 : 17), ty = target.y - (target === dragon ? 15 : 14);
    SPELLS.push({ kind: 'ray', source, target: targetId, cat: catCaster, attackers, defenders, sx: w.x + w.dir * 7, sy,
      tx: target.x, ty, t: 0, life: .32, seed: w.r() * 99 | 0, c });
    spark(w.x + w.dir * 7, sy, c, -5, .35);
  }
  function updateBattle(t) {
    if (battleUntil) {
      if (t < battleUntil) return;
      battleUntil = 0;
      battleApprentice = null;
      nextBattle = t + BATTLE_COOLDOWN + battleR() * BATTLE_COOLDOWN_JITTER;
    }
    if (t < nextBattle || !wizards.size) return;
    battleUntil = t + 4 + battleR() * 2;
    const apprentices = [...wizards.values()].filter(w => w.a.kind === 'sub' && !w.leaving && !w.game && !w.blast && w.alpha > .8);
    battleApprentice = apprentices.length ? apprentices[battleR() * apprentices.length | 0].a.id : null;
    for (const w of wizards.values()) w.rayAt = t + w.r() * 1.2;
    cat.rayAt = t + catR() * 1.2;
    demonCat.rayAt = t + demonCatR() * 1.2;
  }
  function maybeRay(w, t) {
    if (!battleUntil || t >= battleUntil) return false;
    if (!w.rayAt) w.rayAt = t + w.r() * 1.2;
    if (t < w.rayAt || w.walk || w.leaving || w.game || w.blast || w.alpha < .8) return false;
    w.rayAt = t + 3 + w.r() * 3;
    const target = rayOpponent(w);
    if (!target) return false;
    castRay(w, target);
    return true;
  }
  function maybeCatRay(c, t) {
    if (!battleUntil || t >= battleUntil || c === demonCat && !c.active) return false;
    if (!c.rayAt) c.rayAt = t + c.r() * 1.2;
    if (t < c.rayAt || c.path.length || c.game || c.state === 'walk' || c.state === 'sleep' || c.alpha !== undefined && c.alpha < .8) return false;
    c.rayAt = t + 3.5 + c.r() * 3;
    const targets = [...wizards.values()].filter(w => !w.leaving && !w.walk && !w.game && !w.blast && w.alpha > .8 &&
      !SPELLS.some(s => s.kind === 'ray' && s.target === w.a.id));
    if (dragonAtBar() && c.r() < EARL_GREY_TARGET_CHANCE && !SPELLS.some(s => s.kind === 'ray' && s.target === 'dragon')) targets.push(dragon);
    if (!targets.length) return false;
    castRay(c, targets[c.r() * targets.length | 0], true);
    return true;
  }
  function maybeCast(w, t) {
    if (w.a.status !== 'working' || cafeWait(w.a) || w.walk || w.leaving || w.blast || w.alpha < .8 || !w.home) return;
    if (!w.castAt) w.castAt = t + .8 + w.r() * 2.8;
    if (t > w.castAt) {
      w.castAt = t + 2.4 + w.r() * 4.8;
      if (w.r() < .7) castSpell(w, t);
    }
  }
  function maybeCatCast(t) {
    if (cat.state === 'walk' || cat.state === 'sleep' || cat.path.length) return;
    if (!cat.castAt) cat.castAt = t + 4 + catR() * 8;
    if (t > cat.castAt) {
      cat.castAt = t + 7 + catR() * 13;
      if (catR() < .55) castCatSpell(t);
    }
  }
  function updateDemonCat(dt, t) {
    if (!demonCat.active) {
      if (t < demonCat.summonAt || cat.state === 'walk' || cat.state === 'sleep') return;
      [demonCat.x, demonCat.y] = clampZone(cat.x + (cat.x > 268 ? -18 : 18), cat.y + 3);
      const drink = INFERNAL_DRINKS[hash('lucipurr:drink') % INFERNAL_DRINKS.length];
      Object.assign(demonCat, { active: true, alpha: 0, until: t + 48 + demonCatR() * 10, dest: 'cafe',
        order: { drink, stage: 'queued', askAt: t + 3, servedAt: 0 }, path: [] });
      castTeleport(cat, demonCat.x, demonCat.y, demonCatR, '#f08a2a');
      pathTo(demonCat, 414, 226);
      return;
    }
    demonCat.alpha = Math.min(1, demonCat.alpha + dt * 3);
    if (t >= demonCat.until) {
      teleportBurst(demonCat.x, demonCat.y, '#f08a2a');
      demonCat.active = false;
      demonCat.order = demonCat.dest = null;
      demonCat.summonAt = t + 45 + demonCatR() * 55;
      return;
    }
    if (demonCat.path.length) moveAlong(demonCat, dt, 24);
    else demonCat.dest = null;
    if (Math.random() < dt * .7) spark(demonCat.x, demonCat.y - 8, '#f08a2a', -5, .6);
  }
  function fragmentImage(img, r) {
    const pixels = img.getContext('2d').getImageData(0, 0, img.width, img.height).data;
    const fragments = [];
    for (let sy = 0; sy < img.height; sy += 4) for (let sx = 0; sx < img.width; sx += 4) {
      let visible = false;
      for (let y = sy; y < Math.min(sy + 4, img.height) && !visible; y++) for (let x = sx; x < Math.min(sx + 4, img.width); x++) {
        if (pixels[(y * img.width + x) * 4 + 3]) { visible = true; break; }
      }
      if (!visible) continue;
      const a = Math.atan2(sy - img.height / 2, sx - img.width / 2) + (r() - .5) * 1.2, speed = 12 + r() * 22;
      fragments.push({ sx, sy, w: Math.min(4, img.width - sx), h: Math.min(4, img.height - sy),
        dx: Math.cos(a) * speed, dy: Math.sin(a) * speed - 8 - r() * 8, spin: (r() - .5) * 3 });
    }
    return fragments;
  }
  function explodeWizard(w, t, soot = false) {
    if (!w || w.leaving || w.blast) return;
    const img = w.sp.frames.idleA, demon = w.sp.demon;
    w.blast = { at: t, until: t + 2.4, img, fragments: fragmentImage(img, w.r), soot, demon,
      seed: w.r() * 99, ox: -10, oy: -23 };
    const colors = soot ? ['#322c35', '#77717d', '#f08a2a'] : demon ? ['#f05a3a', '#f08a2a', '#ffd84a'] : ['#8fd0ff', '#e8f6ff', '#ffe89a'];
    radialBurst(w.x, w.y - 13, colors, 28, 24, 1.05);
    for (let i = 0; i < 10; i++) spark(w.x, w.y - 13, colors[i % colors.length], -18 + Math.random() * 14, .9);
  }
  function reformWizard(w) {
    const colors = w.sp.demon ? ['#f05a3a', '#f08a2a', '#ffd84a'] : ['#8fd0ff', '#c8b4ff', '#ffe89a'];
    radialBurst(w.x, w.y - 13, colors, 18, 13, .8);
    for (let i = 0; i < 10; i++) spark(w.x + (i % 2 ? -7 : 7), w.y - 4 - i * 2, colors[i % colors.length], -5, .7);
  }
  function explodeDragon(t) {
    if (dragon.blast) return;
    const img = dragon.frames.idleA;
    dragon.blast = { at: t, until: t + 2.8, img, fragments: fragmentImage(img, dragonR),
      seed: dragonR() * 99, demon: true, ox: -15, oy: -25 };
    for (let i = 0; i < 24; i++) spark(dragon.x, dragon.y - 14, i % 2 ? '#f08a2a' : '#ffe89a', -18 + Math.random() * 24, 1);
  }
  function castDragonFire(target, delay) {
    if (dragon.blast || !target || target.leaving || target.blast) return;
    SPELLS.push({ kind: 'counterfire', target: target.a.id, sx: dragon.x - 13, sy: dragon.y - 15,
      tx: target.x, ty: target.y - 13, t: -delay, life: .65, seed: dragonR() * 99 | 0 });
  }
  function updateSpells(dt, t) {
    for (let i = SPELLS.length - 1; i >= 0; i--) {
      const s = SPELLS[i];
      s.t += dt;
      if (s.t <= s.life) continue;
      if (s.kind === 'ray') {
        if (s.target === 'dragon') {
          s.tx = dragon.x; s.ty = dragon.y - 15;
          if (s.cat) explodeDragon(t);
          else [s.source, ...s.attackers].map(id => wizards.get(id)).filter(Boolean).forEach((w, j) => castDragonFire(w, j * .72));
        } else {
          const target = wizards.get(s.target);
          if (target) {
            s.tx = target.x; s.ty = target.y - 14;
            const source = wizards.get(s.source), loser = !s.cat && source && s.defenders.length > s.attackers.length ? source : target;
            explodeWizard(loser, t);
          }
        }
      } else if (s.kind === 'counterfire') {
        const target = wizards.get(s.target);
        if (target) { s.tx = target.x; s.ty = target.y - 13; explodeWizard(target, t, true); }
      } else if (s.kind === 'teleport') spark(s.tx, s.ty, s.c, -4, .4);
      else if (s.kind === 'fireball') sparkleAt(s.tx, s.ty);
      else if (s.kind !== 'rain' && s.kind !== 'storm') {
        if (s.cat) burnGameAt(s.tx, s.ty, t);
        spark(s.tx, s.ty, ['hellfire', 'brimstone'].includes(s.kind) ? '#f05a3a' : s.kind === 'bolt' ? '#e8f6ff' : '#c8b4ff', -4, .4);
      }
      SPELLS.splice(i, 1);
    }
  }

  // ---------- world ----------
  const WALL = '#3a3144', WALL_D = '#262032', WALL_HI = '#4a3f5c';
  const bg = document.createElement('canvas');
  function drawBackground() {
    bg.width = VW + labExtra; bg.height = VH + labDown;
    const b = bg.getContext('2d'), r = rng(5);
    b.translate(labExtra, 0);
    b.fillStyle = '#46414f'; b.fillRect(8 - labExtra, 34, 256 + labExtra, 226 + labDown);
    for (let ty = 34; ty < 260 + labDown; ty += 16) for (let tx = 8 - labExtra; tx < 264; tx += 16)
      if (((tx + ty) / 16) % 2) { b.fillStyle = '#423d4b'; b.fillRect(tx, ty, 16, 16); }
    for (let i = 0; i < 70; i++) { b.fillStyle = r() < .5 ? '#3c3846' : '#4c4756'; b.fillRect(8 + (r() * 254 | 0), 34 + (r() * 222 | 0), r() < .3 ? 2 : 1, 1); }
    for (let ry = 34; ry < 260; ry += 8) {
      b.fillStyle = ((ry / 8) | 0) % 2 ? '#684832' : '#5f422c'; b.fillRect(264, ry, 208, 8);
      b.fillStyle = '#53391f';
      for (let sx = 264 + ((ry / 8) % 3) * 24; sx < 472; sx += 72) b.fillRect(sx, ry, 1, 8);
      b.fillRect(264, ry + 7, 208, 1);
    }
    b.fillStyle = WALL; b.fillRect(-labExtra, 0, VW + labExtra, 34); b.fillRect(-labExtra, 0, 8, VH + labDown); b.fillRect(472, 0, 8, VH); b.fillRect(-labExtra, 260 + labDown, 272 + labExtra, 12); b.fillRect(272, 260, 208, 12);
    b.fillStyle = WALL_HI; b.fillRect(-labExtra, 0, VW + labExtra, 2);
    b.fillStyle = WALL_D; b.fillRect(-labExtra, 32, VW + labExtra, 2); b.fillRect(-labExtra, 260 + labDown, 272 + labExtra, 2); b.fillRect(272, 260, 208, 2); b.fillRect(6 - labExtra, 0, 2, VH + labDown); b.fillRect(472, 0, 2, VH);
    b.fillStyle = WALL; b.fillRect(264, 0, 8, 112); b.fillRect(264, 168, 8, 92 + labDown);
    b.fillStyle = WALL_D; b.fillRect(264, 110, 8, 2); b.fillRect(264, 168, 8, 2); b.fillRect(264, 0, 1, 112); b.fillRect(271, 0, 1, 112); b.fillRect(264, 168, 1, 92 + labDown); b.fillRect(271, 168, 1, 92 + labDown);
    for (let i = 0; i < 26; i++) { b.fillStyle = '#352d3e'; b.fillRect((r() * 470 | 0), (r() * 30 | 0) + 2, 2, 1); }
    PR.banner(b, 88, 6, '#7a3b4a'); PR.banner(b, 168, 6, '#3f5b9b'); PR.banner(b, 352, 6, '#3f7b4c');
    PR.rug(b, 318, 96);
    b.fillStyle = '#53391f'; b.fillRect(296, 252, 96, 1);
  }
  drawBackground();

  const WIN_X = [48, 128, 208, 312, 392], stormR = rng(2049);
  let lightning = null, nextLightning = 6 + stormR() * 18;
  function updateLightning(t) {
    if (lightning && t > lightning.end) lightning = null;
    if (!lightning && t > nextLightning) {
      lightning = { start: t, end: t + .5 + stormR() * .35, win: stormR() * WIN_X.length | 0, seed: stormR() * 99 | 0 };
      nextLightning = t + 18 + stormR() * 42;
    }
  }
  function lightningPower(t) {
    if (!lightning) return 0;
    const age = t - lightning.start, life = lightning.end - lightning.start, fade = Math.max(0, 1 - age / life);
    return fade * (((age * 22 | 0) % 3) ? .65 : 1);
  }
  function drawLightningWindow(gg, t) {
    const p = lightningPower(t);
    if (!p) return;
    const x = WIN_X[lightning.win], y = 8, r = rng(lightning.seed);
    gg.globalAlpha = .85 * p; gg.fillStyle = '#e8f6ff'; gg.fillRect(x + 2, y + 2, 10, 12);
    gg.globalAlpha = .35 * p; gg.fillStyle = '#8fd0ff'; gg.fillRect(x + 3, y + 3, 8, 10);
    gg.globalAlpha = 1; gg.fillStyle = '#f7fbff';
    let bx = x + 4 + (r() * 5 | 0), by = y + 2;
    for (let i = 0; i < 5; i++) {
      const nx = Math.max(x + 3, Math.min(x + 10, bx + (r() * 7 - 3 | 0))), ny = by + 2 + (r() * 2 | 0);
      const n = Math.max(1, Math.hypot(nx - bx, ny - by) | 0);
      for (let j = 0; j <= n; j++) gg.fillRect(Math.round(bx + (nx - bx) * j / n), Math.round(by + (ny - by) * j / n), 1, 1);
      bx = nx; by = ny;
    }
  }
  function drawLightningCast(gg, t) {
    const p = lightningPower(t);
    if (!p) return;
    const sx = WIN_X[lightning.win] + 7, sy = 24;
    gg.globalAlpha = .18 * p; gg.fillStyle = '#e8f6ff'; gg.fillRect(8 - labExtra, 34, 256 + labExtra, 226 + labDown); gg.fillRect(264, 34, 208, 226);
    gg.globalAlpha = .32 * p; gg.fillStyle = '#090512';
    const shadow = (x, y, w, l = 30) => {
      const dx = x - sx, dy = y - sy, d = Math.max(1, Math.hypot(dx, dy)), ux = dx / d, uy = dy / d;
      gg.beginPath();
      gg.moveTo(x - w, y - 1); gg.lineTo(x + w, y - 1);
      gg.lineTo(x + w + ux * l, y - 1 + uy * l * .35); gg.lineTo(x - w + ux * l, y - 1 + uy * l * .35);
      gg.fill();
    };
    for (const w of wizards.values()) if (w.alpha > .35) shadow(w.x, w.y, 5, 28);
    shadow(cat.x, cat.y, 4, 22);
    shadow(dragon.x, dragon.y, 9, 36);
    gg.globalAlpha = 1;
  }

  function drawTableGame(gg, table, t) {
    const x = table.x - 10, y = table.y - 6;
    if (table.game) {
      if (table.game.type === 'magic') {
        ['#4878a8', '#a84848', '#48a868', '#e8dfc0', '#30364a'].forEach((c, i) => { gg.fillStyle = c; gg.fillRect(x + i * 4, y + (i % 2), 3, 5); });
        gg.fillStyle = '#6b4226'; gg.fillRect(x + 4, y + 7, 12, 2);
      } else if (table.game.type === 'chess') {
        for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) { gg.fillStyle = (cx + cy) % 2 ? '#30364a' : '#f4f0e0'; gg.fillRect(x + cx * 4, y + cy * 3, 4, 3); }
        gg.fillStyle = '#1c1430'; gg.fillRect(x + 2, y + 1, 2, 2); gg.fillRect(x + 10, y + 7, 2, 2);
        gg.fillStyle = '#f7f3e8'; gg.fillRect(x + 6, y + 4, 2, 2); gg.fillRect(x + 14, y + 10, 2, 2);
      } else {
        gg.fillStyle = '#d8b878'; gg.fillRect(x, y, 17, 13);
        gg.fillStyle = '#8a6242'; for (let i = 2; i < 16; i += 4) { gg.fillRect(x + i, y + 1, 1, 11); gg.fillRect(x + 1, y + i - 1, 15, 1); }
        gg.fillStyle = '#1c1430'; gg.fillRect(x + 4, y + 3, 2, 2); gg.fillRect(x + 12, y + 7, 2, 2);
        gg.fillStyle = '#f7f3e8'; gg.fillRect(x + 8, y + 3, 2, 2); gg.fillRect(x + 4, y + 9, 2, 2);
      }
    }
    if (t < table.burnUntil) {
      for (let i = 0; i < 9; i++) {
        gg.fillStyle = i % 2 ? '#ffd84a' : '#f08a2a';
        gg.fillRect(table.x - 10 + i * 3, table.y - 7 + ((t * 9 + i) | 0) % 3, 2, 8 - (i % 3));
      }
    }
  }
  function resetIn(q) {
    if (!q || !q.resets_at) return '';
    const s = Math.max(0, q.resets_at - (Date.now() / 1000 - serverSkew));
    if (s > 86400) return `${Math.round(s / 86400)}D`;
    if (s >= 3600) return `${Math.ceil(s / 3600)}H`;
    return `${s / 60 | 0}M`;
  }
  function drawUsageProbes(t) {
    for (const v of usageProbes()) {
      const q = v.q, color = v.color;
      PR.quotaVat(g, v.x, v.y, 'vat', q.left ?? 0, color, t);
      const unavailable = q.error || q.left == null;
      if (unavailable || q.left === 0) {
        const cy = Math.round(v.y + 14 + Math.sin(t * 2 + v.i) * 2);
        g.strokeStyle = color; g.lineWidth = 1;
        if (unavailable) {
          g.beginPath(); g.moveTo(v.x + 10, cy - 5); g.lineTo(v.x + 5, cy - 1); g.lineTo(v.x + 8, cy - 1); g.stroke();
          g.beginPath(); g.moveTo(v.x + 9, cy + 1); g.lineTo(v.x + 12, cy + 1); g.lineTo(v.x + 7, cy + 5); g.stroke();
        } else {
          g.beginPath(); g.arc(v.x + 8, cy, 4, 0, Math.PI * 2); g.stroke();
          g.beginPath(); g.moveTo(v.x + 4, cy + 4); g.lineTo(v.x + 12, cy - 4); g.stroke();
        }
      }
      const resets = q.resets_left || 0, shown = Math.min(5, resets);
      for (let i = 0; i < shown; i++) {
        const bx = v.x + 3 + i % 3 * 4, by = v.y - 5 - (i / 3 | 0) * 4 + Math.sin(t * 2 + i) * 1.2;
        g.fillStyle = color; g.fillRect(bx, Math.round(by), 3, 2); g.fillRect(bx + 1, Math.round(by) - 1, 1, 4);
      }
    }
  }
  function drawUsageLabels() {
    for (const v of usageProbes()) {
      const q = v.q, color = v.color;
      drawText(g, v.x + 8 - textW(v.label) / 2, v.y + 37, v.label, color);
      drawText(g, v.x + 8 - textW(resetIn(q)) / 2, v.y + 30, resetIn(q), '#a8a2c8');
      if (q.resets_left > 5) drawText(g, v.x + 14, v.y - 7, `+${q.resets_left - 5}`, color);
    }
  }
  const usageProbes = () => (lastData.quotas || []).map((q, i, quotas) => {
    const local = q.origins.includes('local'), remote = q.origins.includes('remote');
    return { q, i, x: 240 - (quotas.length - 1 - i) * 22, y: 43,
      label: local && remote ? 'L/R' : local ? 'LOC' : remote ? 'REM' : '',
      color: `hsl(${(195 + i * 137.508) % 360} 65% 65%)` };
  });
  const usageProbe = id => usageProbes().find(v => id === `usage:${v.q.id}`);

  // animated props, y-sorted with sprites: [sortY, drawFn]
  const props = t => [
    [174, gg => PR.cauldron(gg, 56, 150, t, BREW)],
    [91, gg => PR.shelf(gg, 10, 60, 11)], [127, gg => PR.shelf(gg, 10, 96, 23)],
    [62, gg => PR.bench(gg, 88, 42, t)],
    [120, gg => PR.crystal(gg, 216, 98, occupied('crystal') ? t : 0)],
    [29, gg => PR.board(gg, 300, 8)],
    ...TABLES.filter(table => table !== COURT).map(table => [table.y + 5, gg => { PR.gameTable(gg, table.x, table.y); drawTableGame(gg, table, t); }]),
    [94, gg => PR.hearth(gg, 440, 70, t)],
    [95, gg => PR.chair(gg, 418, 82, false)], [117, gg => PR.chair(gg, 418, 104, false)],
    [214.5, gg => PR.counter(gg, 296, 196)], [215, gg => PR.espresso(gg, 306, 186, t)],
    [215.2, gg => PR.beans(gg, PAN[0], PAN[1], t < dragon.roastUntil + 4)],
    [215.3, gg => { if (dragon.task) PR.cup(gg, CUP[0], CUP[1], dragon.task.drink.key, t); }],
    [52, gg => PR.plant(gg, 452, 38)],
    [274, gg => PR.doorway(gg, 424, 258, t)],
  ];
  const occupied = key => [...wizards.values()].some(w => w.station === key && !w.path.length && (w.a.status === 'working' || w.a.status === 'attention'));

  const brewR = rng(20260920), BREW_COLORS = ['#58d878', '#71bcf2', '#c18bea', '#ef8fa8', '#f4c565'];
  const BREW = { from: BREW_COLORS[0], color: BREW_COLORS[0], next: 7, changed: -5, strike: -5, fire: -5, count: 0 };
  function updateBrew(t) {
    if (t < BREW.next) return;
    BREW.count++;
    if (BREW.count % 3 !== 0) {
      BREW.from = BREW.color;
      const i = BREW_COLORS.indexOf(BREW.color);
      BREW.color = BREW_COLORS[(i + 1 + Math.floor(brewR() * 4)) % BREW_COLORS.length];
      BREW.changed = t;
    }
    if (BREW.count % 2) BREW.strike = t;
    BREW.fire = t + 2 + brewR() * 2;
    BREW.next = t + 12 + brewR() * 14;
  }

  // ---------- update ----------
  function moveAlong(e, dt, speed) {
    if (!e.path.length) return false;
    const [tx, ty] = e.path[0], dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy), step = speed * dt;
    if (d < .1) { e.x = tx; e.y = ty; e.path.shift(); return true; }
    const done = d <= step, nx = done ? tx : e.x + dx / d * step, ny = done ? ty : e.y + dy / d * step, r = bodyR(e);
    const tryMove = (x, y) => {
      if (e.mode !== 'fly' && blocked(x, y, r) && !blocked(e.x, e.y, r)) return false;
      if (Math.abs(x - e.x) > .4) e.dir = x < e.x ? -1 : 1;
      e.x = x; e.y = y;
      return true;
    };
    if (tryMove(nx, ny)) { if (done) e.path.shift(); }
    else if (!tryMove(nx, e.y)) tryMove(e.x, ny);
    return true;
  }
  function unstickWizard(w, t) {
    if (!w.path.length) { w.stuckAt = 0; w.lastX = w.x; w.lastY = w.y; return; }
    const moved = Math.hypot(w.x - (w.lastX ?? w.x), w.y - (w.lastY ?? w.y));
    if (moved > .6) { w.stuckAt = t; w.lastX = w.x; w.lastY = w.y; return; }
    if (!w.stuckAt) w.stuckAt = t;
    if (t - w.stuckAt <= 1) return;
    const [tx, ty] = w.path[w.path.length - 1];
    if (Math.abs(tx - w.x) > .4) w.dir = tx < w.x ? -1 : 1;
    castTeleport(w, tx, ty, w.r);
    w.x = tx; w.y = ty; w.path = [];
    w.stuckAt = 0; w.lastX = w.x; w.lastY = w.y;
  }

  function finishDragonTravel(t) {
    if (dragon.path.length) return;
    if (dragon.dest === 'stretch') {
      dragon.dest = 'stretching';
      dragon.stretchUntil = t + 2.2;
      dragon.flapUntil = Math.max(dragon.flapUntil, t + 2.2);
    } else if (dragon.dest === 'bar') {
      dragon.x = DRAGON_HOME[0]; dragon.y = DRAGON_HOME[1]; dragon.dest = dragon.mode = null;
    }
  }
  function updateDragon(dt, t) {
    if (dragon.blast) {
      if (t < dragon.blast.until) return;
      dragon.blast = null;
      sparkleAt(dragon.x, dragon.y);
    }
    if (dragon.dest === 'stretching' && t >= dragon.stretchUntil) sendDragonHome(t);
    if (dragon.path.length) {
      moveAlong(dragon, dt, 54);
      if (dragon.mode === 'fly') dragon.flapUntil = Math.max(dragon.flapUntil, t + .35);
    }
    finishDragonTravel(t);
  }

  function shoveActor(a, dx, dy) {
    if (a.fixed) return;
    const e = a.e, x = e.x + dx, y = e.y + dy;
    if (!blocked(x, y, a.r)) { e.x = x; e.y = y; return; }
    if (!blocked(x, e.y, a.r)) e.x = x;
    else if (!blocked(e.x, y, a.r)) e.y = y;
  }
  function collisionActors() {
    const a = [...wizards.values()].filter(w => w.alpha > .25 && !w.blast).map(w => ({ e: w, r: WIZ_R + 1, fixed: !!atDesk(w) }));
    a.push({ e: cat, r: CAT_R + 1 });
    return a;
  }
  function separateActors() {
    const a = collisionActors();
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
      const p = a[i], q = a[j], dx = q.e.x - p.e.x, dy = q.e.y - p.e.y, d = Math.hypot(dx, dy), min = p.r + q.r;
      if (d >= min || (p.fixed && q.fixed)) continue;
      const ux = d > .1 ? dx / d : i % 2 ? 1 : -1, uy = d > .1 ? dy / d : 0, push = (min - d) + .2;
      if (p.fixed) shoveActor(q, ux * push, uy * push);
      else if (q.fixed) shoveActor(p, -ux * push, -uy * push);
      else { shoveActor(p, -ux * push / 2, -uy * push / 2); shoveActor(q, ux * push / 2, uy * push / 2); }
    }
  }

  function update(dt, t) {
    sceneTime = t;
    updateBrew(t);
    for (let i = RITUALS.length - 1; i >= 0; i--) if (t - RITUALS[i].at > 3) RITUALS.splice(i, 1);
    for (const d of desks) d.alpha = Math.max(0, Math.min(1, d.alpha + (d.active ? 3 : -2) * dt));
    let removed = false;
    for (let i = desks.length - 1; i >= 0; i--) if (!desks[i].active && !desks[i].alpha) { desks.splice(i, 1); removed = true; }
    if (removed) shrinkLab();
    updateBattle(t);
    for (const [id, w] of wizards) {
      if (w.blast) {
        if (t < w.blast.until) continue;
        w.blast = null;
        reformWizard(w);
        if (!w.leaving && w.home) pathTo(w, w.home[0], w.home[1]);
      }
      w.walk = moveAlong(w, dt, SPEED);
      unstickWizard(w, t);
      if (atDesk(w)) { w.desk.elapsed += dt; w.x = w.desk.x; w.y = w.desk.y; w.walk = false; }
      w.alpha = Math.max(0, Math.min(1, w.alpha + (w.leaving && !w.path.length ? -3 : w.leaving && w.y > 252 ? -1.2 : 3) * dt));
      if (w.leaving && w.alpha <= 0) { wizards.delete(id); continue; }
      if (w.a.status === 'idle' && Math.random() < dt * .5) spark(w.x + 6, w.y - 24, '#a8a2c8', -6, 1.4, 'z');
      if (w.a.status === 'attention' && Math.random() < dt * 2) spark(w.x, w.y - 26, '#ff5a5a', -10, .5);
      if (!maybeRay(w, t)) maybeCast(w, t);
    }
    updateDragon(dt, t);
    if (!maybeCatRay(cat, t)) maybeCatCast(t);
    maybeCatRay(demonCat, t);
    updateSpells(dt, t);
    cafeService(t);
    maybeCafeChat(t);
    maybeDragonStretch(t);
    updateTableGames(t);
    updateLightning(t);
    // ambient particles
    if (Math.random() < dt * (t < BREW.fire ? 9 : 2)) spark(62 + Math.random() * 16, 154, BREW.color, -14, .8);
    if (occupied('circle') && Math.random() < dt * 6) { const a = Math.random() * 6.28; spark(186 + Math.cos(a) * 22, 178 + Math.sin(a) * 9, '#9a7cf0', -12, .9); }
    if (occupied('crystal') && Math.random() < dt * 3) spark(223, 100, '#cfe8ff', -8, .7);
    if ([...wizards.values()].some(w => w.station === 'cafe') && Math.random() < dt * 4) spark(312, 184, '#d8d4e4', -9, 1);
    const dBar = dragonAtBar();
    if (dBar && !dragon.task && Math.random() < dt * 3) spark(450 + Math.random() * 6, 86, '#f0a83c', -11, .7);
    // the dragon's roasting schedule; rare stretch flights are handled after cafe service.
    if (dBar && !dragon.task && t > dragon.roastAt && t >= dragon.flapUntil) { dragon.roastUntil = t + 1.8; dragon.roastAt = t + 14 + Math.random() * 20; }
    if (dBar && !dragon.task && t < dragon.flapUntil && Math.random() < dt * 9) spark(dragon.x - 14 + Math.random() * 28, dragon.y - 4, '#b8b2cc', -3, .5);
    if ((dragon.task && dragon.task.phase === 'brew') || (dBar && t < dragon.roastUntil)) {
      if (Math.random() < dt * 22) spark(PAN[0] + 2 + Math.random() * 5, PAN[1] - 1, Math.random() < .5 ? '#ffd84a' : '#f08a2a', -8 - Math.random() * 8, .45);
    } else if (dBar && !dragon.task && t < dragon.roastUntil + 4 && Math.random() < dt * 6) {
      spark(PAN[0] + 4, PAN[1] - 2, '#9a93b0', -8, 1.2);                 // fresh-roast smoke
    } else if (dBar && !dragon.task && Math.random() < dt * .15) {
      spark(dragon.x - 13, dragon.y - 21, '#9a93b0', -5, .9);            // idle nostril puff
    }
    if (dragon.task && dragon.task.phase === 'milk' && Math.random() < dt * 10) spark(CUP[0] + 5, CUP[1] + 3, '#f7f3e8', -4, .45);
    if (cat.state === 'sleep' && Math.random() < dt * .45) spark(cat.x + (cat.dir < 0 ? -5 : 5), cat.y - 14, '#a8a2c8', -5, 1.3, 'z');
    for (let i = PARTS.length - 1; i >= 0; i--) {
      const p = PARTS[i]; p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.t > p.life) PARTS.splice(i, 1);
    }
    // cat
    if (cat.state === 'walk') {
      if (!moveAlong(cat, dt, 26)) {
        if (cat.dest === 'cafe') {
          cat.state = 'cafe';
          cat.dest = null;
          cat.until = t + 22 + catR() * 8;
          cat.order = { drink: catDrink(), stage: 'queued', askAt: t, servedAt: 0 };
        } else if (cat.dest === 'game') {
          cat.state = 'game';
          cat.dest = null;
          cat.until = t + 120;
        } else catThink(t);
      }
    }
    else if (!cat.game && t > cat.until) catThink(t);
    updateDemonCat(dt, t);
    separateActors();
  }

  // ---------- draw ----------
  const SPELL_EYES = { fireball: '#f05a3a', bolt: '#e8f6ff', missile: '#9a7cf0', spark: '#d8ff58', rune: '#58d878', rain: '#8fd0ff', storm: '#ffd84a',
    hellfire: '#f05a3a', brimstone: '#f08a2a', hex: '#c8b4ff', void: '#8a4fc8' };
  function drinkEyeColor(d) {
    return d.potion || (d.key === 'antimatter' ? '#d8ff58' : d.key === 'warm-milk' ? '#f7f3e8' : d.milk ? '#f0e6d0' : '#e8a44a');
  }
  function drawGlowingEyes(w, frame, t) {
    const s = SPELLS.find(s => s.source === w.a.id || (s.attackers || []).includes(w.a.id) || (s.defenders || []).includes(w.a.id));
    const o = w.order, sipping = o && o.stage === 'served' && (t - o.servedAt + 4) % 5 < 1.2;
    if ((!s && !sipping) || frame.startsWith('sleep')) return;
    const c = s ? (s.kind === 'ray' ? (w.sp.demon ? '#f08a2a' : '#8fd0ff') : s.c || SPELL_EYES[s.kind]) : drinkEyeColor(o.drink);
    if (!c) return;
    const b = (w.sp.sub ? 2 : 0) + (frame.endsWith('B') ? 1 : 0);
    g.fillStyle = c;
    g.fillRect(8, 8 + b, 1, 1); g.fillRect(11, 8 + b, 1, 1);
  }
  function drawWizardSprite(w, t) {
    if (w.blast) {
      drawBlast(w, w.blast, t, w.sp.demon ? '#f08a2a' : '#8fd0ff');
      return;
    }
    const rest = w.a.status === 'idle' && !w.walk;
    const idle = rest ? 'sleep' : 'idle';
    const f = w.walk ? ((t * 6 | 0) % 2 ? 'walkA' : 'walkB') : ((t + w.ph) % 2.6 < 1.3 ? idle + 'A' : idle + 'B');
    const img = w.sp.frames[f];
    g.globalAlpha = .3 * w.alpha; g.fillStyle = '#0a0810'; g.fillRect(w.x - 5, w.y - 1, 10, 2);
    g.globalAlpha = w.alpha;
    g.save(); g.translate(w.x + (w.dir < 0 ? 10 : -10), w.y - 23 + (atDesk(w) ? 3 : 0));
    if (w.dir < 0) g.scale(-1, 1);
    if (atDesk(w)) { g.beginPath(); g.rect(0, 0, 20, 16); g.clip(); }
    g.drawImage(img, 0, 0); drawGlowingEyes(w, f, t); g.restore();
    if (w.a.id === sel || w.a.id === hover || w.a.status === 'attention') {
      const c = w.a.status === 'attention' ? '#ff5a5a' : '#ffd84a';
      g.globalAlpha = (Math.sin(t * 5) + 1.6) / 3;
      g.fillStyle = c;
      [[-8, -26, 4, 1], [-8, -26, 1, 4], [4, -26, 4, 1], [7, -26, 1, 4], [-8, 1, 4, 1], [-8, -2, 1, 3], [4, 1, 4, 1], [7, -2, 1, 3]].forEach(([a, b2, ww, hh]) => g.fillRect(w.x + a, w.y + b2, ww, hh));
    }
    g.globalAlpha = 1;
  }
  function drawBlast(e, blast, t, c) {
    const p = Math.min(1, (t - blast.at) / (blast.until - blast.at)), scatter = Math.sin(p * Math.PI);
    const cx = e.x, cy = e.y - 13, alpha = e.alpha === undefined ? 1 : e.alpha;
    g.globalAlpha = alpha;
    if (p < .32) {
      const q = p / .32, r = 3 + q * 16 | 0;
      g.fillStyle = blast.soot ? '#77717d' : c;
      for (let i = -r; i <= r; i++) if (Math.abs(i) % 2 === 0) {
        const y = r - Math.abs(i); g.fillRect(cx + i, cy - y, 1, 1); g.fillRect(cx + i, cy + y, 1, 1);
      }
      g.globalAlpha = alpha * (1 - q);
      g.fillRect(cx - r - 4, cy, r * 2 + 9, 1); g.fillRect(cx, cy - r - 4, 1, r * 2 + 9);
    }
    g.globalAlpha = alpha * Math.sin(p * Math.PI) * .8;
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * Math.PI * 2 + p * (blast.demon ? -8 : 8) + blast.seed, r = 5 + scatter * (8 + i % 3);
      g.fillStyle = i % 3 ? c : blast.demon ? '#ffd84a' : '#e8dcff';
      g.fillRect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), i % 2 + 1, i % 2 + 1);
    }
    if (p > .58) {
      const q = (p - .58) / .42, r = 17 - q * 11 | 0;
      g.globalAlpha = alpha * q * (.25 + (Math.sin(t * 28 + blast.seed) + 1) * .18);
      g.drawImage(blast.img, cx + blast.ox, e.y + blast.oy);
      g.fillStyle = c;
      for (let i = -r; i <= r; i += 2) {
        const y = Math.round(Math.sqrt(Math.max(0, r * r - i * i)) * .35);
        g.fillRect(cx + i, e.y + 1 - y, 1, 1); g.fillRect(cx + i, e.y + 1 + y, 1, 1);
      }
      g.globalAlpha = alpha * q * .55;
      g.fillRect(cx - 9, cy - 12 + q * 10 | 0, 2, 14); g.fillRect(cx + 8, cy - 12 + q * 10 | 0, 2, 14);
    }
    g.globalAlpha = e.alpha === undefined ? 1 : e.alpha;
    for (const f of blast.fragments) {
      const x = e.x + blast.ox + f.sx + f.dx * scatter, y = e.y + blast.oy + f.sy + f.dy * scatter;
      g.save();
      g.translate(Math.round(x + f.w / 2), Math.round(y + f.h / 2));
      g.rotate(f.spin * scatter);
      if (blast.soot && p < .55) {
        g.fillStyle = f.sx % 8 ? '#322c35' : '#77717d';
        g.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);
      } else g.drawImage(blast.img, f.sx, f.sy, f.w, f.h, -f.w / 2, -f.h / 2, f.w, f.h);
      g.restore();
    }
    g.globalAlpha = Math.max(0, .7 - scatter);
    g.fillStyle = c;
    g.fillRect(e.x - 7, e.y - 17, 14, 3); g.fillRect(e.x - 1, e.y - 23, 3, 15);
    g.globalAlpha = 1;
  }

  function drawMilkPour(t) {
    const sx = dragon.x - 7, sy = dragon.y - 22, tx = CUP[0] + 5, ty = CUP[1] + 5;
    g.fillStyle = '#d8def0'; g.fillRect(sx, sy, 6, 3); g.fillRect(sx + 4, sy + 3, 2, 2);
    g.fillStyle = '#f7f3e8'; g.fillRect(sx + 1, sy + 1, 3, 1);
    for (let i = 0; i < 9; i++) {
      const k = i / 8, wiggle = Math.sin(t * 12 + i) * .7;
      g.fillRect(sx + 4 + (tx - sx - 4) * k + wiggle, sy + 4 + (ty - sy - 4) * k, 1, i > 5 ? 2 : 1);
    }
  }
  function spellPos(s, k) {
    return [s.sx + (s.tx - s.sx) * k, s.sy + (s.ty - s.sy) * k - Math.sin(k * Math.PI) * 10];
  }
  function pixLine(x1, y1, x2, y2, c, step = 3) {
    const n = Math.max(1, Math.hypot(x2 - x1, y2 - y1) / step | 0);
    g.fillStyle = c;
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      g.fillRect(Math.round(x1 + (x2 - x1) * k), Math.round(y1 + (y2 - y1) * k), 2, 2);
    }
  }
  function drawBonds(t) {
    for (const child of wizards.values()) {
      if (child.a.kind !== 'sub' || !child.a.parent) continue;
      const parent = wizards.get(child.a.parent);
      if (!parent || parent.leaving || child.leaving) continue;
      const hot = [sel, hover].includes(parent.a.id) || [sel, hover].includes(child.a.id);
      const color = child.a.status === 'done' ? '#ffd84a' : child.a.status === 'attention' ? '#ff5a5a' : '#9a7cf0';
      const n = Math.max(8, Math.hypot(child.x - parent.x, child.y - parent.y) / 4 | 0);
      g.globalAlpha = hot ? .9 : .28;
      for (let i = 0; i <= n; i++) {
        if ((i + (t * 5 | 0)) % 3) continue;
        const k = i / n, x = parent.x + (child.x - parent.x) * k;
        const y = parent.y - 12 + (child.y - parent.y) * k - Math.sin(k * Math.PI) * 12;
        g.fillStyle = i % 2 ? color : '#e8dcff';
        g.fillRect(Math.round(x), Math.round(y), hot ? 2 : 1, hot ? 2 : 1);
      }
      g.globalAlpha = 1;
    }
  }
  function drawCafeChat(t) {
    if (!cafeChat) return;
    const second = t - cafeChat.start >= 3.6, w = wizards.get(second ? cafeChat.b : cafeChat.a);
    if (!w || !cafeReady(w)) { cafeChat = null; return; }
    const text = cafeChat.lines[second ? 1 : 0], width = textW(text) + 8;
    const x = Math.max(274, Math.min(478 - width, w.x - width / 2)), y = Math.max(38, w.y - 51);
    g.fillStyle = '#f7f3e8'; g.fillRect(x, y, width, 11);
    g.fillStyle = '#262032'; g.fillRect(x, y, width, 1); g.fillRect(x, y + 10, width, 1);
    g.fillRect(x, y, 1, 11); g.fillRect(x + width - 1, y, 1, 11);
    g.fillStyle = '#f7f3e8'; g.fillRect(Math.round(w.x), y + 11, 2, 2);
    drawText(g, x + 4, y + 3, text, '#30283e');
  }
  function drawPortal(cx, cy, t, c, seed, flip) {
    const fade = Math.max(0, 1 - t), spin = t * 8 + seed + (flip ? 3.14 : 0);
    g.globalAlpha = fade;
    for (let i = 0; i < 12; i++) {
      const a = spin + i / 12 * Math.PI * 2, rr = 4 + (i % 3) * 2 + Math.sin(t * 9 + i) * 1.2;
      g.fillStyle = i % 2 ? c : '#e8dcff';
      g.fillRect(Math.round(cx + Math.cos(a) * rr), Math.round(cy + Math.sin(a) * rr), 2, 2);
    }
    g.globalAlpha = fade * .6;
    g.fillStyle = c;
    g.fillRect(Math.round(cx - 6), Math.round(cy), 12, 1);
    g.fillRect(Math.round(cx), Math.round(cy - 6), 1, 12);
    g.globalAlpha = 1;
  }
  function drawTeleportSpell(s) {
    const k = Math.min(1, s.t / s.life);
    drawPortal(s.sx, s.sy, k, s.c, s.seed, false);
    drawPortal(s.tx, s.ty, 1 - k, s.c, s.seed, true);
    if (k < .85) pixLine(s.sx, s.sy, s.tx, s.ty, s.c, 8);
  }
  function cloudAnchor(s) {
    if (s.cat) return [cat.x, cat.y - 25];
    const w = wizards.get(s.source);
    return w && !w.leaving ? [w.x, w.y - 35] : [s.sx, s.sy];
  }
  function drawLightning(sx, sy, tx, ty, seed, color) {
    const r = rng(seed), dx = tx - sx, dy = ty - sy, length = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / length, ny = dx / length, count = Math.max(4, Math.ceil(length / 6));
    const points = Array.from({ length: count + 1 }, (_, i) => {
      const k = i / count, bend = i && i < count ? (r() - .5) * Math.min(12, length * .3) : 0;
      return [sx + dx * k + nx * bend, sy + dy * k + ny * bend];
    });
    const paths = [points];
    for (const k of [.3, .65]) {
      const [x, y] = points[Math.floor(count * k)], side = r() < .5 ? -1 : 1;
      const reach = Math.min(12, length * .25), bx = dx / length + nx * side, by = dy / length + ny * side;
      paths.push([[x, y], [x + bx * reach * .5 + nx * 2, y + by * reach * .5 + ny * 2], [x + bx * reach, y + by * reach]]);
    }
    const pixels = paths.map(path => path.slice(1).flatMap(([x, y], i) => {
      const [ax, ay] = path[i], steps = Math.max(1, Math.ceil(Math.hypot(x - ax, y - ay)));
      return Array.from({ length: steps + 1 }, (_, j) => [Math.round(ax + (x - ax) * j / steps), Math.round(ay + (y - ay) * j / steps)]);
    }));
    g.save();
    const alpha = g.globalAlpha;
    g.globalAlpha = alpha * .25; g.fillStyle = color;
    for (const path of pixels) for (const [x, y] of path) g.fillRect(x - 1, y - 1, 3, 3);
    g.globalAlpha = alpha;
    pixels.forEach((path, i) => {
      g.fillStyle = i ? color : '#fffbe6';
      for (const [x, y] of path) g.fillRect(x, y, 1, 1);
    });
    g.restore();
  }
  function drawCloudSpell(s, t) {
    const [cx, cy] = cloudAnchor(s), fade = Math.min(1, s.t * 2, (s.life - s.t) * 2);
    g.globalAlpha = Math.max(0, fade);
    g.fillStyle = s.kind === 'storm' ? '#9297b0' : '#c8d0dc';
    g.fillRect(Math.round(cx - 9), Math.round(cy), 18, 4);
    g.fillRect(Math.round(cx - 6), Math.round(cy - 3), 10, 4);
    g.fillStyle = '#8a93a8';
    g.fillRect(Math.round(cx - 7), Math.round(cy + 4), 14, 2);
    g.globalAlpha = Math.max(0, fade * .9);
    if (s.kind === 'storm') {
      const pulse = s.t * 5 + s.seed;
      if (pulse % 1 < .65) {
        const flash = pulse | 0, side = flash % 2 ? -1 : 1;
        drawLightning(cx + side * 4, cy + 6, cx + side * 10, cy + 24, s.seed + flash * 97, '#ffd84a');
      }
    } else {
      g.fillStyle = '#8fd0ff';
      for (let i = 0; i < 9; i++) {
        const dx = -8 + i * 2, fall = (t * 38 + s.seed * 3 + i * 7) % 20;
        g.fillRect(Math.round(cx + dx), Math.round(cy + 7 + fall), 1, 4);
      }
    }
    g.globalAlpha = 1;
  }
  function drawSpell(s, t) {
    if (s.kind === 'ray') {
      const target = s.target === 'dragon' ? dragon : wizards.get(s.target);
      const tx = target && !target.leaving ? target.x : s.tx, ty = target && !target.leaving ? target.y - (target === dragon ? 15 : 14) : s.ty;
      const pulse = (t * 30 + s.seed) | 0;
      pixLine(s.sx, s.sy, tx, ty, s.c, 2);
      pixLine(s.sx, s.sy + (pulse % 3 - 1), tx, ty + ((pulse + 1) % 3 - 1), '#fff6d8', 5);
      for (const id of s.attackers) {
        const helper = wizards.get(id);
        if (helper && !helper.leaving && !helper.blast) pixLine(helper.x, helper.y - 16, tx, ty, helper.sp.demon ? '#f08a3a' : '#8fd0ff', 5);
      }
      const source = wizards.get(s.source);
      for (const id of s.defenders) {
        const helper = wizards.get(id);
        if (helper && source && !helper.leaving && !helper.blast) pixLine(helper.x, helper.y - 16, source.x, source.y - 14, helper.sp.demon ? '#f08a3a' : '#8fd0ff', 5);
      }
      g.fillStyle = s.c; g.fillRect(Math.round(tx) - 3, Math.round(ty) - 3, 7, 7);
      g.fillStyle = '#fff6d8'; g.fillRect(Math.round(tx) - 1, Math.round(ty) - 1, 3, 3);
      return;
    }
    if (s.kind === 'counterfire') {
      if (s.t < 0) return;
      const target = wizards.get(s.target), tx = target && !target.leaving ? target.x : s.tx, ty = target && !target.leaving ? target.y - 13 : s.ty;
      const dir = tx < dragon.x ? -1 : 1, sx = dragon.x + dir * 13;
      const sy = dragon.y - 15 - (dragon.mode === 'fly' ? 10 + Math.sin(t * 9) * 2 : 0), n = Math.max(16, Math.hypot(tx - sx, ty - sy) / 3 | 0);
      for (let i = 0; i <= n; i++) {
        const k = i / n, x = sx + (tx - sx) * k, y = sy + (ty - sy) * k + Math.sin(k * 18 + t * 22 + s.seed) * (1 + k * 3);
        const size = 2 + (k * 5 | 0), core = Math.max(1, size - 3);
        g.fillStyle = i % 3 ? '#f05a3a' : '#9f2742';
        g.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size);
        g.fillStyle = i % 2 ? '#f08a2a' : '#ffd84a';
        g.fillRect(Math.round(x - core / 2), Math.round(y - core / 2), core, core);
      }
      g.fillStyle = '#fff0a0'; g.fillRect(sx - 2, sy - 2, 4, 4);
      return;
    }
    if (s.kind === 'teleport') { drawTeleportSpell(s); return; }
    if (s.kind === 'rain' || s.kind === 'storm') { drawCloudSpell(s, t); return; }
    const k = Math.min(1, s.t / s.life);
    if (s.kind === 'bolt') {
      g.save();
      g.globalAlpha = (1 - k * .7) * ((s.t * 40 | 0) % 3 === 1 ? .55 : 1);
      drawLightning(s.sx, s.sy, s.tx, s.ty, s.seed + (s.t * 18 | 0) * 97, '#8fd0ff');
      g.restore();
      return;
    }
    if (s.kind === 'missile') {
      for (let j = 0; j < 3; j++) {
        const q = Math.max(0, k - j * .06), p = spellPos(s, q), off = (j - 1) * 3;
        g.fillStyle = j ? '#9a7cf0' : '#e8dcff';
        g.fillRect(Math.round(p[0]), Math.round(p[1] + off), j ? 2 : 3, 2);
      }
      return;
    }
    const [x, y] = spellPos(s, k);
    if (s.kind === 'hellfire') {
      for (let j = 0; j < 5; j++) {
        const q = Math.max(0, k - j * .05), p = spellPos(s, q);
        g.fillStyle = ['#fff0a0', '#f08a2a', '#f05a3a', '#9f2742', '#321424'][j];
        g.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 1, j < 2 ? 3 : 2, j < 2 ? 3 : 2);
      }
    } else if (s.kind === 'brimstone') {
      g.fillStyle = '#321424'; g.fillRect(Math.round(x) - 3, Math.round(y) - 3, 7, 6);
      g.fillStyle = '#f08a2a'; g.fillRect(Math.round(x) - 1, Math.round(y) - 2, 2, 2);
      g.fillStyle = '#f05a3a'; g.fillRect(Math.round(x) + 2, Math.round(y) + 1, 2, 2);
    } else if (s.kind === 'void') {
      g.fillStyle = '#140b20'; g.fillRect(Math.round(x) - 4, Math.round(y) - 4, 9, 9);
      g.fillStyle = '#9a4fc8'; g.fillRect(Math.round(x) - 5, Math.round(y), 11, 1); g.fillRect(Math.round(x), Math.round(y) - 5, 1, 11);
      g.fillStyle = '#d8a0f0'; g.fillRect(Math.round(x) - 2, Math.round(y) - 2, 2, 2);
    } else if (s.kind === 'hex') {
      g.fillStyle = '#f05a8a'; g.fillRect(Math.round(x) - 4, Math.round(y), 9, 1); g.fillRect(Math.round(x), Math.round(y) - 4, 1, 9);
      g.fillRect(Math.round(x) - 3, Math.round(y) - 3, 2, 2); g.fillRect(Math.round(x) + 2, Math.round(y) + 2, 2, 2);
    } else if (s.kind === 'fireball') {
      for (let j = 0; j < 4; j++) {
        const q = Math.max(0, k - j * .05), p = spellPos(s, q);
        g.fillStyle = ['#ffe89a', '#ffd84a', '#f08a2a', '#d83a3a'][j];
        g.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 1, j ? 2 : 4, j ? 2 : 4);
      }
    } else {
      const c = s.kind === 'rune' ? '#58d878' : '#d8ff58';
      g.fillStyle = c;
      g.fillRect(Math.round(x), Math.round(y) - 3, 2, 8);
      g.fillRect(Math.round(x) - 3, Math.round(y), 8, 2);
      if (s.kind === 'rune') { g.fillRect(Math.round(x) - 2, Math.round(y) - 2, 2, 2); g.fillRect(Math.round(x) + 3, Math.round(y) + 3, 2, 2); }
    }
  }
  const DESK_COLORS = {
    wizard: { legs: '#493025', wood: '#986b45', edge: '#c49560', frame: '#94734e', paper: '#d8c294', pins: '#bca16f', text: '#514034' },
    demon: { legs: '#382334', wood: '#793c55', edge: '#bd7184', frame: '#793c55', paper: '#e3bfc7', pins: '#bd7184', text: '#492737' },
  };
  function drawWorkDesk(d, front, t) {
    const { x, y, w } = d, width = w.sp.sub ? 30 : 48;
    const colors = DESK_COLORS[w.sp.demon ? 'demon' : 'wizard'];
    g.save(); g.globalAlpha = d.alpha;
    if (!front) {
      PR.chair(g, x - 7, y - 13, false);
    } else {
      g.fillStyle = colors.legs; g.fillRect(x - width / 2 + 3, y - 1, 3, 10); g.fillRect(x + width / 2 - 6, y - 1, 3, 10);
      g.fillStyle = colors.wood; g.fillRect(x - width / 2, y - 7, width, 8);
      g.fillStyle = colors.edge; g.fillRect(x - width / 2, y - 7, width, 2);
      g.fillStyle = '#eee1b5'; g.fillRect(x - 6, y - 6, 10, 5);
      g.fillStyle = '#795d68'; g.fillRect(x - 4, y - 5, 6, 1);
      const drink = d.active && atDesk(w) && w.order && w.order.stage === 'served' ? w.order.drink.key : null;
      const seed = hash(w.a.id + ':desk');
      PR.deskDecor(g, x, y, width, seed, drink, t);
      if (!RITUALS.some(r => r.desk === d)) PR.deskPet(g, x + 5, y - 5, seed, t, false);
    }
    g.restore();
  }
  function drawTaskLabel(d) {
    const colors = DESK_COLORS[d.w.sp.demon ? 'demon' : 'wizard'];
    const title = String(d.w.a.title || d.w.a.quest || d.w.a.project || d.w.sp.name).toUpperCase();
    const lines = title.match(/.{1,12}(?:\s|$)|.{1,12}/g) || ['UNTITLED'];
    const shown = lines.slice(0, 2).map((line, i) => i === 1 && lines.length > 2 ? line.trim().slice(0, 9) + '...' : line.trim());
    const width = Math.max(...shown.map(line => textW(line))) + 8, left = Math.round(d.x - width / 2), top = d.y + 3;
    g.save(); g.globalAlpha = d.alpha;
    g.fillStyle = colors.frame; g.fillRect(left, top, width, shown.length * 8 + 3);
    g.fillStyle = colors.paper; g.fillRect(left + 1, top + 1, width - 2, shown.length * 8 + 1);
    g.fillStyle = colors.pins; g.fillRect(left - 1, top + 1, 3, 3); g.fillRect(left + width - 2, top + 1, 3, 3);
    shown.forEach((line, i) => drawText(g, Math.round(d.x - textW(line) / 2), top + 3 + i * 8, line, colors.text));
    g.restore();
  }
  function draw(t) {
    g.clearRect(-labExtra, 0, VW + labExtra, VH + labDown);
    g.drawImage(bg, -labExtra, 0);
    for (let i = 0; i < 5; i++) PR.window(g, WIN_X[i], 8, t, i * 7 + 3);
    drawLightningWindow(g, t);
    PR.torch(g, 24, 14, t); PR.torch(g, 240, 14, t + .5); PR.torch(g, 282, 14, t + .2); PR.torch(g, 444, 14, t + .8);
    PR.circle(g, 160, 152 + 12, t, occupied('circle'));
    drawLightningCast(g, t);
    drawBonds(t);
    drawCourt(g, t);
    const dragonFire = SPELLS.find(s => s.kind === 'counterfire' && s.t >= 0), fireVictim = dragonFire && wizards.get(dragonFire.target);
    const fireX = fireVictim ? fireVictim.x : dragonFire && dragonFire.tx;
    const items = props(t).map(([y, f]) => ({ y, f: () => f(g) }));
    for (const d of desks) {
      items.push({ y: d.y - 1, f: () => drawWorkDesk(d, false, t) });
      items.push({ y: d.y + 1, f: () => drawWorkDesk(d, true, t) });
    }
    for (const w of wizards.values()) items.push({ y: w.y, f: () => drawWizardSprite(w, t) });
    items.push({ y: dragon.y, f: () => {
      if (dragon.blast) { drawBlast(dragon, dragon.blast, t, '#f08a2a'); return; }
      const busy = !!dragon.task, brewing = busy && dragon.task.phase === 'brew', firing = !!dragonFire, flying = dragon.mode === 'fly';
      const stretch = !busy && !dragon.mode && t < dragon.flapUntil, flap = flying || stretch, p = stretch ? 1 - (dragon.flapUntil - t) / 3 : 0;
      const lift = flying ? 10 + Math.sin(t * 9) * 2 : Math.sin(p * Math.PI) * 7;
      g.globalAlpha = .3; g.fillStyle = '#0a0810';
      g.fillRect(dragon.x - 9 + lift / 2, dragon.y - 1, 18 - lift, 2);
      g.globalAlpha = 1;
      if (flap && !firing) {
        const sway = Math.sin(t * 2.8) * 3 * Math.sin(p * Math.PI);
        g.drawImage(dragon.frames[(t * 7 | 0) % 2 ? 'flapA' : 'flapB'], Math.round(dragon.x - 22 + sway), Math.round(dragon.y - 29 - lift));
      } else {
        const fr = firing || brewing || t < dragon.roastUntil ? ((t * 8 | 0) % 2 ? 'roastA' : 'roastB') : (t % 2.6 < 1.3 ? 'idleA' : 'idleB');
        const img = dragon.frames[fr], y = Math.round(dragon.y - 25 - (firing ? lift : 0));
        if (firing && fireX > dragon.x) {
          g.save(); g.translate(Math.round(dragon.x + 15), y); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore();
        } else g.drawImage(img, Math.round(dragon.x - 15), y);
      }
    } });
    items.push({ y: cat.y, f: () => { const fr = cat.state === 'sleep' ? 'sleep' : cat.state === 'walk' ? ((t * 5 | 0) % 2 ? 'walkA' : 'walkB') : ((t * 1.3 | 0) % 2 ? 'sitA' : 'sitB');
      const img = catFrames[fr]; if (cat.dir < 0) { g.save(); g.translate(cat.x + 7, cat.y - 9); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore(); } else g.drawImage(img, cat.x - 7, cat.y - 9); } });
    if (demonCat.active) items.push({ y: demonCat.y, f: () => {
      const fr = demonCat.path.length ? ((t * 6 | 0) % 2 ? 'walkA' : 'walkB') : ((t * 1.8 | 0) % 2 ? 'sitA' : 'sitB');
      const img = demonCat.frames[fr]; g.globalAlpha = demonCat.alpha;
      if (demonCat.dir < 0) { g.save(); g.translate(demonCat.x + 7, demonCat.y - 9); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore(); }
      else g.drawImage(img, demonCat.x - 7, demonCat.y - 9);
      g.globalAlpha = 1;
    } });
    items.sort((a, b) => a.y - b.y).forEach(i => i.f());
    const fireTarget = !dragon.blast && dragon.task && dragon.task.phase === 'brew' ? [CUP[0] + 5, CUP[1] + 4] : dragonAtBar() && t < dragon.roastUntil ? [PAN[0] + 4, PAN[1] - 2] : null;
    if (fireTarget) {  // fire breath, drawn over the counter
      const mx = dragon.x - 13, my = dragon.y - 15, tx = fireTarget[0], ty2 = fireTarget[1];
      for (let i = 0; i < 16; i++) {
        const k = i / 15, s = k > .45 ? 2 : 1;
        g.fillStyle = ['#ffe89a', '#ffd84a', '#f0a83c', '#f08a2a'][(Math.random() * 4) | 0];
        g.fillRect(mx + (tx - mx) * k + (Math.random() * 4 - 2) * k, my + (ty2 - my) * k, s, s);
      }
    }
    if (!dragon.blast && dragon.task && dragon.task.phase === 'milk') drawMilkPour(t);
    for (const s of SPELLS) drawSpell(s, t);
    for (const p of PARTS) {
      g.globalAlpha = Math.max(0, 1 - p.t / p.life);
      if (p.kind === 'z') drawText(g, p.x, p.y, 'Z', p.c);
      else { g.fillStyle = p.c; g.fillRect(p.x, p.y, p.t < p.life / 2 ? 2 : 1, p.t < p.life / 2 ? 2 : 1); }
    }
    g.globalAlpha = 1;
    for (const w of wizards.values()) {
      if (w.emote && !w.walk && !w.blast && w.alpha > .8 && !SPELLS.some(s => s.source === w.a.id && (s.kind === 'rain' || s.kind === 'storm'))) drawEmote(g, w.x, w.y - 26, w.emote, t + w.ph);
      if (w.order && w.order.stage === 'served' && !atDesk(w) && w.game !== COURT.id && !w.walk && !w.blast && w.alpha > .8) PR.cup(g, w.x + (w.dir < 0 ? -14 : 4), w.y - 11, w.order.drink.key, t + w.ph);
      if (w.order && w.order.stage !== 'served' && !w.walk && !w.blast && w.alpha > .8 && ((t + w.ph) % 6) < 2.4) tag(w.x, w.y - 45, w.order.drink.name);
      if ((hover === w.a.id || sel === w.a.id) && !w.blast && w.alpha > .5) tag(w.x, w.y - 38, w.sp.name);
    }
    drawRally(t);
    for (const d of desks) if (d.active && atDesk(d.w)) PR.ritual(g, d.x, d.y - 17, d.elapsed, 0);
    for (const r of RITUALS) {
      const p = Math.max(0, (t - r.at) / 3);
      PR.ritual(g, r.x, r.y - 17, 36, p);
      g.save(); g.globalAlpha = 1 - p;
      PR.deskPet(g, r.x + 5, r.y - 5, r.seed, t, true); g.restore();
    }
    drawCafeChat(t);
    if (cat.order && cat.order.stage === 'served') PR.cup(g, cat.x + 5, cat.y - 6, cat.order.drink.key, t);
    if (cat.order && cat.order.stage !== 'served' && ((t + 1.7) % 6) < 2.4) tag(cat.x, cat.y - 25, cat.order.drink.name);
    if (demonCat.active && demonCat.order && demonCat.order.stage === 'served') PR.cup(g, demonCat.x + 5, demonCat.y - 6, demonCat.order.drink.key, t);
    if (demonCat.active && demonCat.order && demonCat.order.stage !== 'served' && !demonCat.path.length && ((t + 2.3) % 6) < 2.4) tag(demonCat.x, demonCat.y - 25, demonCat.order.drink.name);
    if (hover === 'cat') tag(cat.x, cat.y - 20, 'BIGGLES, STAFF CAT');
    if (hover === 'demon-cat' && demonCat.active) tag(demonCat.x, demonCat.y - 20, 'LUCIPURR');
    if (hover === 'barista') tag(dragon.x, dragon.y - 32, 'EARL GREY, BARISTA');
    drawText(g, 320, 240, 'MANA CAFE', '#ffd84a');
    drawText(g, 60 - labExtra / 2, 240 + labDown, 'LABORATORIVM', '#8a84a0');
    for (const d of desks) drawTaskLabel(d);
    drawUsageProbes(t);
    drawUsageLabels();
    if (!wizards.size) {
      g.fillStyle = 'rgba(12,9,20,.55)'; g.fillRect(90, 110, 300, 44);
      drawText(g, 240 - textW('THE TOWER SLEEPS', 2) / 2, 120, 'THE TOWER SLEEPS', '#cdc6e0', 2);
      drawText(g, 240 - textW('NO AGENTS ABOUT - START ONE!') / 2, 138, 'NO AGENTS ABOUT - START ONE!', '#8a84a0');
    }
    if (offline) {
      g.fillStyle = 'rgba(20,8,8,.6)'; g.fillRect(-labExtra, 0, VW + labExtra, VH + labDown);
      drawText(g, 240 - textW('LINK TO THE TOWER SEVERED', 2) / 2, 124, 'LINK TO THE TOWER SEVERED', '#ff8a8a', 2);
      drawText(g, 240 - textW('IS SERVER.PY STILL RUNNING?') / 2, 142, 'IS SERVER.PY STILL RUNNING?', '#c8a0a0');
    }
  }
  function tag(cx, y, txt) {
    const w2 = textW(txt) + 4;
    g.fillStyle = 'rgba(12,9,20,.85)'; g.fillRect(cx - w2 / 2, y - 2, w2, 9);
    drawText(g, cx - w2 / 2 + 2, y, txt, '#f0ecdc');
  }

  // ---------- scale / input ----------
  let S = 1;
  function resize() {
    const box = $('#stage').getBoundingClientRect(), dpr = window.devicePixelRatio || 1, width = VW + labExtra, height = VH + labDown;
    S = Math.max(.1, Math.min((box.width - 24) / width, (box.height - 24) / height));
    cv.width = Math.round(width * S * dpr); cv.height = Math.round(height * S * dpr);
    cv.style.width = width * S + 4 + 'px'; cv.style.height = height * S + 4 + 'px';
    g.setTransform(cv.width / width, 0, 0, cv.height / height, labExtra * cv.width / width, 0);
    g.imageSmoothingEnabled = false;
  }
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe($('#stage'));

  function pickAt(e) {
    const r = cv.getBoundingClientRect(), mx = (e.clientX - r.left - cv.clientLeft) / S - labExtra, my = (e.clientY - r.top - cv.clientTop) / S;
    const vat = usageProbes().reverse().find(v => mx >= v.x - 3 && mx < v.x + 19 && my >= v.y - 12 && my <= v.y + 44);
    if (vat) return `usage:${vat.q.id}`;
    for (const w of [...wizards.values()].sort((a, b) => b.y - a.y))
      if (Math.abs(mx - w.x) <= 9 && my >= w.y - 26 && my <= w.y + 3) return w.a.id;
    if (mx >= dragon.x - 25 && mx <= dragon.x + 25 && my >= dragon.y - 40 && my <= dragon.y + 3) return 'barista';
    if (demonCat.active && Math.abs(mx - demonCat.x) <= 8 && Math.abs(my - demonCat.y + 4) <= 7) return 'demon-cat';
    if (Math.abs(mx - cat.x) <= 8 && Math.abs(my - cat.y + 4) <= 7) return 'cat';
    return null;
  }
  function hoverRow(id) {
    document.querySelectorAll('#rows .row').forEach(row => row.classList.toggle('hover', row.dataset.id === id));
  }
  function showTip(w, left, top) {
    const tip = $('#tip'), stage = $('#stage').getBoundingClientRect();
    tip.innerHTML = tipHTML(w);
    tip.hidden = false;
    tip.style.left = Math.max(4, Math.min(left, stage.width - tip.offsetWidth - 4)) + 'px';
    tip.style.top = Math.max(4, Math.min(top, stage.height - tip.offsetHeight - 4)) + 'px';
  }
  function showUsageTip(v, left, top) {
    const q = v.q, tip = $('#tip'), stage = $('#stage').getBoundingClientRect();
    tip.innerHTML = `<div class="tt-name">${esc(q.name)} <span>${esc((q.provider || 'codex').toUpperCase())}</span></div>
      ${q.origins.length ? `<div class="tt-meta">${esc(q.origins.join(' + ').toUpperCase())}</div>` : ''}
      <div class="tt-status">${q.left != null ? Math.round(q.left) + '% REMAINING' : 'QUOTA UNAVAILABLE'}</div>
      <div class="tt-age">${q.resets_at ? 'RESETS IN ' + resetIn(q) : 'RESET TIME UNAVAILABLE'}${q.provider === 'claude' || q.resets_left === 0 ? '' : ' · ' + (q.resets_left ?? '?') + ' RESET' + (q.resets_left === 1 ? '' : 'S') + ' LEFT'}</div>
      ${q.error ? `<div class="tt-age">${esc(q.error)}</div>` : ''}`;
    tip.hidden = false;
    tip.style.left = Math.max(4, Math.min(left, stage.width - tip.offsetWidth - 4)) + 'px';
    tip.style.top = Math.max(4, Math.min(top, stage.height - tip.offsetHeight - 4)) + 'px';
  }
  function clearHover(id) {
    if (id && hover !== id) return;
    hover = null;
    hoverRow(null);
    $('#tip').hidden = true;
  }
  cv.addEventListener('mousemove', e => {
    hover = pickAt(e);
    hoverRow(hover);
    cv.style.cursor = hover ? 'pointer' : 'default';
    const w = wizards.get(hover);
    if (w) {
      const sr = $('#stage').getBoundingClientRect();
      showTip(w, e.clientX - sr.left + 14, e.clientY - sr.top + 10);
    } else {
      const v = usageProbe(hover), sr = $('#stage').getBoundingClientRect();
      if (v) showUsageTip(v, e.clientX - sr.left + 14, e.clientY - sr.top + 10);
      else $('#tip').hidden = true;
    }
  });
  cv.addEventListener('mouseleave', () => clearHover());
  function selectWizard(id) {
    sel = id && wizards.has(id) && sel !== id ? id : null;
    renderJournal();
    renderSide();
  }
  cv.addEventListener('click', e => selectWizard(pickAt(e)));

  // ---------- status text ----------
  const VERB = { Bash: 'BREWING', Read: 'READING', Edit: 'INSCRIBING', Write: 'SCRIBING', Grep: 'SCOURING FOR', Glob: 'SCOURING FOR',
    WebFetch: 'SCRYING', WebSearch: 'SCRYING', Task: 'SUMMONING', Agent: 'SUMMONING', Workflow: 'GRAND RITE', Skill: 'INVOKING',
    TodoWrite: 'UPDATING THE QUESTBOOK', LSP: 'DIVINING', ToolSearch: 'RUMMAGING FOR', AskUserQuestion: 'PETITIONING YOU',
    EnterPlanMode: 'PLOTTING', ExitPlanMode: 'PRESENTING A PLAN', KillShell: 'DOUSING A POTION', Monitor: 'WATCHING A POTION',
    exec_command: 'BREWING', write_stdin: 'STIRRING', apply_patch: 'INSCRIBING', update_plan: 'UPDATING THE QUESTBOOK', web_search: 'SCRYING' };
  const SUBMIT_STATUS = { git: 'SUBMITTING WITH GIT', graphite: 'SUBMITTING WITH GRAPHITE', jujutsu: 'SUBMITTING WITH JUJUTSU' };
  const drinkName = d => (d.article === '' ? '' : d.article ? d.article + ' ' : /^(AMERICANO|ESPRESSO)/.test(d.name) ? 'AN ' : 'A ') + d.name;
  function cafeStatus(w) {
    if (!w || w.station !== 'cafe') return 'AWAITING YOUR COUNSEL AT THE CAFE';
    const table = tableById(w.game);
    if (table && table.game) return 'PLAYING ' + gameName(table.game.type);
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
        const table = tableById(w && w.game);
        if (table && table.game) return 'WAITING OVER ' + gameName(table.game.type);
        if (waitingOnQuestion(a)) return 'AWAITING YOUR ANSWER' + d;
        const submit = submitKind(a);
        if (submit) return SUBMIT_STATUS[submit] + d;
        if ((a.tool || '').startsWith('mcp__')) return 'FAR-SCRYING' + ': ' + a.tool.slice(5).replace('__', ' / ') + (a.detail ? ' — ' + a.detail : '');
        if (/page|click|snapshot|script|console|chrome|browser|devtools|playwright/.test((a.tool || '').toLowerCase())) return 'FAR-SCRYING: ' + a.tool + (a.detail ? ' — ' + a.detail : '');
        if (waitingOnRun(a)) return 'WAITING FOR A RUN' + d;
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
    const kind = w.sp.demon ? (a.kind === 'sub' ? 'DEMON APPRENTICE · ' : 'DEMON · ') : a.kind === 'sub' ? 'APPRENTICE · ' : '';
    return `<div class="tt-name">${esc(w.sp.name)} <span>${esc(w.sp.epithet)}</span></div>
      <div class="tt-meta">${a.engine === 'codex' ? 'CODEX · ' : ''}${kind}${a.host ? esc(a.host) + ' · ' : ''}${esc(a.project || '?')}${a.branch ? ' · ' + esc(a.branch) : ''}${a.model ? ' · ' + esc(a.model.replace('claude-', '')) : ''}</div>
      <div class="tt-status st-${a.status}">${esc(statusLine(a, w))}</div>
      ${a.title ? `<div class="tt-title">${esc(a.title)}</div>` : ''}
      ${a.quest ? `<div class="tt-quest">"${esc(a.quest.slice(0, 130))}"</div>` : ''}
      <div class="tt-age">IN STATE ${AGE(now - (a.since || now))} · LAST SIGN ${AGE(now - (a.last || now))} AGO</div>`;
  }

  // ---------- sidebar ----------
  const ORDER = { attention: 0, working: 1, thinking: 2, responding: 3, waiting: 4, done: 5, idle: 6 };
  function journalSummary(a, w) {
    const quest = a.title || a.quest, tools = [...new Set((a.history || []).map(h => h.tool).filter(Boolean))].slice(-4);
    const state = a.status === 'waiting' ? 'Now awaiting your counsel at the café.' :
      a.status === 'done' ? 'The quest is complete.' : a.status === 'idle' ? 'Now resting by the hearth.' :
      `Currently ${statusLine(a, w).toLowerCase()}.`;
    return `${quest ? `Quest: ${quest}. ` : ''}${tools.length ? `Recent craft: ${tools.join(', ')}. ` : ''}${state}`;
  }
  // The exchange itself, oldest first, so it reads like the window you were last looking at.
  function chatHTML(w, now) {
    const chat = w.a.chat || [];
    if (!chat.length) return '<div class="j-empty">Nothing has been said aloud yet.</div>';
    return `<div class="j-chat">${chat.map(c => `<div class="j-msg ${c.role}">
      <div class="j-who">${c.role === 'user' ? 'YOU' : esc(w.sp.name)} · ${AGE(now - c.ts)} AGO</div>
      <div class="j-said">${esc(c.text)}</div></div>`).join('')}</div>`;
  }
  let journalSig = null, journalId = null, journalAt = 0;
  const JOURNAL_STALE = 10;  // rebuild this often anyway, so "3M AGO" doesn't sit there frozen
  function renderJournal() {
    const panel = $('#journal'), w = wizards.get(sel);
    if (!w) { panel.hidden = true; journalSig = journalId = null; return; }
    const a = w.a, now = Date.now() / 1000 - serverSkew, history = [...(a.history || [])].reverse();
    // Rebuilding wipes both scroll positions, so do it only on a change or once ages go stale.
    const sig = JSON.stringify([a.id, a.status, a.tool, a.detail, a.title, a.quest, a.project,
      a.branch, a.chat, history.map(h => h.text)]);
    if (sig === journalSig && now - journalAt < JOURNAL_STALE && !panel.hidden) return;
    const fresh = journalId !== a.id;
    journalId = a.id;
    const body = $('#journalBody'), keep = fresh ? 0 : panel.scrollTop;  // #journal is the scroller
    const chatBox = $('.j-chat');
    const pinned = fresh || !chatBox || chatBox.scrollTop + chatBox.clientHeight >= chatBox.scrollHeight - 8;
    const chatKeep = chatBox ? chatBox.scrollTop : 0;
    journalSig = sig;
    journalAt = now;
    body.innerHTML = `<div class="j-head">${esc(w.sp.name)}</div>
      <div class="j-ep">${esc(w.sp.epithet)} · ${esc(a.project || '?')}${a.branch ? ' · ' + esc(a.branch) : ''}</div>
      <div class="j-summary">${esc(journalSummary(a, w))}</div>
      <div class="j-title">COUNSEL &amp; MISSIVES</div>
      ${chatHTML(w, now)}
      <div class="j-title">QUEST HISTORY</div>
      ${history.length ? history.map(h => `<div class="j-event"><span class="j-time">${AGE(now - h.ts)} AGO</span><span class="j-rune">◆</span><span class="j-text">${esc(h.text)}</span></div>`).join('') :
        '<div class="j-empty">No deeds have reached the chronicle yet.</div>'}`;
    panel.hidden = false;
    panel.scrollTop = keep;
    const box = $('.j-chat');
    if (box) box.scrollTop = pinned ? box.scrollHeight : chatKeep;
  }
  function renderSide() {
    const now = Date.now() / 1000 - serverSkew;
    const ags = [...lastData.agents].sort((x, y) => (ORDER[x.status] ?? 9) - (ORDER[y.status] ?? 9) || (x.started || 0) - (y.started || 0));
    $('#num').textContent = ags.length || '';
    $('#rows').innerHTML = ags.map(a => {
      const w = wizards.get(a.id);
      if (!w) return '';
      const task = esc(a.title || a.quest || a.project || w.sp.name);
      return `<div class="row st-${a.status} ${sel === a.id ? 'sel' : ''} ${hover === a.id ? 'hover' : ''} ${a.kind}" data-id="${esc(a.id)}">
        <img class="pt" src="${w.sp.portrait}" alt="">
        <div class="mid">
          <div class="nm">${a.kind === 'sub' ? '<span class="sub-arrow">&#8627;</span> ' : ''}${esc(w.sp.name)} <span class="ep">${esc(w.sp.epithet)}</span></div>
          <div class="task" title="${task}">${task}</div>
          <div class="ln">${esc(statusLine(a, w))}</div>
          <div class="ch"><span class="chip">${esc(a.project || '?')}</span>${a.host ? `<span class="chip alt">${esc(a.host)}</span>` : ''}${a.engine === 'codex' ? '<span class="chip cdx">codex</span>' : ''}${a.branch ? `<span class="chip alt">${esc(a.branch)}</span>` : ''}<span class="time">${AGE(now - (a.since || now))}</span></div>
        </div></div>`;
    }).join('');
    document.querySelectorAll('#rows .row').forEach(el => {
      const id = el.dataset.id;
      el.onmouseenter = () => {
        const w = wizards.get(id), cr = cv.getBoundingClientRect(), sr = $('#stage').getBoundingClientRect();
        hover = id;
        hoverRow(id);
        if (w) showTip(w, cr.left - sr.left + cv.clientLeft + w.x * S + 14, cr.top - sr.top + cv.clientTop + (w.y - 26) * S);
      };
      el.onmouseleave = () => clearHover(id);
      el.onclick = () => {
        const w = wizards.get(id);
        if (w && sel !== id) sparkleAt(w.x, w.y - 16);
        selectWizard(id);
      };
    });
    const counts = { active: 0, git: 0, graphite: 0, jujutsu: 0, test: 0, run: 0, attention: 0, waiting: 0, resting: 0 };
    ags.forEach(a => {
      if (a.status === 'attention') counts.attention++;
      else if (a.status === 'waiting') counts.waiting++;
      else if (a.status === 'idle' || a.status === 'done') counts.resting++;
      else if (a.status === 'thinking' || a.status === 'responding') counts.active++;
      else if (a.status === 'working') {
        const submit = submitKind(a);
        if (waitingOnQuestion(a)) counts.waiting++;
        else if (submit) counts[submit]++;
        else if (testingActivity(a)) counts.test++;
        else if (waitingOnRun(a)) counts.run++;
        else counts.active++;
      }
    });
    const part = (cls, icon, n, label) => n ? `<span class="${cls}">${icon} ${n} ${label}</span>` : '';
    $('#counts').innerHTML =
      part('c-active', '&#9874;', counts.active, 'ACTIVE') +
      part('c-git', 'G', counts.git, 'GIT') +
      part('c-graphite', 'GT', counts.graphite, 'GRAPHITE') +
      part('c-jj', 'JJ', counts.jujutsu, 'JUJUTSU') +
      part('c-test', '&#9671;', counts.test, 'MCP TEST') +
      part('c-run', '&#8987;', counts.run, 'COMMAND RUNNING') +
      (counts.attention ? `<span class="c-attn hot">&#9995; ${counts.attention} NEED YOU</span>` : '') +
      part('c-wait', '&#9749;', counts.waiting, 'AWAITING COUNSEL') +
      part('c-doze', '&#9790;', counts.resting, 'RESTING') +
      (isDemo ? '<span class="c-demo">DEMO</span>' : '');
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
      renderJournal();
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
    drawText(lg, 31, 24, 'AN AGENT OBSERVATORY', '#8a84a0', 1);
  })();

  $('#helpBtn').onclick = () => { $('#help').hidden = !$('#help').hidden; };
  $('#help').onclick = e => { if (e.target.id === 'help') $('#help').hidden = true; };
  $('#journalClose').onclick = () => selectWizard(sel);
  addEventListener('keydown', e => { if (e.key === 'Escape' && sel) selectWizard(sel); });
  let installPrompt;
  addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').onclick = async () => {
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('#installBtn').hidden = true;
  };
  addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');

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
  window.WF = { wizards, ST, cat, demonCat, dragon, SPELLS, TABLES };
})();
