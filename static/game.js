// game.js — the tower: world, movement, polling, UI.
'use strict';
(() => {
  const VW = 480, VH = 272, POLL = 1500, SPEED = 42;
  let labExtra = 0, labDown = 60, labSteps = 0;  // labSize(0): the base storey below the original floor plan
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
    circle:   { spots: [[430, 204], [408, 220], [452, 220]], emote: 'summon' },
    board:    { spots: [[306, 56], [330, 56], [284, 58]], emote: 'scroll' },
    odesk:    { spots: [[313, 92], [373, 112], [336, 130]], emote: null },
    cafe:     { spots: [[308, 226], [330, 226], [352, 226], [374, 226], [394, 224]], emote: 'coffee' },
    hearth:   { spots: [[425, 65], [425, 87]], emote: null },
    door:     { spots: [[436, 308]], emote: 'star' },
  };
  for (const k in ST) ST[k].occ = ST[k].spots.map(() => null);

  // ---------- collision ----------
  const RESOURCE_BALLS = ['cpu', 'memory', 'disk'].flatMap((metric, row) => ['local', 'remote'].map((origin, col) =>
    ({ id: `${origin}:${metric}`, origin, metric, x: 194 + col * 22, y: 98 + row * 28,
      color: { cpu: '#d84a5f', memory: '#2859b8', disk: '#278451' }[metric],
      hotColor: { cpu: '#ff4a4a', memory: '#3972d5', disk: '#329b60' }[metric],
      accents: { cpu: {}, memory: { flare: '#b2c9ff', spark: '#5587f2' },
        disk: { flare: '#b5ffce', spark: '#60db89' } }[metric] })));
  const GRID = 8, WIZ_R = 5, CAT_R = 4, DRAGON_R = 8, TELEPORT_CHANCE = .05;
  const SHELF_BLOCKERS = [{ x: 8, y: 58, w: 26, h: 34 }, { x: 8, y: 94, w: 26, h: 34 }];
  const BLOCKERS = [
    { x: 264, y: 34, w: 8, h: 78 }, { x: 264, y: 168, w: 8, h: 92 },
    { x: 58, y: 154, w: 24, h: 18 },
    ...SHELF_BLOCKERS,
    { x: 86, y: 46, w: 38, h: 16 },
    ...RESOURCE_BALLS.map(({ x, y }) => ({ x, y: y + 6, w: 16, h: 18 })),
    { x: 299, y: 96, w: 28, h: 14 }, { x: 359, y: 116, w: 28, h: 14 },
    { x: 438, y: 52, w: 32, h: 24 },
    { x: 294, y: 194, w: 102, h: 25 },
    { x: 296, y: 256, w: 112, h: 40 },
  ];
  const bodyR = e => e && e.sp ? WIZ_R : e && e.frames ? DRAGON_R : CAT_R;
  const snap = v => Math.round(v / GRID) * GRID;
  const hitRect = (x, y, r, b) => x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h;
  const blocked = (x, y, r) => x < 18 - labExtra + r || x > 462 - r || y < 42 + r || y > (x < 264 ? 266 + labDown : 326) ||
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

  // The server classifies each shell command by its most significant step: [status verb, emote].
  const ACTS = {
    read: ['READING', 'book'], search: ['SCOURING', 'search'], git: ['CONSULTING THE ANNALS', 'scroll'], tree: ['TENDING THE TREE', 'scroll'],
    ci: ['WATCHING THE CI', 'scry'], web: ['SCRYING THE WEB', 'scry'], query: ['QUERYING THE ORACLE', 'scry'],
    cloud: ['CONSULTING THE CLOUDS', 'scry'], proc: ['TENDING THE FIRES', 'flask'], profile: ['PROFILING', 'search'],
    build: ['FORGING', 'brew'], serve: ['TENDING A PORTAL', 'summon'], lint: ['CHECKING THE RUNES', 'flask'],
    test: ['TESTING', 'flask'], wait: ['WAITING FOR A RUN', 'hourglass'], script: ['BREWING', 'brew'],
    files: ['SHUFFLING SCROLLS', 'scroll'],
  };
  const SUBMIT_ACTS = { commit: 'git', push: 'git', pr: 'git', graphite: 'graphite', jujutsu: 'jujutsu' };
  const RUN_ACTS = new Set(['wait', 'test', 'build', 'serve', 'lint']);
  const shellTool = a => /^(bash|exec_command|exec|shell|local_shell|container\.exec)$/i.test((a && a.tool) || '');
  function submitKind(a) {
    if (shellTool(a)) return SUBMIT_ACTS[a.act] || null;
    const tool = ((a && a.tool) || '').toLowerCase(), detail = ((a && a.detail) || '').toLowerCase(), t = tool + ' ' + detail;
    const commandish = /stdin|^git$|^gh$|^gt$|^jj$|graphite|jujutsu/.test(tool);
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
    if (shellTool(a)) return RUN_ACTS.has(a.act);
    return /\b(monitor|write_stdin|wait|watch|tail)\b/.test(((a && a.tool) || '').toLowerCase());
  }
  function waitingOnQuestion(a) {
    const t = ((a && a.tool) || '').toLowerCase();
    return /(^|[._-])request_user_input($|_)/.test(t) || /(^|[_-])ask[_-]?user/.test(t) || /question/.test(t);
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
  const BUSY = new Set(['working', 'thinking', 'responding']);
  const AURA = { max: [4, '#ffe89a'], xhigh: [2, '#c8b4ff'], high: [.7, '#8fd0ff'] };  // reasoning effort: sparks/s, color
  // Epithets earned from transcript facts, most notable first: [fact, threshold, epithet, reason].
  const EARNED = [
    ['limit', 1, 'THE QUOTAKEEPER', () => 'WAITED OUT A USAGE LIMIT'],
    ['long', 1, 'OF THE LONG BUILD', n => `${n} RUN${n === 1 ? '' : 'S'} OVER TEN MINUTES`],
    ['rebase', 1, 'THE REBASED', n => `REBASED ${n} TIME${n === 1 ? '' : 'S'}`],
    ['merge', 1, 'MERGEWRIGHT', n => `MERGED ${n} TIME${n === 1 ? '' : 'S'}`],
    ['spawn', 3, 'THE PARALLEL', n => `SUMMONED ${n} APPRENTICES`],
    ['missive', 5, 'THE THREADWEAVER', n => `SENT ${n} MISSIVES`],
    ['night', 3, 'THE NIGHTLY', n => `${n} SPELLS BETWEEN MIDNIGHT AND FIVE`],
    ['profile', 1, 'THE PROFILED', n => `PROFILED ${n} TIME${n === 1 ? '' : 'S'}`],
    ['query', 5, 'QUERYBINDER', n => `${n} DATABASE QUERIES`],
    ['small', 1, 'THE SMALL DIFF', n => `SHIPPED ${n} CHANGED LINE${n === 1 ? '' : 'S'}`],
    ['lint', 8, 'LINTBANE', n => `${n} LINT AND TYPE CHECKS`],
    ['search', 40, 'THE GREPWORN', n => `${n} SEARCHES`],
    ['test', 25, 'FLAKEBANE', n => `${n} TEST RUNS`],
    ['push', 1, 'SHIPWRIGHT', n => `PUSHED ${n} TIME${n === 1 ? '' : 'S'}`],
    ['verbose', 1500, 'THE VERBOSE', n => `REPLIES AVERAGE ${n} CHARACTERS`],
    ['cached', 98, 'THE CACHED', n => `${n}% OF INPUT READ FROM CACHE`],
  ];
  function earned(a) {
    const f = a.feats || {}, lines = a.cost ? (a.cost.added || 0) + (a.cost.removed || 0) : null;
    const facts = { ...f, small: (f.push || f.pr || f.commit) && lines > 0 && lines <= 20 ? lines : 0 };
    const hit = EARNED.find(([key, min]) => (facts[key] || 0) >= min);
    return hit && { title: hit[2], why: hit[3](facts[hit[0]]) };
  }
  const epithetOf = w => (earned(w.a) || {}).title || w.sp.epithet;

  // ---------- entities ----------
  const wizards = new Map();
  const desks = [], RITUALS = [], HAUNTED_TODOS = [], SIGIL_EVENTS = [], SIGIL_LINKS = [];
  const SUMMON_CIRCLE = { x: 430, y: 220, nextCat: 24 };
  const CAULDRON_SIGIL = { x: 72, y: 176, radius: 40, space: { x: 28, y: 148, w: 88, h: 50 } };
  let sceneTime = 0, initialized = false;
  const atDesk = w => w.desk && !w.path.length && !w.leaving && !w.blast && !w.summon;
  let sel = null, hover = null, cafeChat = null, nextCafeChat = 10;
  let offline = false, isDemo = false, serverSkew = 0, lastData = { agents: [] };
  const ballReading = ball => {
    const machine = lastData.resources?.[ball.origin] || {};
    const total = machine[ball.metric + 'Total'], used = machine[ball.metric + 'Used'];
    return ball.metric === 'cpu' ? machine.cpu : total > 0 && used != null ? 100 * used / total : null;
  };
  const eggR = rng(0xe457e2), mimicR = rng(0xc4e57);
  const MIMIC = { active: false, x: 38, y: 76, path: [], r: mimicR, phase: 'hidden', desk: null, nextAt: 45 };
  let doorStandoff = null, nextDoorStandoff = 20;

  const sigilColor = w => (w.sp.demon ? ['#f08a2a', '#ef8fa8', '#c18bea'] : ['#8fd0ff', '#8ce8ce', '#c8b4ff', '#e8c77b'])[w.sigil.seed % (w.sp.demon ? 3 : 4)];
  function sigilMode(a) {
    if (a.status === 'working' && waitingOnQuestion(a)) return 'ask';
    if (a.status === 'thinking') return 'think';
    if (a.status === 'responding' || /edit|write|apply/.test((a.tool || '').toLowerCase())) return 'weave';
    return /bash|exec|shell|stdin|monitor|wait/.test((a.tool || '').toLowerCase()) ? 'run' : 'read';
  }
  function updateWorkSigil(w, a) {
    const event = [...(a.history || [])].reverse().find(h => h.kind === 'tool_use' || h.kind === 'tool_result');
    const key = event ? `${event.ts}:${event.kind}:${event.tool}:${event.text}` : `${a.tool || ''}:${a.detail || ''}`;
    if (key !== w.sigil.event && a.tool && !waitingOnQuestion(a)) {
      w.sigil.charge = Math.min(6, w.sigil.charge + 1);
      w.sigil.flash = sceneTime;
    }
    w.sigil.event = key; w.sigil.mode = sigilMode(a);
  }
  function sigilEvent(event) {
    SIGIL_EVENTS.push({ at: sceneTime, life: 2.4, ...event });
    if (SIGIL_EVENTS.length > 24) SIGIL_EVENTS.shift();
  }
  function sigilLink(w, returning) {
    const parent = wizards.get(w.a.parent);
    if (!parent) return;
    const target = w.summon ? [w.x, w.y] : w.home || [w.x, w.y];
    const points = [[parent.x, parent.y], ...route(parent.x, parent.y, ...target, 0)];
    if (returning) points.reverse();
    const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
    SIGIL_LINKS.push({ parent: parent.a.id, child: w.a.id, returning, at: sceneTime, life: 2.4,
      points, lengths, length: lengths.reduce((a, b) => a + b, 0) });
    if (SIGIL_LINKS.length > 16) SIGIL_LINKS.shift();
  }
  function summonWizard(w) {
    const delay = Math.min(3, SIGIL_EVENTS.filter(e => e.kind === 'summon').length) * .2;
    w.summon = { at: sceneTime + delay, until: sceneTime + delay + 1.6 };
    w.x = SUMMON_CIRCLE.x + (w.sigil.seed % 3 - 1) * 6;
    w.y = SUMMON_CIRCLE.y + w.sigil.seed % 2 * 3;
    w.alpha = 0; w.path = []; w.walk = false;
    sigilEvent({ kind: 'summon', id: w.a.id, demon: w.sp.demon, at: w.summon.at, life: 2.2 });
    if (w.a.kind === 'sub') sigilLink(w, false);
  }
  function sigilGust(x, y, t) {
    let gust = 0;
    for (const e of SIGIL_EVENTS) if (e.kind === 'landing')
      gust += Math.max(0, 1 - Math.hypot(x - e.x, y - e.y) / 130) * Math.max(0, 1 - (t - e.at) / e.life) * Math.sin((t - e.at) * 14) * 4;
    return gust;
  }

  function clampZone(x, y) {
    const lab = x < 264;
    return [Math.max(lab ? 18 - labExtra : 282, Math.min(lab ? 252 : 462, x)), Math.max(46, Math.min(lab ? 250 + labDown : 310, y))];
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
    CAULDRON_SIGIL.space,
    { x: 88, y: 42, w: 34, h: 20 }, // bench
    ...RESOURCE_BALLS.map(({ x, y, metric }) => ({ x, y, w: 16, h: metric === 'disk' ? 30 : 24 })),
  ];
  const quotaSpace = () => {
    const x = 236 - (Math.max(6, usageProbes().length) - 1) * 22;
    return { x, y: 30, w: 260 - x, h: 58 };
  };
  const deskBounds = (x, y) => ({ x: x - 32, y: y - 30, w: 64, h: 54 });
  function taskLabelLines(w) {
    if (w.sp.sub) return [];
    const title = String(w.a.title || w.a.quest || w.a.project || w.sp.name).toUpperCase();
    let lines = title.match(/.{1,12}(?:\s|$)|.{1,12}/g)?.map(line => line.trim()).filter(Boolean) || ['UNTITLED'];
    if (lines.length > 5) {
      lines = lines.slice(0, 5);
      lines[4] = lines[4].slice(0, 9) + '...';
    }
    return lines;
  }
  const deskSpace = (x, y, w) => ({ x: x - 32, y: y - 30, w: 64, h: Math.max(54, 36 + taskLabelLines(w).length * 8) });
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  // The tower always has one storey below the original floor plan: the cafe keeps its Magic table there.
  const labSize = steps => [Math.floor(steps / 3) * 72, (1 + steps - Math.floor(steps / 3)) * 60];
  const shelfSpace = width => ({ x: 8 - width, y: 58, w: 26, h: 70 });
  const fitsLab = (d, width, height) => {
    const b = deskSpace(d.x, d.y, d.w);
    return b.x >= 8 - width && b.x + b.w <= 264 && b.y >= 34 && b.y + b.h <= 240 + height && !overlaps(b, shelfSpace(width));
  };
  function deskPosition(anchor, occupied, steps, w) {
    const [width, height] = labSize(steps);
    let best, distance = Infinity;
    // Search the whole usable floor, including gaps between fixtures.
    for (let y = 64; y <= 216 + height; y += 4) for (let x = 40 - width; x <= 232; x += 8) {
      const space = deskSpace(x, y, w), score = Math.hypot(x - anchor[0], y - anchor[1]);
      if (space.y + space.h > 240 + height || score >= distance || overlaps(space, shelfSpace(width)) || occupied.some(b => overlaps(space, b))) continue;
      best = [x, y]; distance = score;
    }
    return best;
  }
  function sizeLab(steps) {
    labSteps = steps;
    const dx = labSize(steps)[0] - labExtra;
    [labExtra, labDown] = labSize(steps);
    for (const p of [...ST.shelf.spots, ...SPELL_TARGETS.shelf]) p[0] -= dx;
    for (const b of SHELF_BLOCKERS) b.x -= dx;
    drawBackground(); resize();
  }
  function shrinkLab() {
    const before = labSteps;
    while (labSteps) {
      const [width, height] = labSize(labSteps - 1);
      const outside = desks.filter(d => !fitsLab(d, width, height));
      const occupied = [...DESK_FIXTURES, quotaSpace(), ...desks.filter(d => fitsLab(d, width, height)).map(d => deskSpace(d.x, d.y, d.w))];
      const moves = [];
      for (const d of outside) {
        const pos = d.active && deskPosition([d.x, d.y], occupied, labSteps - 1, d.w);
        if (!pos) break;
        moves.push([d, pos]); occupied.push(deskSpace(...pos, d.w));
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
      if (dest && !actor.summon) actor.path = route(actor.x, actor.y, ...clampZone(...dest), bodyR(actor));
    }
  }
  function makeDesk(w) {
    const parent = wizards.get(w.a.parent), anchor = parent && parent.home || [100, 80];
    const occupied = [...DESK_FIXTURES, quotaSpace(), ...desks.filter(d => d.active || d.alpha > 0).map(d => deskSpace(d.x, d.y, d.w))];
    let pos, steps = 0;
    while (!(pos = deskPosition(anchor, occupied, steps, w))) steps++;
    if (steps > labSteps) sizeLab(steps);
    const [x, y] = pos;
    w.desk = { x, y, active: true, alpha: 0, elapsed: 0, w };
    desks.push(w.desk);
    return pos;
  }
  function settleDesks() {
    const occupied = [...DESK_FIXTURES, quotaSpace(), ...desks.filter(d => !d.active && d.alpha > 0).map(d => deskSpace(d.x, d.y, d.w))];
    const reroute = [];
    let steps = labSteps;
    for (const d of desks.filter(d => d.active)) {
      const space = deskSpace(d.x, d.y, d.w);
      if (fitsLab(d, ...labSize(steps)) && !occupied.some(b => overlaps(space, b))) {
        occupied.push(space); continue;
      }
      let pos;
      while (!(pos = deskPosition([d.x, d.y], occupied, steps, d.w))) steps++;
      [d.x, d.y] = pos; d.w.home = pos;
      if (d.w.path.length) reroute.push(d.w);
      else if (initialized && !d.w.summon) [d.w.x, d.w.y] = pos;
      occupied.push(deskSpace(...pos, d.w));
    }
    if (steps > labSteps) sizeLab(steps);
    for (const w of reroute) pathTo(w, ...w.home);
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
    if (initialized && !w.summon) pathTo(w, pos[0], pos[1]);
    w.emote = emoteFor(w);
  }
  function placeFor(w) {
    const s = w.a.status;
    if (cafeWait(w.a) || playsOn(w)) return 'cafe';
    if (['working', 'thinking', 'responding'].includes(s)) return 'work';
    if (s === 'attention') return 'board';
    if (s === 'idle') return 'hearth';
    if (s === 'done') return 'door';
    return w.station || 'bench';
  }
  function emoteFor(w) {
    const s = w.a.status;
    if (cafeWait(w.a)) return w.station === 'cafe' ? 'drink:' + ((w.order && w.order.drink || w.sp.drink).key) : null;
    if (s === 'working') return TOOL_EMOTE[(w.a.tool || '').toLowerCase()] || (shellTool(w.a) && ACTS[w.a.act] || [])[1] ||
      ST[toolStation(w.a)].emote || 'flask';
    return { attention: 'alert', thinking: 'think', responding: 'write', done: 'star',
             waiting: w.station === 'cafe' ? 'drink:' + ((w.order && w.order.drink || w.sp.drink).key) : null }[s] || null;
  }

  function reconcile(data) {
    for (let i = desks.length - 1; i >= 0; i--) {
      const d = desks[i];
      if (!overlaps(deskSpace(d.x, d.y, d.w), quotaSpace())) continue;
      if (d.w.desk === d) { d.w.desk = null; d.w.station = null; }
      desks.splice(i, 1);
    }
    const seen = new Set();
    for (const a of [...data.agents].sort((a, b) => Number(!!a.parent) - Number(!!b.parent))) {
      seen.add(a.id);
      let w = wizards.get(a.id);
      // Each remote machine is its own faction: the first host's agents are demons, later hosts recolor them.
      const faction = a.origin === 'remote' ? Math.max(1, (data.hosts || []).indexOf(a.host) + 1) : 0, demon = faction > 0;
      const takenJobs = () => new Set([...wizards.values()].filter(o => o.a.id !== a.id).map(o => o.sp.job));
      if (!w) {
        w = { a, sp: SP.makeWizard(a.id, a.kind, faction, takenJobs()), x: 436 + ((hash(a.id) % 9) - 4), y: 310, dir: -1, path: [], walk: false,
              station: null, spotI: -1, home: null, order: null, game: null, castAt: 0, blast: null, leaving: false,
              stuckAt: 0, lastX: 436, lastY: 310, alpha: 0, ph: (hash(a.id) % 100) / 16, r: rng(hash(a.id) ^ 0xbeef), emote: null,
              sigil: { seed: hash(a.id + ':sigil'), charge: 0, event: null, flash: -9 } };
        wizards.set(a.id, w);
        updateWorkSigil(w, a);
        if (initialized && (a.kind === 'sub' || demon) && placeFor(w) === 'work') summonWizard(w);
        retarget(w);
        if (initialized && !w.summon) sparkleAt(436, 312);
        continue;
      }
      if (w.sp.faction !== faction) w.sp = SP.makeWizard(a.id, a.kind, faction, takenJobs());
      const changed = !w.station || w.a.status !== a.status || (a.status === 'working' && (w.a.tool !== a.tool || w.a.detail !== a.detail)) || w.leaving;
      if (initialized && (a.compactions || 0) > (w.a.compactions || 0)) {
        w.relitAt = sceneTime;
        if (w.desk) for (let i = 0; i < 6; i++) spark(w.desk.x + (w.sp.sub ? 12 : 21), w.desk.y - 16, '#a8a2c8', -9, 1.2);
      }
      if (w.desk && ['waiting', 'done'].includes(a.status) && !['waiting', 'done'].includes(w.a.status)) {
        RITUALS.push({ desk: w.desk, x: w.desk.x, y: w.desk.y, at: sceneTime, seed: hash(w.a.id + ':desk'),
          sigilSeed: w.sigil.seed });
        if (a.kind === 'sub') sigilLink(w, true);
        if (eggR() < .18) spawnHauntedTodo(w, w.desk, sceneTime);
      }
      updateWorkSigil(w, a);
      w.a = a;
      if (placeFor(w) !== 'work') w.summon = null;
      w.leaving = false;
      if (!cafeWait(a) && !playsOn(w)) {
        if (w.order && w.order.stage !== 'served') w.order = null;
        leaveGameForWizard(w, 0);
      }
      if (changed) { w.castAt = 0; retarget(w); }
    }
    for (const [id, w] of wizards) if (!seen.has(id) && !w.leaving) { leaveGameForWizard(w, 0); w.leaving = true; release(w); w.station = null; pathTo(w, 436, 310); w.path.push([436, 326]); }
    settleDesks();
    if (!initialized) {
      for (const w of wizards.values()) {
        const pos = w.desk || !blocked(...w.home, WIZ_R) ? w.home : gridOpenNear(...w.home, WIZ_R);
        [w.x, w.y] = pos;
        w.lastX = w.x; w.lastY = w.y; w.alpha = 1;
        if (w.desk) w.desk.alpha = 1;
      }
      initialized = true;
    }
  }

  // ---------- cat & barista ----------
  const catFrames = SP.makeCat();
  const cat = { x: 446, y: 110, state: 'sit', until: 4, path: [], dir: -1, dest: null, order: null, game: null, castAt: 0 };
  const catR = rng(99);
  cat.r = catR;
  const demonCat = { frames: SP.makeCat(true), x: 446, y: 110, active: false, path: [], dir: -1, alpha: 0, until: 0, summonAt: 24, dest: null, order: null };
  const demonCatR = rng(666);
  demonCat.r = demonCatR;
  const CAT_SPECIALS = DRINKS.filter(d => ['health-potion', 'mana-potion', 'antimatter'].includes(d.key));
  const catDrink = () => catR() < .8 ? WARM_MILK : CAT_SPECIALS[catR() * CAT_SPECIALS.length | 0];
  function catThink(t) {
    if (cat.game) return;
    if (cat.state === 'cafe') cat.order = null;
    cat.dest = null;
    if (t >= SUMMON_CIRCLE.nextCat && !demonCat.active && !SIGIL_EVENTS.some(e => e.kind === 'summon')) {
      pathTo(cat, SUMMON_CIRCLE.x, SUMMON_CIRCLE.y);
      cat.state = 'walk'; cat.dest = 'sigil'; cat.until = t + 20;
      SUMMON_CIRCLE.nextCat = t + 120 + catR() * 90;
      return;
    }
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
  const dragon = { frames: SP.makeDragon(), x: DRAGON_HOME[0], y: DRAGON_HOME[1], dir: -1, path: [], dest: null, mode: null, signal: null, stretchUntil: -9, roastAt: 7, roastUntil: -9, flapAt: 45 + dragonR() * 60, flapUntil: -9, task: null, game: null, blast: null, lookAt: -9, lookUntil: -9, lookX: 0 };
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
    if (dragon.signal !== 'waiting' || !dragonAtBar() || dragon.task || t <= dragon.flapAt || t < dragon.roastUntil) return;
    if (cafeCustomers().some(c => c.order.stage !== 'served')) { dragon.flapAt = t + 12 + dragonR() * 18; return; }
    const p = DRAGON_STRETCH[dragonR() * DRAGON_STRETCH.length | 0];
    sendDragonTo(p[0], p[1], 'stretch', t);
    dragon.flapAt = t + 75 + dragonR() * 90;
  }
  function updateDragonSignal(t) {
    const agents = lastData.agents || [], signal = agents.some(a => a.status === 'attention') ? 'attention' :
      agents.some(a => ['working', 'thinking', 'responding'].includes(a.status)) ? 'active' : agents.length ? 'waiting' : 'empty';
    if (signal !== dragon.signal) {
      dragon.signal = signal;
      if (signal === 'active') dragon.roastAt = t;
    }
    if (dragon.task || dragon.blast) return;
    if (signal === 'attention') {
      if (dragon.game) leaveGameForDragon(t);
      if (dragon.dest !== 'alert') sendDragonTo(350, 48, 'alert', t);
    } else if (dragon.dest === 'alert' || signal === 'empty' && !dragonAtBar()) sendDragonHome(t);
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
  // Duelists sit at either end of the long Magic table; the third seat, behind it, is the judge's.
  const MTG = { id: 'mtg', x: 352, y: 292, seats: [[286, 294], [418, 294], [318, 250]], types: ['magic'], game: null, burnUntil: 0 };
  const TABLES = [
    COURT,
    { id: 't1', x: 313, y: 101, seats: [[292, 112], [332, 112], [313, 84]], types: ['go'], game: null, burnUntil: 0 },
    { id: 't2', x: 373, y: 121, seats: [[352, 132], [392, 132], [373, 104]], types: ['go'], game: null, burnUntil: 0 },
    MTG,
  ];
  const tableR = rng(4242);
  const SPORT_SHOTS = {
    pingpong: [
      { name: 'normal', duration: .85, lift: 12, bounce: .72 },
      { name: 'slice', duration: 1.05, lift: 7, bounce: .78, curve: 4 },
      { name: 'backhand', duration: .9, lift: 10, bounce: .7, curve: -3 },
      { name: 'topspin', duration: .72, lift: 9, bounce: .62, curve: 2 },
      { name: 'slam', duration: .58, lift: 5, bounce: .68, curve: -1 },
    ],
    badminton: [
      { name: 'clear', duration: 1.5, lift: 36, drag: 1.45 },
      { name: 'drop', duration: 1.15, lift: 24, fall: 7, drag: 1.3 },
      { name: 'drive', duration: .82, lift: 13, drag: 1.1 },
      { name: 'smash', duration: .62, lift: 0, drag: 1.65 },
    ],
  };
  const tableById = id => TABLES.find(t => t.id === id);
  function updateTopTable() {
    const count = usageProbes().length, table = TABLES[1];
    const x = Math.max(table.game?.type === 'go' ? 307 : 276, Math.min(316, 286 + (count - 3) * 10));
    table.x = x;
    table.seats = [[x - 21, 112], [x + 19, 112], [x, 84]];
  }
  // w, when given, is the duelist reading the name: Magic then reports their life before the opponent's.
  const gameName = ({ type, record: r, mtg, players }, w) => {
    const me = mtg && w && mtg.sides[players.find(p => p.id === w.a.id)?.seat];
    return (type === 'magic' ? 'MAGIC THE GATHERING' : type === 'pingpong' ? 'PING PONG' : type.toUpperCase()) +
      (r ? `: ${r.black} VS ${r.white}, ${r.date.slice(0, 4)}`.toUpperCase() : '') +
      (me ? `: ${me.life} LIFE VS ${mtg.sides[1 - me.i].life}` : '');
  };
  // Idle agents finish the game in front of them before dozing off by the hearth.
  const playsOn = w => !!w.game && w.a.status === 'idle';
  const gameHas = (table, kind, id) => !!table.game && table.game.players.some(p => p.kind === kind && (!id || p.id === id));
  function waitingForGame(w) {
    return cafeReady(w) && !w.game && w.order && w.order.stage === 'served';
  }
  function releaseGamePlayer(p, t) {
    if (p.kind === 'wizard') {
      const w = wizards.get(p.id);
      if (w) { w.game = null; if (!w.leaving) { w.station = null; w.home = null; retarget(w); } }
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
  // Go players stand clear of the wide 19x19 board.
  const seatAt = (table, i) => table.game?.type === 'go' && i < 2 ? [table.x + (i ? 28 : -28), table.seats[i][1]] : table.seats[i];
  function seatPlayer(table, p, i, t) {
    p.seat = i;
    const [x, y] = seatAt(table, i);
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
    return !cat.game && cat.dest !== 'sigil' && !cat.path.length && cat.state !== 'walk' && cat.state !== 'sleep' && cat.state !== 'cafe';
  }
  // Court games run on a timer; Go and Magic play to their conclusion.
  function startGame(table, players, t) {
    const type = table.types[tableR() * table.types.length | 0];
    table.game = { type, started: t, until: table === COURT ? t + 28 + tableR() * 28 : Infinity };
    updateTopTable();
    table.game.players = players.slice(0, 2).filter((p, i) => seatPlayer(table, p, i, t));
    if (table !== COURT) initBoardGame(table.game, t);
    if (table.game.players.length < 2) endGame(table, t, false);
  }
  function initBoardGame(game, t) {
    game.nextMove = t + 2;
    if (game.type === 'go') startGoRecord(game);
    else game.mtg = MAGIC.newGame(game.players.map(duelist), rng(tableR() * 2 ** 32 >>> 0), tableR() < .03 ? tableR() * 2 | 0 : -1);
  }
  function startGoRecord(game) {
    const records = window.GO_GAMES || [];
    Object.assign(game, { stones: [], ply: 0, record: records[Math.random() * records.length | 0] });
  }
  const GO = 19, goPoint = stone => stone.x + stone.y * GO;
  const goNeighbors = i => [i % GO ? i - 1 : -1, i % GO < GO - 1 ? i + 1 : -1, i >= GO ? i - GO : -1, i < GO * (GO - 1) ? i + GO : -1].filter(n => n >= 0);
  function goGroup(board, start) {
    const members = new Set([start]), liberties = new Set(), stack = [start], side = board.get(start).side;
    while (stack.length) for (const neighbor of goNeighbors(stack.pop())) {
      const next = board.get(neighbor);
      if (!next) liberties.add(neighbor);
      else if (next.side === side && !members.has(neighbor)) { members.add(neighbor); stack.push(neighbor); }
    }
    return { members, liberties, side };
  }
  function playGo(stones, stone) {
    const point = goPoint(stone), board = new Map(stones.map(s => [goPoint(s), s]));
    if (board.has(point)) return null;
    board.set(point, stone);
    for (const neighbor of goNeighbors(point)) {
      const other = board.get(neighbor);
      if (!other || other.side === stone.side) continue;
      const { members, liberties } = goGroup(board, neighbor);
      if (!liberties.size) for (const captured of members) board.delete(captured);
    }
    return goGroup(board, point).liberties.size ? [...board.values()] : null;
  }
  // A judge watching from the third seat never holds up play.
  const tableReady = game => game.players.every(p => {
    if (p.judge) return true;
    if (p.kind === 'cat') return cat.game && !cat.path.length;
    const w = wizards.get(p.id);
    return w && !w.path.length && !w.blast;
  });
  function updateBoardGame(game, t) {
    if (game.finishedAt !== undefined || t < game.nextMove || !tableReady(game)) return;
    const moves = game.record?.moves || [], [x, y, side] = moves[game.ply++] || [];
    const next = x >= 0 && playGo(game.stones, { x, y, side, placedAt: t });
    if (next) {
      game.stones = next;
      game.move = { player: side, seat: game.players[side].seat, to: [x, y], start: t, duration: .75 };
    } else delete game.move;
    if (game.ply >= moves.length) game.finishedAt = t;
    game.nextMove = t + 1.6 + tableR() * .7;
  }
  function updateTableGames(t) {
    updateTopTable();
    for (const table of (tableR() < .5 ? TABLES : [...TABLES].reverse())) {
      const game = table.game;
      if (game) {
        game.players = game.players.filter(p => {
          if (p.kind === 'cat') return cat.game === table.id;
          const w = wizards.get(p.id);
          return w && !w.leaving && (cafeWait(w.a) || playsOn(w));
        });
        if (game.finishedAt !== undefined) { if (t >= game.finishedAt + (game.type === 'go' ? 30 : 9)) endGame(table, t, false); }
        else if (game.players.filter(p => !p.judge).length < 2 || t > game.until) endGame(table, t, false);
        else if (table === COURT) updateRally(table, t);
        else if (game.type === 'magic') updateMagic(game, t);
        else updateBoardGame(game, t);
      }
      if (table.game || t < table.burnUntil || t < (table.nextAt || 0)) continue;
      const ws = [...wizards.values()].filter(w => waitingForGame(w)).sort((a, b) => (a.a.started || 0) - (b.a.started || 0));
      if (!ws.length || (table === COURT && ws.length < 2)) continue;
      const players = ws.slice(0, 2).map(w => ({ kind: 'wizard', id: w.a.id }));
      if (players.length < 2 && canUseCat()) players.push({ kind: 'cat' });
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
    if (game.rally?.winner !== undefined) {
      const r = game.rally;
      if (!r.scored) {
        game.score ||= [0, 0];
        game.score[r.winner]++;
        r.scored = true;
      }
      if (t < r.start + r.duration + 1.4) return;
    }
    const hitter = game.rally ? (game.rally.winner ?? game.rally.receiver) : 0, receiver = 1 - hitter;
    const w = ws[hitter], other = ws[receiver], seat = table.seats[receiver];
    const shots = SPORT_SHOTS[game.type], shot = shots[(game.shotIndex || 0) % shots.length];
    game.shotIndex = (game.shotIndex || 0) + 1;
    const next = shots[game.shotIndex % shots.length];
    const exchanges = (game.rally?.winner === undefined ? game.rally?.exchanges || 0 : 0) + 1;
    const power = shot.name === 'slam' || shot.name === 'smash';
    const winner = exchanges >= 6 && (power || tableR() < .22 || exchanges >= 10) ? hitter : undefined;
    const x = seat[0] + (tableR() * 8 - 4), y = Math.max(seat[1] + (tableR() * 20 - 10), shot.name === 'smash' ? w.y - 8 : -Infinity);
    other.home = [x, y]; other.path = route(other.x, other.y, x, y, WIZ_R);
    game.rally = { start: t, duration: shot.duration, receiver, shot: shot.name,
      from: [w.x + (hitter ? -10 : 10), w.y - (shot.name === 'smash' ? 28 : 14)],
      to: winner === undefined ? [x + (receiver ? -10 : 10), y - (game.type === 'badminton' && next.name === 'smash' ? 28 : 14)] :
        [x + (receiver ? 14 : -14), y + (game.type === 'badminton' ? 5 : -6)],
      winner, exchanges,
      hits: (game.rally ? game.rally.hits : 0) + 1 };
    game.players[hitter].hitAt = t;
  }
  function rallyPosition(game, t) {
    const r = game.rally, k = Math.max(0, Math.min(1, (t - r.start) / r.duration));
    const shot = SPORT_SHOTS[game.type].find(s => s.name === r.shot) || SPORT_SHOTS[game.type][0];
    let arc, q = k;
    if (game.type === 'badminton') {
      arc = Math.sin(k * Math.PI) * (shot.lift - (shot.fall || 0) * k);
      q = 1 - Math.pow(1 - k, shot.drag);
    }
    else arc = k < shot.bounce ? Math.sin(k / shot.bounce * Math.PI) * shot.lift :
      Math.sin((k - shot.bounce) / (1 - shot.bounce) * Math.PI) * shot.lift * .42;
    return [r.from[0] + (r.to[0] - r.from[0]) * q + Math.sin(k * Math.PI) * (shot.curve || 0),
      r.from[1] + (r.to[1] - r.from[1]) * q - arc];
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
      const side = i ? -1 : 1, returning = game.rally && game.rally.winner === undefined && game.rally.receiver === i;
      let swing = Math.max(0, 1 - (t - (p.hitAt ?? -1)) / .22);
      let shot = game.rally && game.rally.receiver === 1 - i ? game.rally.shot : 'normal';
      if (badminton && returning && SPORT_SHOTS.badminton[game.shotIndex % SPORT_SHOTS.badminton.length].name === 'smash') {
        shot = 'smash'; swing = Math.max(swing, Math.min(1, (t - game.rally.start) / game.rally.duration));
      }
      g.save(); g.globalAlpha = Math.max(0, Math.min(1, (t - game.started - .5) / 1.5));
      const backhand = shot === 'backhand' ? -1 : 1, power = shot === 'slam' || shot === 'smash' ? 1.35 : shot === 'slice' || shot === 'drop' ? .55 : .8;
      g.translate(Math.round(w.x + side * 10), Math.round(w.y - 14 - (shot === 'smash' ? 12 : shot === 'slam' ? 3 : 0) * swing));
      g.rotate(side * backhand * swing * power + (shot === 'slice' ? side * .35 : 0));
      g.fillStyle = '#c8a678'; g.fillRect(-1, 2, 2, 6);
      if (badminton) {
        g.strokeStyle = '#eee6c6'; g.lineWidth = 1; g.beginPath(); g.ellipse(0, -2, 4, 6, 0, 0, Math.PI * 2); g.stroke();
        g.fillStyle = '#a4c5cf'; g.fillRect(-2, -2, 5, 1); g.fillRect(0, -4, 1, 6);
      } else { g.fillStyle = i ? '#6c9ade' : '#e77568'; g.fillRect(-3, -4, 6, 6); }
      g.restore();
    }
    if (!game.rally) return;
    const [x, y] = rallyPosition(game, t), r = game.rally;
    if (r.winner !== undefined) {
      const power = r.shot === 'slam' || r.shot === 'smash', color = power ? '#ffd45c' : '#7df9ff';
      const landed = t - r.start - r.duration;
      g.save(); g.strokeStyle = color; g.fillStyle = color; g.lineWidth = power ? 3 : 2;
      if (landed < 0) {
        g.beginPath();
        for (let i = 0; i <= 6; i++) {
          const [tx, ty] = rallyPosition(game, Math.max(r.start, t - .15 + i * .025));
          if (i) g.lineTo(tx, ty); else g.moveTo(tx, ty);
        }
        g.stroke();
        g.shadowColor = color; g.shadowBlur = power ? 12 : 8;
        g.fillRect(x - 3, y - 3, 6, 6);
      } else {
        const fade = Math.max(0, 1 - landed / 1.4), radius = 5 + Math.min(landed, .5) * 28;
        g.globalAlpha = fade;
        for (let i = 0; i < 8; i++) {
          const angle = i * Math.PI / 4;
          g.beginPath(); g.moveTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
          g.lineTo(x + Math.cos(angle) * (radius + 5), y + Math.sin(angle) * (radius + 5)); g.stroke();
        }
      }
      g.restore();
    }
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
  // ---------- the Magic table ----------
  // Card frame fill and edge per colour. Engine cards carry their eased position on the table in vx/vy/vz
  // (vz: 0 lies on the mat, 1 is held up large on the stack).
  const MANA = { W: ['#f3ecd2', '#a89a70'], U: ['#5b8fd8', '#28508c'], B: ['#6c5c7c', '#262030'], R: ['#de5a40', '#86281e'],
    G: ['#4fa65a', '#28642f'], '': ['#bcae9c', '#6e6258'], back: ['#8a5f3a', '#3e2a1a'] };
  const FIRE = ['#fff0a0', '#ffd84a', '#f08a2a', '#f05a3a'];
  const AURAS = { swords: ['#f4f0e0', '#ffe89a'], terror: ['#4a2a6a', '#1c1430', '#9a5fd0'], growth: ['#8cf08a', '#5cb85a'] };
  const HUE_COLORS = [[20, 'R'], [70, 'W'], [170, 'G'], [260, 'U'], [330, 'B'], [361, 'R']];
  const TOOL_COLORS = [[/bash|exec|shell|stdin|kill/, 'R'], [/read|grep|glob|search|fetch|lsp/, 'U'],
    [/edit|write|patch|notebook/, 'G'], [/task|agent|workflow|skill/, 'W']];
  // Pale or grey robes are white; otherwise the hue decides, with yellows white and purples black.
  function robeColor(robe) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(robe.slice(i, i + 2), 16) / 255), max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    const lightness = max - d / 2;
    if (lightness > .7 || d < .15) return lightness > .45 ? 'W' : 'B';
    const hue = (max === r ? (g - b) / d + 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 % 360;
    return HUE_COLORS.find(([h]) => hue < h)[1];
  }
  // A deck takes the robe's colour and the colour of the agent's favourite tools; demons play black, Biggles white.
  function duelist(p) {
    if (p.kind === 'cat') return { name: 'BIGGLES', colors: ['W'] };
    const w = wizards.get(p.id), tally = {};
    for (const h of w.a.history || []) {
      const color = TOOL_COLORS.find(([re]) => re.test(String(h.tool).toLowerCase()))?.[1];
      if (color) tally[color] = (tally[color] || 0) + 1;
    }
    const first = w.sp.demon ? 'B' : robeColor(w.sp.robe);
    const second = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
    return { name: w.sp.name, demon: w.sp.demon, colors: second && second !== first ? [first, second] : [first] };
  }
  const actorOf = (game, side) => {
    const p = game.players.find(p => p.seat === side && !p.judge);
    return p && (p.kind === 'cat' ? cat : wizards.get(p.id));
  };
  const edgeX = (side, d, w = 4) => side ? MTG.x + 52 - d - w : MTG.x - 52 + d;  // a card d pixels in from a duelist's end
  const handAt = (game, side) => {
    const a = actorOf(game, side);
    return a ? [a.x + (side ? -8 : 6), a.y - (a === cat ? 6 : 12)] : [edgeX(side, -8), MTG.y - 20];
  };
  const cardArtFor = (game, c) => { const a = c.key === 'sorcerer' && actorOf(game, c.side); return SP.cardArt(c.key, a?.sp?.robe, a?.sp?.hat); };
  const magicCards = s => [...s.stack.map(sp => sp.c), ...s.sides.flatMap(me => [...me.field, ...me.grave])];
  function fieldSlot(me, c) {
    const land = c.type === 'land', i = me.field.filter(o => (o.type === 'land') === land).indexOf(c);
    return land ? [edgeX(me.i, 14 + i % 2 * 6, c.tapped ? 5 : 4), MTG.y - 34 + (i >> 1) % 4 * 7 + (i >> 3)]
      : [edgeX(me.i, 27 + i % 3 * 8), MTG.y - 25 + (i / 3 | 0) % 2 * 13 + (i / 6 | 0)];
  }
  // Where a card rests now ([x, y, vz]), or null while it is in a hand or exiled. Attackers advance to the
  // centre line and lunge at the defending duelist when unblocked; blockers step up to meet them.
  function cardHome(game, c, t) {
    const s = game.mtg, me = s.sides[c.side], foe = s.sides[1 - c.side], k = s.stack.findIndex(sp => sp.c === c);
    if (k >= 0) return [MTG.x - 9 + k * 6, MTG.y - 67 - k * 3, 1];
    if (me.scooped) return [edgeX(me.i, 2), MTG.y - 34, 0];
    if (me.grave.includes(c)) return [edgeX(me.i, 2), MTG.y - 14, 0];
    if (!me.field.includes(c)) return null;
    const [x, y] = fieldSlot(me, c), ev = game.ev;
    if (c.attacking) return [!c.blocked && ev?.type === 'damage' && t - ev.at < ev.dur * .5 ? edgeX(foe.i, 0) : edgeX(me.i, 49), y, 0];
    const attacker = foe.field.find(a => a.attacking && a.blocked === c);
    return attacker ? [edgeX(me.i, 41), fieldSlot(foe, attacker)[1], 0] : [x, y, 0];
  }
  const LATER = [];
  const later = (at, fn) => LATER.push({ at, fn });
  function updateMagicCards(dt, t) {
    for (let i = LATER.length - 1; i >= 0; i--) if (t >= LATER[i].at) LATER.splice(i, 1)[0].fn();
    const game = MTG.game, s = game?.mtg;
    if (!s) return;
    const k = Math.min(1, dt * 7);
    for (const c of magicCards(s)) {
      const home = cardHome(game, c, t);
      if (!home) continue;
      if (c.vx === undefined) { [c.vx, c.vy] = handAt(game, c.side); c.vz = 0; }
      c.vx += (home[0] - c.vx) * k; c.vy += (home[1] - c.vy) * k; c.vz += (home[2] - c.vz) * k;
    }
    const lap = game.lap;
    if (lap && t >= lap.at && t < lap.until) {
      const [x, y] = lapPos(lap, t);
      Object.assign(dragon, { lookX: x, lookUntil: t + .3 });
      if (Math.random() < dt * 24) spark(x + Math.random() * 8 - 4, y - 4, FIRE[Math.random() * 4 | 0], -4, .5);
    }
  }
  function updateMagic(game, t) {
    for (const p of game.players) {
      const a = p.kind === 'cat' ? cat : wizards.get(p.id);
      if (a && !p.judge && !a.path.length) a.dir = p.seat ? -1 : 1;
    }
    if (game.judgeUntil && t > game.judgeUntil) {
      game.players = game.players.filter(p => !p.judge);
      game.judgeUntil = 0;
      releaseGamePlayer({ kind: 'cat' }, t);
    } else if (game.judgeUntil && !game.ruled && cat.state === 'game') {
      game.ruled = true;
      game.say = { who: 'cat', text: 'MRRP.', until: t + 2.4 };
    }
    if (t < game.nextMove || !tableReady(game)) return;
    const step = game.mtg.play.next();
    if (step.done) { game.finishedAt = t; return; }
    game.ev = { ...step.value, at: t };
    game.nextMove = t + step.value.dur + .3 + tableR() * .5;
    magicEvent(game, game.ev, t);
  }
  // Biggles comes to rule on disputed counterspells when he is free, then wanders off again.
  function callJudge(game, t) {
    if (game.players.some(p => p.kind === 'cat') || !canUseCat()) return;
    const judge = { kind: 'cat', judge: true };
    seatPlayer(MTG, judge, 2, t);
    game.players.push(judge);
    Object.assign(game, { judgeUntil: t + 18, ruled: false });
  }
  // Earl Grey turns to watch a Shivan Dragon land; sometimes it flies a lap of the cafe first.
  function shivanLands(game, card, t) {
    Object.assign(dragon, { lookAt: t, lookUntil: t + 3, lookX: card.vx });
    if (tableR() >= .35) return;
    game.lap = { card, at: t + 1, until: t + 7.5 };
    game.nextMove = Math.max(game.nextMove, game.lap.until + .4);
  }
  function lapPos(lap, t) {
    const k = Math.max(0, Math.min(1, (t - lap.at) / (lap.until - lap.at))), a = Math.PI / 2 - k * Math.PI * 2;
    const blend = Math.min(1, k * 7, (1 - k) * 7);
    return [mix(lap.card.vx + 2, 370 + Math.cos(a) * 80, blend), mix(lap.card.vy - 6, 168 + Math.sin(a) * 96, blend)];
  }
  function magicEvent(game, ev, t) {
    const s = game.mtg, source = actorOf(game, ev.side)?.a?.id, stack = [MTG.x, MTG.y - 56];
    const spot = target => 'life' in target ? (a => a ? [a.x, a.y - 14] : [edgeX(target.i, -8), MTG.y - 20])(actorOf(game, target.i))
      : [target.vx + 2, target.vy];
    const burst = (target, colors, n = 14) => radialBurst(...spot(target), colors, n, 16, .8);
    if (ev.say) game.say = { who: ev.side, text: ev.say, until: t + 2.6 };
    switch (ev.type) {
      case 'cast': {
        if (!ev.lotus) break;
        for (let i = 0; i < 3; i++) spark(ev.lotus.vx + i * 2, ev.lotus.vy, ['#9a5fd0', '#f4f0e0', '#a0a8bc'][i], -14, 1.1);
        const foe = actorOf(game, 1 - ev.side);
        if (foe?.sp) {
          const was = foe.emote;
          foe.emote = 'alert';
          later(t + 2, () => { if (foe.emote === 'alert' && foe.a.status !== 'attention') foe.emote = was; });
        }
        break;
      }
      case 'enter':
        ev.card.bornAt = t;
        if (ev.card.key === 'shivan') shivanLands(game, ev.card, t);
        break;
      case 'counter':
        ev.target.crossedAt = t;
        burst(ev.target, ['#8fd0ff', '#5b8fd8', '#e8f6ff']);
        if (s.stack.length || tableR() < .3) { game.say = { who: ev.target.side, text: 'JUDGE!', until: t + 2.4 }; callJudge(game, t); }
        break;
      case 'bolt': case 'ping': {
        const [sx, sy] = ev.type === 'ping' ? [ev.card.vx + 2, ev.card.vy - 4] : stack, [tx, ty] = spot(ev.target);
        SPELLS.push({ kind: ev.type === 'bolt' ? 'bolt' : 'missile', source, sx, sy, tx, ty, t: 0, life: .5, seed: tableR() * 99 | 0, c: '#ffc070' });
        later(t + .45, () => radialBurst(tx, ty, ['#fff6d8', '#ffc070'], ev.type === 'bolt' ? 14 : 6, 18, .5));
        break;
      }
      case 'fireball': {
        const [tx, ty] = spot(ev.target), size = ev.x >= 10 ? 3 : ev.x >= 5 ? 2 : 1;
        SPELLS.push({ kind: 'fireball', source, sx: stack[0], sy: stack[1], tx, ty, t: 0, life: .9, seed: tableR() * 99 | 0, size });
        later(t + .9, () => radialBurst(tx, ty, FIRE, 6 + size * 8, 10 + size * 8, .8));
        if (ev.x >= 10 && 'life' in ev.target) game.bigFireball = true;
        break;
      }
      case 'swords': case 'terror': case 'growth': burst(ev.target, AURAS[ev.type]); break;
      case 'wrath': game.flashAt = t; break;
      case 'ritual': case 'recall': case 'channel': {
        const [x, y] = handAt(game, ev.side), colors = { ritual: ['#6c5c7c', '#9a5fd0'], recall: ['#8fd0ff', '#e8f6ff'], channel: ['#d0402e', '#ffb4a8'] }[ev.type];
        for (let i = 0; i < 9; i++) spark(x + Math.random() * 6 - 3, y, colors[i % 2], -10 - Math.random() * 10, .9);
        if (ev.type === 'channel') s.sides[ev.side].hurtAt = t;
        break;
      }
      case 'breath': for (let i = 0; i < 10; i++) spark(ev.card.vx + 2, ev.card.vy - 6, FIRE[i % 4], -8, .5); break;
      case 'damage':
        for (const [, target, n] of ev.hits) if (n > 0 && 'life' in target) later(t + .45, () => { target.hurtAt = sceneTime; burst(target, ['#f05a3a', '#ffb4a8'], 10); });
        break;
      case 'die': for (const c of ev.cards) burst(c, [MANA[c.color][0], '#fff6d8', '#ffe89a'], 22); break;
      case 'devour':
        if ('life' in ev.target) ev.target.hurtAt = t;
        burst(ev.target, ['#f05a3a', '#7a2420', '#1c1430'], 18);
        break;
      case 'win': {
        const loser = actorOf(game, 1 - ev.side), winner = actorOf(game, ev.side);
        game.say = { who: 1 - ev.side, text: loser === cat ? 'MRRP.' : 'GG', until: t + 3 };
        s.sides[1 - ev.side].scooped = t;
        if (loser?.sp && (game.bigFireball || tableR() < .2)) explodeWizard(loser, t);
        if (winner?.sp) { winner.emote = 'star'; sparkleAt(winner.x, winner.y - 16); }
        break;
      }
    }
  }
  function drawCardAt(gg, c, x, y, z, tapped) {
    x = Math.round(x); y = Math.round(y);
    if (z > .9) { drawBigCard(gg, c, x, y); return; }
    const [fill, edge] = MANA[c ? c.color : 'back'], w = Math.round(4 + 14 * z), h = Math.round(5 + 19 * z);
    const [cw, ch] = tapped ? [h, w] : [w, h], top = y + (tapped ? 1 : 0);
    gg.fillStyle = edge; gg.fillRect(x, top, cw, ch);
    gg.fillStyle = fill; gg.fillRect(x + 1, top + 1, cw - 2, ch - 2);
  }
  // A card held up on the stack: frame, art box, rules box and, for creatures, a power/toughness box.
  function drawBigCard(gg, c, x, y) {
    const [fill, edge] = MANA[c.color], art = cardArtFor(MTG.game, c);
    gg.fillStyle = '#120d1c'; gg.fillRect(x - 1, y - 1, 20, 26);
    gg.fillStyle = edge; gg.fillRect(x, y, 18, 24);
    gg.fillStyle = fill; gg.fillRect(x + 1, y + 1, 16, 22);
    gg.fillStyle = '#3a4668'; gg.fillRect(x + 2, y + 4, 14, 10);
    gg.drawImage(art, x + 9 - Math.ceil(art.width / 2), y + 14 - art.height);
    gg.fillStyle = '#ece4cc'; gg.fillRect(x + 2, y + 15, 14, 7);
    gg.fillStyle = '#b4a888'; gg.fillRect(x + 3, y + 17, 11, 1); gg.fillRect(x + 3, y + 19, 7, 1);
    if (c.type === 'creature') { gg.fillStyle = edge; gg.fillRect(x + 12, y + 20, 5, 3); }
  }
  function drawMini(gg, game, c, t) {
    if (game.lap?.card === c && t >= game.lap.at && t < game.lap.until) return;
    const art = cardArtFor(game, c), z = c.pump ? 2 : 1, w = art.width * z, h = art.height * z, born = t - (c.bornAt ?? -9);
    const lift = c.fly ? 3 + Math.round(Math.sin(t * 3 + c.id)) : 0, x = Math.round(c.vx + 2 - w / 2), y = Math.round(c.vy + 4 - h - lift);
    gg.save();
    if (born < .8) {
      gg.globalAlpha = 1 - born / .8; gg.strokeStyle = MANA[c.color][0]; gg.lineWidth = 1;
      gg.beginPath(); gg.ellipse(c.vx + 2, c.vy + 4, 3 + born * 8, 1 + born * 3, 0, 0, Math.PI * 2); gg.stroke();
    }
    if (c.fly) { gg.globalAlpha = .45; gg.fillStyle = '#0a0810'; gg.fillRect(Math.round(c.vx), Math.round(c.vy) + 4, 4, 1); }
    gg.globalAlpha = Math.min(1, born / .5);
    if (c.side) { gg.translate(x + w, y); gg.scale(-1, 1); gg.drawImage(art, 0, 0, w, h); }
    else gg.drawImage(art, x, y, w, h);
    gg.restore();
  }
  function drawDie(gg, x, y, n, hurt) {
    const text = String(n), w = textW(text) + 4;
    gg.fillStyle = '#6c6680'; gg.fillRect(x + 1, y, w - 2, 7); gg.fillRect(x, y + 1, w, 5);
    gg.fillStyle = hurt ? '#ffb4a8' : '#f4f0e8'; gg.fillRect(x + 1, y + 1, w - 2, 5);
    drawText(gg, x + 2, y + 1, text, n <= 5 ? '#c8402e' : '#2a2030');
  }
  // The table prop: libraries, d20 life counters, lands, creatures standing on their cards, and the stack.
  function drawMagic(gg, t) {
    PR.magicTable(gg, MTG.x, MTG.y);
    const game = MTG.game, s = game?.mtg;
    if (!s) return;
    const ev = game.ev, since = ev ? t - ev.at : 99;
    for (const me of s.sides) {
      const shaking = (ev?.type === 'shuffle' || ev?.type === 'mulligan' && ev.side === me.i) && since < ev.dur;
      for (let i = Math.min(3, me.library.length >> 3); i >= 0 && me.library.length; i--)
        drawCardAt(gg, null, edgeX(me.i, 2) + (shaking && !i ? Math.round(Math.sin(t * 40)) : 0), MTG.y - 34 + i, 0, false);
      const rolling = ev?.type === 'roll' && since < ev.dur, landed = !rolling || since > ev.dur * .55;
      const n = rolling ? (landed ? ev.rolls[me.i] : 1 + (t * 23 + me.i * 7 | 0) % 20) : me.life, w = textW(String(n)) + 4;
      const k = rolling ? Math.min(1, since / (ev.dur * .55)) : 1, home = me.i ? MTG.x + 51 - w : MTG.x - 51;
      drawDie(gg, Math.round(mix(MTG.x - w / 2 + (me.i ? 6 : -6), home, k)), Math.round(MTG.y - 25 - (landed ? 0 : Math.abs(Math.sin(since * 10)) * 4)),
        n, t - (me.hurtAt ?? -9) < .5);
    }
    const cards = magicCards(s).filter(c => c.vx !== undefined).sort((a, b) => a.vz - b.vz || a.vy - b.vy);
    for (const c of cards.filter(c => c.vz < .5)) {
      const me = s.sides[c.side], home = cardHome(game, c, t);
      if (!home || me.grave.includes(c) && me.grave.at(-1) !== c && Math.hypot(home[0] - c.vx, home[1] - c.vy) < 1) continue;
      gg.save();
      if (me.scooped) gg.globalAlpha = Math.max(0, 1 - (t - me.scooped) / 1.2);
      drawCardAt(gg, c, c.vx, c.vy, c.vz, c.tapped && me.field.includes(c));
      gg.restore();
    }
    for (const c of cards) if (c.type === 'creature' && s.sides[c.side].field.includes(c) && !s.sides[c.side].scooped) drawMini(gg, game, c, t);
    const held = s.stack.map(sp => sp.c);   // the top of the stack is drawn last
    for (const c of [...cards.filter(c => c.vz >= .5 && !held.includes(c)), ...held]) drawCardAt(gg, c, c.vx, c.vy, c.vz, false);
    for (const c of cards.filter(c => t - (c.crossedAt ?? -9) < .9)) {   // countered: struck through in blue
      const w = 3 + 14 * c.vz, h = 4 + 19 * c.vz;
      pixLine(c.vx, c.vy, c.vx + w, c.vy + h, '#8fd0ff', 2); pixLine(c.vx + w, c.vy, c.vx, c.vy + h, '#8fd0ff', 2);
    }
    if (t - (game.flashAt ?? -9) < .7) {
      gg.save(); gg.globalAlpha = .8 * (1 - (t - game.flashAt) / .7);
      gg.fillStyle = '#fffbe6'; gg.fillRect(MTG.x - 52, MTG.y - 36, 104, 31); gg.restore();
    }
  }
  function drawHand(x, y, n) {
    for (let i = 0, k = Math.min(n, 7); i < k; i++) {
      const o = i - (k - 1) / 2, hx = Math.round(x + o * 1.5), hy = Math.round(y + Math.abs(o) * .5);
      g.fillStyle = '#3e2a1a'; g.fillRect(hx, hy, 2, 3);
      g.fillStyle = '#9a6a3a'; g.fillRect(hx, hy, 1, 2);
    }
  }
  // Drawn over the scene: hands of cards, cards flying in from the library, table talk, and Shivan's lap.
  function drawMagicFront(t) {
    const game = MTG.game, s = game?.mtg;
    if (!s) return;
    const ev = game.ev, since = ev ? t - ev.at : 99;
    for (const me of s.sides) {
      const [hx, hy] = handAt(game, me.i), lx = edgeX(me.i, 2), ly = MTG.y - 34;
      let flying = 0;
      if (ev?.type === 'draw' && ev.side === me.i) for (let j = 0; j < ev.n; j++) {
        const p = Math.max(0, Math.min(1, (since - j * .12) / .45));
        if (p >= 1) continue;
        flying++;
        drawCardAt(g, null, mix(lx, hx, p), mix(ly, hy, p) - Math.sin(p * Math.PI) * 6, 0, false);
      }
      drawHand(hx, hy, me.hand.length - flying);
    }
    if (game.say && t < game.say.until) {
      const a = game.say.who === 'cat' ? cat : actorOf(game, game.say.who);
      if (a) bubble(a.x, Math.max(38, a.y - (a === cat ? 24 : 51)), game.say.text);
    }
    if (game.lap && t >= game.lap.at && t < game.lap.until) {
      const [x, y] = lapPos(game.lap, t), flip = lapPos(game.lap, t + .05)[0] < x, flap = (t * 8 | 0) % 2;
      g.save(); g.translate(Math.round(x + (flip ? 9 : -9)), Math.round(y - 16 + flap)); g.scale(flip ? -2 : 2, 2);
      g.drawImage(SP.cardArt('shivan'), 0, 0); g.restore();
    }
  }
  const COLOR_NAMES = { W: 'WHITE', U: 'BLUE', B: 'BLACK', R: 'RED', G: 'GREEN' };
  const deckName = me => me.colors.map(c => COLOR_NAMES[c]).join('-');
  const TYPE_LINES = { land: 'BASIC LAND', creature: 'CREATURE', instant: 'INSTANT', sorcery: 'SORCERY', artifact: 'ARTIFACT' };
  const ART_URLS = new Map();
  function artURL(art) {
    if (!ART_URLS.has(art)) {
      const c = document.createElement('canvas'), cg = c.getContext('2d');
      c.width = art.width * 6; c.height = art.height * 6;
      cg.imageSmoothingEnabled = false;
      cg.drawImage(art, 0, 0, c.width, c.height);
      ART_URLS.set(art, c.toDataURL());
    }
    return ART_URLS.get(art);
  }
  function cardHTML(game, c) {
    const pip = p => /[WUBRG]/.test(p) ? `<i class="mp mp-${p}"></i>` : `<i class="mp">${p}</i>`;
    return `<div class="mtg-card mc-${c.color || 'C'}">
      <div class="mc-bar"><b>${esc(c.name)}</b><span>${(c.cost.match(/\d+|[WUBRGX]/g) || []).map(pip).join('')}</span></div>
      <div class="mc-art"><img src="${artURL(cardArtFor(game, c))}" alt=""></div>
      <div class="mc-bar">${TYPE_LINES[c.type]}${c.sub ? ' — ' + c.sub : c.type === 'land' ? ' — ' + c.name : ''}</div>
      <div class="mc-text">${esc(c.text || '')}${c.type === 'creature' ? `<b>${c.p}/${c.t}</b>` : ''}</div></div>`;
  }
  function magicTipHTML() {
    const game = MTG.game, s = game.mtg;
    return `<div class="tt-name">MAGIC: THE GATHERING <span>TURN ${Math.max(1, s.turn)}</span></div>
      ${s.sides.map(me => `<div class="tt-meta">${esc(me.name)} · ${deckName(me)} · ${me.life} LIFE · ${me.library.length} CARDS</div>`).join('')}
      ${s.last ? cardHTML(game, s.last) : ''}`;
  }

  // Biggles' stray spells can still burn a court game, but board games play to their conclusion.
  function burnGameAt(x, y, t) {
    if (!COURT.game || Math.abs(x - COURT.x) >= 20 || Math.abs(y - COURT.y) >= 16) return false;
    endGame(COURT, t, true);
    for (let i = 0; i < 12; i++) spark(COURT.x + (Math.random() * 20 - 10), COURT.y + (Math.random() * 10 - 5), Math.random() < .5 ? '#ffd84a' : '#f08a2a', -10, .7);
    return true;
  }

  // ---------- particles ----------
  const PARTS = [];
  const SPELLS = [];
  const battleR = rng(31337);
  const BATTLE_COOLDOWN = 180, BATTLE_COOLDOWN_JITTER = 120, EARL_GREY_TARGET_CHANCE = .08;
  let nextBattle = 45 + battleR() * 45;
  const SPELL_TARGETS = {
    cauldron: [[68, 154], [80, 154]], shelf: [[24, 68], [24, 104], [24, 140]],
    bench: [[98, 50], [112, 50]], submit: [[112, 118], [84, 126], [140, 126]], labwait: [[112, 118], [92, 130], [132, 130]], desk: [[108, 204], [152, 204]],
    crystal: [[223, 102]], circle: [[430, 218]], board: [[314, 28], [300, 28]],
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
    const rivals = [...wizards.values()].filter(v => v.a.kind !== 'sub' && v.sp.faction !== w.sp.faction && !v.leaving && !v.walk && !v.summon && !v.game && !v.blast && v.alpha > .8);
    if (dragonAtBar() && w.r() < EARL_GREY_TARGET_CHANCE) rivals.push(dragon);
    return rivals.length ? rivals[w.r() * rivals.length | 0] : null;
  }
  function combatHelpers(w) {
    return [...wizards.values()].filter(v => v.a.kind === 'sub' && v.a.parent === w.a.id && v.sp.faction === w.sp.faction &&
      !v.leaving && !v.walk && !v.summon && !v.game && !v.blast && v.alpha > .8).map(v => v.a.id);
  }
  function castRay(w, target, catCaster = false) {
    const demon = catCaster ? w === demonCat : w.sp.demon, c = demon ? '#f05a3a' : catCaster ? '#d8ff58' : '#8fd0ff';
    const source = catCaster ? w === cat ? 'cat' : 'demon-cat' : w.a.id, targetId = target === dragon ? 'dragon' : target.a.id;
    const attackers = catCaster ? [] : combatHelpers(w), defenders = catCaster || target === dragon ? [] : combatHelpers(target);
    w.dir = target.x < w.x ? -1 : 1;
    const sy = w.y - (catCaster ? 8 : 17), ty = target.y - (target === dragon ? 15 : 14);
    SPELLS.push({ kind: 'ray', source, target: targetId, cat: catCaster, attackers, defenders, sx: w.x + w.dir * 7, sy,
      tx: target.x, ty, t: 0, life: .32, seed: w.r() * 99 | 0, c });
    spark(w.x + w.dir * 7, sy, c, -5, .35);
  }
  function updateBattle(t) {
    if (t < nextBattle || !wizards.size) return;
    const wizardsReady = [...wizards.values()].filter(w => w.a.kind !== 'sub' && !w.walk && !w.summon && !w.leaving && !w.game && !w.blast && w.alpha > .8);
    const fights = wizardsReady.map(w => [w, rayOpponent(w)]).filter(([, target]) => target);
    const catsReady = [cat, demonCat].filter(c => (c !== demonCat || c.active) && !c.path.length && !c.game && c.state !== 'walk' && c.state !== 'sleep' && (c.alpha === undefined || c.alpha > .8));
    const targets = [...wizards.values()].filter(w => !w.leaving && !w.walk && !w.summon && !w.game && !w.blast && w.alpha > .8);
    const casters = [...fights, ...catsReady.filter(() => targets.length || dragonAtBar()).map(c => [c, null])];
    if (!casters.length) return;
    nextBattle = t + BATTLE_COOLDOWN + battleR() * BATTLE_COOLDOWN_JITTER;
    let [caster, target] = casters[battleR() * casters.length | 0];
    const catCaster = caster === cat || caster === demonCat;
    if (catCaster) {
      if (dragonAtBar() && caster.r() < EARL_GREY_TARGET_CHANCE) targets.push(dragon);
      target = targets[caster.r() * targets.length | 0];
    }
    if (target) castRay(caster, target, catCaster);
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
      if (t < demonCat.summonAt || cat.dest !== 'sigil' || cat.state !== 'sit' || t < cat.sigilAt + 1.6) return;
      [demonCat.x, demonCat.y] = [SUMMON_CIRCLE.x + 10, SUMMON_CIRCLE.y + 2];
      const drink = INFERNAL_DRINKS[hash('lucipurr:drink') % INFERNAL_DRINKS.length];
      Object.assign(demonCat, { active: true, alpha: 0, until: t + 48 + demonCatR() * 10, dest: 'cafe',
        order: { drink, stage: 'queued', askAt: t + 3, servedAt: 0 }, path: [] });
      demonCat.summoningUntil = t + 1.2;
      sigilEvent({ kind: 'cat', demon: true, at: t, life: 2.4 });
      teleportBurst(demonCat.x, demonCat.y, '#f08a2a');
      return;
    }
    demonCat.alpha = Math.min(1, demonCat.alpha + dt * 3);
    if (t < demonCat.summoningUntil) return;
    if (demonCat.summoningUntil) { demonCat.summoningUntil = null; pathTo(demonCat, 414, 226); }
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
    for (let ry = 34; ry < 320; ry += 8) {
      b.fillStyle = ((ry / 8) | 0) % 2 ? '#684832' : '#5f422c'; b.fillRect(264, ry, 208, 8);
      b.fillStyle = '#53391f';
      for (let sx = 264 + ((ry / 8) % 3) * 24; sx < 472; sx += 72) b.fillRect(sx, ry, 1, 8);
      b.fillRect(264, ry + 7, 208, 1);
    }
    b.fillStyle = WALL; b.fillRect(-labExtra, 0, VW + labExtra, 34); b.fillRect(-labExtra, 0, 8, VH + labDown); b.fillRect(472, 0, 8, VH + 60); b.fillRect(-labExtra, 260 + labDown, 272 + labExtra, 12); b.fillRect(272, 320, 208, 12);
    b.fillStyle = WALL_HI; b.fillRect(-labExtra, 0, VW + labExtra, 2);
    b.fillStyle = WALL_D; b.fillRect(-labExtra, 32, VW + labExtra, 2); b.fillRect(-labExtra, 260 + labDown, 272 + labExtra, 2); b.fillRect(272, 320, 208, 2); b.fillRect(6 - labExtra, 0, 2, VH + labDown); b.fillRect(472, 0, 2, VH + 60);
    b.fillStyle = WALL; b.fillRect(264, 0, 8, 112); b.fillRect(264, 168, 8, 92 + labDown);
    b.fillStyle = WALL_D; b.fillRect(264, 110, 8, 2); b.fillRect(264, 168, 8, 2); b.fillRect(264, 0, 1, 112); b.fillRect(271, 0, 1, 112); b.fillRect(264, 168, 1, 92 + labDown); b.fillRect(271, 168, 1, 92 + labDown);
    for (let i = 0; i < 26; i++) { b.fillStyle = '#352d3e'; b.fillRect((r() * 470 | 0), (r() * 30 | 0) + 2, 2, 1); }
    PR.banner(b, 88, 6, '#7a3b4a'); PR.banner(b, 168, 6, '#3f5b9b'); PR.banner(b, 352, 6, '#3f7b4c');
    PR.rug(b, 318, 96);
    b.fillStyle = '#53391f'; b.fillRect(296, 316, 112, 1);
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
    gg.globalAlpha = .18 * p; gg.fillStyle = '#e8f6ff'; gg.fillRect(8 - labExtra, 34, 256 + labExtra, 226 + labDown); gg.fillRect(264, 34, 208, 286);
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

  const mix = (a, b, k) => a + (b - a) * k;
  function moveProgress(game, t) { return game.move ? Math.max(0, Math.min(1, (t - game.move.start) / game.move.duration)) : 1; }
  function drawTableReach(gg, table, target, t) {
    const move = table.game.move, k = moveProgress(table.game, t);
    if (!move || k >= .72) return;
    const [sx, sy] = seatAt(table, move.seat), q = Math.min(1, k / .45), hx = mix(sx, target[0], q), hy = mix(sy - 12, target[1], q);
    gg.save(); gg.strokeStyle = move.seat % 2 ? '#6a4fd0' : '#4878a8'; gg.lineWidth = 3;
    gg.beginPath(); gg.moveTo(sx, sy - 10); gg.lineTo(hx, hy); gg.stroke();
    gg.fillStyle = '#d8b18b'; gg.fillRect(Math.round(hx) - 1, Math.round(hy) - 1, 3, 3); gg.restore();
  }
  function drawTableGame(gg, table, t) {
    const game = table.game;
    if (!game) return;
    const side = GO * 2 + 3, bx = table.x - 20, by = table.y + 6 - side, at = (gx, gy) => [bx + 2 + gx * 2, by + 2 + gy * 2];
    gg.fillStyle = '#6b4932'; gg.fillRect(bx, by + side, side, 1);
    gg.fillStyle = '#d8b878'; gg.fillRect(bx, by, side, side);
    gg.fillStyle = '#ccaa6c';
    for (let i = 0; i < GO; i++) { gg.fillRect(bx + 2 + i * 2, by + 2, 1, GO * 2 - 1); gg.fillRect(bx + 2, by + 2 + i * 2, GO * 2 - 1, 1); }
    gg.fillStyle = '#5a3a24';
    for (const gx of [3, 9, 15]) for (const gy of [3, 9, 15]) gg.fillRect(...at(gx, gy), 1, 1);
    for (const stone of game.stones) {
      let [sx, sy] = at(stone.x, stone.y);
      if (game.move && game.stones.at(-1) === stone && moveProgress(game, t) < 1) {
        const [ox, oy] = seatAt(table, game.move.seat), k = moveProgress(game, t); sx = mix(ox, sx, k); sy = mix(oy - 11, sy, k);
      }
      gg.fillStyle = stone.side % 2 ? '#f7f3e8' : '#1c1430'; gg.fillRect(Math.round(sx), Math.round(sy), 2, 2);
      gg.fillStyle = stone.side % 2 ? '#fffdf4' : '#4a4358'; gg.fillRect(Math.round(sx), Math.round(sy), 1, 1);
    }
    if (game.move) drawTableReach(gg, table, at(...game.move.to), t);
  }
  function resetIn(q) {
    if (!q || !q.resets_at) return '';
    const s = Math.max(0, q.resets_at - (Date.now() / 1000 - serverSkew));
    if (s > 86400) return `${Math.round(s / 86400)}D`;
    if (s >= 3600) return `${Math.ceil(s / 3600)}H`;
    return `${s / 60 | 0}M`;
  }
  function detailedResetIn(q) {
    if (q.reset_detail) return q.reset_detail;
    const remaining = Math.ceil(Math.max(0, q.resets_at - (Date.now() / 1000 - serverSkew)) / 60);
    const days = Math.floor(remaining / 1440), hours = Math.floor(remaining % 1440 / 60), minutes = remaining % 60;
    return [[days, 'Day'], [hours, 'Hour'], [minutes, 'Minute']]
      .filter(([value, unit]) => value || unit === 'Minute')
      .map(([value, unit]) => `${value} ${unit}${value === 1 ? '' : 's'}`).join(' ');
  }
  function drawUsageProbes(t) {
    for (const v of usageProbes()) {
      const q = v.q, color = v.color;
      PR.quotaVat(g, v.x, v.y, q.tier == null || q.tier >= 20 ? 'vat' : q.tier >= 5 ? 'half' : 'small', v.fills || (q.left ?? 0), color, t);
      const unavailable = q.error || q.left == null;
      if (unavailable || q.left === 0) {
        const cy = Math.round(v.y + 14 + Math.sin(t * 2 + v.i) * 2);
        g.strokeStyle = color; g.lineWidth = 1;
        if (q.loginExpired) {
          g.beginPath(); g.arc(v.x + 8, cy, 4, 0, Math.PI * 1.5); g.stroke();
          g.beginPath(); g.moveTo(v.x + 6, cy - 6); g.lineTo(v.x + 8, cy - 4); g.lineTo(v.x + 6, cy - 2); g.stroke();
        } else if (unavailable) {
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
  const usageProbes = () => {
    const quotas = lastData.quotas || [], colors = quotas.map((q, i) =>
      `hsl(${(195 + i * 137.508) % 360} 82% 65%)`);
    const model = q => q.provider === 'claude' && q.model;
    const partner = (q, name) => quotas.findIndex(o => model(o) === name && o.account === q.account);
    const probes = [];
    for (let i = 0; i < quotas.length; i++) {
      const cq = quotas[i], fable = model(cq) === 'Claude' ? partner(cq, 'Fable') : -1;
      if (model(cq) === 'Fable' && partner(cq, 'Claude') >= 0) continue;
      if (fable < 0) {
        probes.push({ q: cq, ids: [cq.id], color: colors[i] });
        continue;
      }
      const fq = quotas[fable], origins = [...new Set([...(cq.origins || []), ...(fq.origins || [])])];
      const fableFill = Math.min((fq.left ?? 0) / 2, cq.left ?? 0);
      probes.push({ q: { ...cq, name: cq.account || 'Claude + Fable', origins,
        left: cq.left == null || fq.left == null ? null : cq.left,
        resets_at: cq.resets_at || fq.resets_at, error: cq.error || fq.error,
        loginExpired: cq.loginExpired || fq.loginExpired },
        parts: [cq, fq],
        ids: [cq.id, fq.id], fills: [
          { value: fableFill, color: colors[fable] },
          { value: (cq.left ?? 0) - fableFill, color: colors[i] },
        ], color: colors[fable] });
    }
    return probes.map((v, i) => {
      const q = v.q, local = (q.origins || []).includes('local'), remote = (q.origins || []).includes('remote');
      return { ...v, i, x: 240 - (probes.length - 1 - i) * 22, y: 43,
        label: local && remote ? 'L/R' : local ? 'LOC' : remote ? 'REM' : '' };
    });
  };
  const usageProbe = id => usageProbes().find(v => v.ids.some(qid => id === `usage:${qid}`));

  // animated props, y-sorted with sprites: [sortY, drawFn]
  const props = t => [
    [174, gg => PR.cauldron(gg, 56, 150, t, BREW)],
    [91, gg => PR.shelf(gg, 10 - labExtra, 60, 11)], [127, gg => PR.shelf(gg, 10 - labExtra, 96, 23)],
    [91.1, gg => drawShelfBooks(gg, 0)], [127.1, gg => drawShelfBooks(gg, 1)],
    [62, gg => PR.bench(gg, 88, 42, t)],
    ...RESOURCE_BALLS.map(ball => [ball.y + 22, gg =>
      PR.crystal(gg, ball.x, ball.y, t, ballReading(ball), ball.color, ball.hotColor, ball.accents)]),
    [29, gg => PR.board(gg, 300, 8)],
    ...TABLES.filter(table => table !== COURT && table !== MTG).map(table => [table.y + 5, gg => {
      if (table === TABLES[1]) updateTopTable();
      PR.gameTable(gg, table.x, table.y);
      if (table === TABLES[1]) PR.tableStillLife(gg, table.x, table.y, t);
      drawTableGame(gg, table, t);
    }]),
    [MTG.y + 1, gg => drawMagic(gg, t)],
    [86, gg => PR.hearth(gg, 440, 50, t)],
    [82, gg => PR.chair(gg, 418, 57, false)], [104, gg => PR.chair(gg, 418, 79, false)],
    [214.5, gg => PR.counter(gg, 296, 196)], [215, gg => PR.espresso(gg, 306, 186, t)],
    [215.2, gg => PR.beans(gg, PAN[0], PAN[1], t < dragon.roastUntil + 4)],
    [215.3, gg => { if (dragon.task) PR.cup(gg, CUP[0], CUP[1], dragon.task.drink.key, t); }],
    [334, gg => PR.doorway(gg, 424, 318, t)],
  ];
  const occupied = key => [...wizards.values()].some(w => w.station === key && !w.path.length && (w.a.status === 'working' || w.a.status === 'attention'));

  const brewR = rng(20260920), BREW_COLORS = ['#58d878', '#71bcf2', '#c18bea', '#ef8fa8', '#f4c565'];
  const BREW = { from: BREW_COLORS[0], color: BREW_COLORS[0], next: 7, changed: -5, strike: -5, fireStart: -5, fire: -5, flame: 0, count: 0 };
  function updateBrew(t) {
    if (t >= BREW.next) {
      BREW.count++;
      if (BREW.count % 3 !== 0) {
        BREW.from = BREW.color;
        const i = BREW_COLORS.indexOf(BREW.color);
        BREW.color = BREW_COLORS[(i + 1 + Math.floor(brewR() * 4)) % BREW_COLORS.length];
        BREW.changed = t;
      }
      if (BREW.count % 2) BREW.strike = t;
      BREW.fireStart = t;
      BREW.fire = t + 2 + brewR() * 2;
      BREW.next = t + 12 + brewR() * 14;
    }
    const p = Math.max(0, Math.min(1, (t - BREW.fireStart) / .7, (BREW.fire - t) / .7));
    BREW.flame = p * p * (3 - 2 * p);
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
  // A walker that has made no progress for a second blinks to the end of its path.
  function unstick(w, t) {
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
    if (dragon.dest === 'stretch' || dragon.dest === 'bar') sigilEvent({ kind: 'landing', x: dragon.x, y: dragon.y, at: t, life: 1.5 });
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
    const frozen = w => doorStandoff && sceneTime < doorStandoff.at + .9 && doorStandoff.ids.includes(w.a.id);
    const a = [...wizards.values()].filter(w => w.alpha > .25 && !w.blast && !w.summon).map(w => ({ e: w, r: WIZ_R + 1, fixed: !!atDesk(w) || frozen(w) }));
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

  function startMimic(desk) {
    if (!desk || MIMIC.active) return false;
    Object.assign(MIMIC, { active: true, x: 38, y: 76, phase: 'approach', desk, until: 0,
      targetX: desk.x, targetY: desk.y });
    MIMIC.path = route(MIMIC.x, MIMIC.y, desk.x - 18, desk.y - 8, CAT_R);
    return true;
  }
  function retreatMimic() {
    if (MIMIC.desk) MIMIC.desk.robbed = false;
    MIMIC.phase = 'escape'; MIMIC.path = route(MIMIC.x, MIMIC.y, 38, 76, CAT_R);
  }
  function updateMimic(dt, t) {
    if (!MIMIC.active) {
      if (t < MIMIC.nextAt) return;
      const targets = desks.filter(d => d.active && d.alpha > .8 && !d.robbed);
      if (targets.length) startMimic(targets[mimicR() * targets.length | 0]);
      else MIMIC.nextAt = t + 25;
      return;
    }
    if (MIMIC.phase === 'approach') {
      const d = MIMIC.desk;
      if (!d || !d.active || !desks.includes(d)) retreatMimic();
      else if (d.x !== MIMIC.targetX || d.y !== MIMIC.targetY) {
        MIMIC.targetX = d.x; MIMIC.targetY = d.y;
        MIMIC.path = route(MIMIC.x, MIMIC.y, d.x - 18, d.y - 8, CAT_R);
      }
    }
    if (MIMIC.path.length) { moveAlong(MIMIC, dt, 34); return; }
    if (MIMIC.phase === 'approach') {
      MIMIC.phase = 'steal'; MIMIC.until = t + 1; MIMIC.desk.robbed = true;
    } else if (MIMIC.phase === 'steal' && t >= MIMIC.until) {
      retreatMimic();
    } else if (MIMIC.phase === 'escape') {
      if (MIMIC.desk) MIMIC.desk.robbed = false;
      Object.assign(MIMIC, { active: false, phase: 'hidden', desk: null, nextAt: t + 90 + mimicR() * 120 });
    }
  }

  function spawnHauntedTodo(w, desk, t) {
    if (!w || !desk || HAUNTED_TODOS.some(todo => todo.owner === w.a.id)) return false;
    HAUNTED_TODOS.push({ owner: w.a.id, x: desk.x, y: desk.y - 10, at: t, caughtAt: 0, phase: 'rise' });
    return true;
  }
  function updateHauntedTodos(dt, t) {
    for (let i = HAUNTED_TODOS.length - 1; i >= 0; i--) {
      const todo = HAUNTED_TODOS[i], w = wizards.get(todo.owner), age = t - todo.at;
      if (!w || age > 9 || todo.caughtAt && t - todo.caughtAt > 1.2) {
        if (w && todo.caughtAt && w.emote === 'alert') w.emote = emoteFor(w);
        HAUNTED_TODOS.splice(i, 1); continue;
      }
      if (age < .8) { todo.y -= dt * 10; continue; }
      if (todo.caughtAt) continue;
      todo.phase = 'chase';
      const tx = w.x + (w.dir < 0 ? 8 : -8), ty = w.y - 18, dx = tx - todo.x, dy = ty - todo.y, d = Math.hypot(dx, dy);
      if (d < 7) {
        todo.caughtAt = t; w.emote = 'alert'; sparkleAt(w.x, w.y - 20); continue;
      }
      const step = Math.min(d, dt * 46);
      todo.x += dx / d * step; todo.y += dy / d * step;
    }
  }

  function startDoorStandoff(a, b, t) {
    if (!a || !b || doorStandoff) return false;
    const yielding = (hash(a.a.id + b.a.id) & 1) ? a : b;
    doorStandoff = { ids: [a.a.id, b.a.id], yielding: yielding.a.id, at: t, until: t + 2.4,
      sideX: yielding.x < 436 ? 416 : 456 };
    return true;
  }
  function updateDoorStandoff(t) {
    if (doorStandoff && t >= doorStandoff.until) {
      const w = wizards.get(doorStandoff.yielding), dest = w && (w.path.at(-1) || w.home);
      doorStandoff = null; nextDoorStandoff = t + 45;
      if (w && dest) pathTo(w, dest[0], dest[1]);
    }
    if (doorStandoff || t < nextDoorStandoff) return;
    const near = [...wizards.values()].filter(w => w.path.length && !w.game && !w.blast && w.alpha > .7 && w.x > 410 && w.y > 280);
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
      const da = Math.sign(near[i].path.at(-1)[1] - near[i].y), db = Math.sign(near[j].path.at(-1)[1] - near[j].y);
      if (da && db && da !== db && Math.hypot(near[i].x - near[j].x, near[i].y - near[j].y) < 28) {
        startDoorStandoff(near[i], near[j], t); return;
      }
    }
  }
  function standoffMove(w, dt, t) {
    if (!doorStandoff || !doorStandoff.ids.includes(w.a.id) || t >= doorStandoff.until) return false;
    if (t < doorStandoff.at + .9) { w.walk = false; return true; }
    if (w.a.id !== doorStandoff.yielding) return false;
    const dx = doorStandoff.sideX - w.x, step = Math.min(Math.abs(dx), dt * 28);
    w.x += Math.sign(dx) * step; w.walk = step > 0;
    return true;
  }

  function update(dt, t) {
    sceneTime = t;
    for (const events of [SIGIL_EVENTS, SIGIL_LINKS])
      for (let i = events.length - 1; i >= 0; i--) if (t - events[i].at > events[i].life) events.splice(i, 1);
    updateBrew(t);
    updateMimic(dt, t);
    updateHauntedTodos(dt, t);
    updateDoorStandoff(t);
    for (let i = RITUALS.length - 1; i >= 0; i--) if (t - RITUALS[i].at > 3) RITUALS.splice(i, 1);
    for (const d of desks) d.alpha = Math.max(0, Math.min(1, d.alpha + (d.active ? 3 : -2) * dt));
    let removed = false;
    for (let i = desks.length - 1; i >= 0; i--) if (!desks[i].active && !desks[i].alpha) { desks.splice(i, 1); removed = true; }
    if (removed) shrinkLab();
    updateBattle(t);
    for (const [id, w] of wizards) {
      if (w.summon && !w.leaving) {
        if (t < w.summon.until) {
          w.alpha = Math.max(0, Math.min(1, (t - w.summon.at) / 1.6));
          continue;
        }
        w.summon = null;
        if (w.a.kind === 'sub') sigilLink(w, false);
        if (w.home) pathTo(w, ...w.home);
      }
      if (w.leaving) w.summon = null;
      if (w.blast) {
        if (t < w.blast.until) continue;
        w.blast = null;
        reformWizard(w);
        if (!w.leaving && w.home) pathTo(w, w.home[0], w.home[1]);
      }
      const standingOff = standoffMove(w, dt, t);
      if (standingOff) w.stuckAt = 0;
      else { w.walk = moveAlong(w, dt, SPEED); unstick(w, t); }
      if (atDesk(w)) { w.desk.elapsed += dt; w.x = w.desk.x; w.y = w.desk.y; w.walk = false; }
      w.alpha = Math.max(0, Math.min(1, w.alpha + (w.leaving && !w.path.length ? -3 : w.leaving && w.y > 312 ? -1.2 : 3) * dt));
      if (w.leaving && w.alpha <= 0) { wizards.delete(id); continue; }
      if (w.a.status === 'idle' && !w.game && Math.random() < dt * .5) spark(w.x + 6, w.y - 24, '#a8a2c8', -6, 1.4, 'z');
      if (w.a.status === 'attention' && Math.random() < dt * 2) spark(w.x, w.y - 26, '#ff5a5a', -10, .5);
      const aura = AURA[w.a.effort];
      if (aura && BUSY.has(w.a.status) && !w.blast && w.alpha > .8 && Math.random() < dt * aura[0])
        spark(w.x + Math.random() * 14 - 7, w.y - 3 - Math.random() * 18, aura[1], -9, .9);
      maybeCast(w, t);
    }
    updateDragonSignal(t);
    updateDragon(dt, t);
    maybeCatCast(t);
    updateSpells(dt, t);
    updateBirds(dt);
    cafeService(t);
    maybeCafeChat(t);
    maybeDragonStretch(t);
    updateTableGames(t);
    updateMagicCards(dt, t);
    updateLightning(t);
    // ambient particles
    if (Math.random() < dt * (2 + BREW.flame * 7)) spark(62 + Math.random() * 16, 154, BREW.color, -14, .8);
    const circleActive = SIGIL_EVENTS.some(e => e.kind === 'summon' || e.kind === 'cat');
    if (Math.random() < dt * (circleActive ? 7 : .45)) { const a = Math.random() * 6.28; spark(430 + Math.cos(a) * 22, 220 + Math.sin(a) * 9, circleActive ? '#d8c8ff' : '#9a7cf0', -12, .9); }
    for (const ball of RESOURCE_BALLS) if (ballReading(ball) > 75 && Math.random() < dt * 12)
      spark(ball.x + 7 + Math.random() * 12 - 6, ball.y + 3, Math.random() < .5 ? ball.hotColor : ball.accents.flare || '#ffe89a', -12, .7);
    if (occupied('crystal') && Math.random() < dt * 3) spark(223, 100, '#cfe8ff', -8, .7);
    if ([...wizards.values()].some(w => w.station === 'cafe') && Math.random() < dt * 4) spark(312, 184, '#d8d4e4', -9, 1);
    const dBar = dragonAtBar();
    if (dBar && !dragon.task && Math.random() < dt * 3) spark(450 + Math.random() * 6, 86, '#f0a83c', -11, .7);
    // Active work keeps the beans roasting; rare stretch flights belong to the waiting state.
    if (dragon.signal === 'active' && dBar && !dragon.task && t > dragon.roastAt && t >= dragon.flapUntil) { dragon.roastUntil = t + 1.8; dragon.roastAt = t + 4 + Math.random() * 4; }
    if (dBar && !dragon.task && t < dragon.flapUntil && Math.random() < dt * 9) spark(dragon.x - 14 + Math.random() * 28, dragon.y - 4, '#b8b2cc', -3, .5);
    if ((dragon.task && dragon.task.phase === 'brew') || (dBar && t < dragon.roastUntil)) {
      if (Math.random() < dt * 22) spark(PAN[0] + 2 + Math.random() * 5, PAN[1] - 1, Math.random() < .5 ? '#ffd84a' : '#f08a2a', -8 - Math.random() * 8, .45);
    } else if (dBar && !dragon.task && t < dragon.roastUntil + 4 && Math.random() < dt * 6) {
      spark(PAN[0] + 4, PAN[1] - 2, '#9a93b0', -8, 1.2);                 // fresh-roast smoke
    } else if (dragon.signal !== 'empty' && dBar && !dragon.task && Math.random() < dt * .15) {
      spark(dragon.x - 13, dragon.y - 21, '#9a93b0', -5, .9);            // idle nostril puff
    }
    if (dragon.signal === 'empty' && dBar && Math.random() < dt * .45) spark(dragon.x - 10, dragon.y - 20, '#a8a2c8', -5, 1.3, 'z');
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
        } else if (cat.dest === 'sigil') {
          cat.state = 'sit'; cat.sigilAt = t; cat.until = t + 5;
          sigilEvent({ kind: 'cat', at: t, life: 2.4 });
        } else if (cat.dest === 'game') {
          cat.state = 'game';
          cat.dest = null;
          cat.until = t + 120;
        } else catThink(t);
      } else unstick(cat, t);
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
    const rest = w.a.status === 'idle' && !w.walk && !w.game;
    const idle = rest ? 'sleep' : 'idle';
    const f = w.walk ? ((t * 6 | 0) % 2 ? 'walkA' : 'walkB') : ((t + w.ph) % 2.6 < 1.3 ? idle + 'A' : idle + 'B');
    const materializing = w.summon && Math.max(0, Math.min(1, (t - w.summon.at) / 1.6));
    const img = w.summon && materializing < .6 ? w.sp.frames.silhouette : w.sp.frames[f];
    g.globalAlpha = .3 * w.alpha; g.fillStyle = '#0a0810'; g.fillRect(w.x - 5, w.y - 1, 10, 2);
    g.globalAlpha = w.alpha;
    g.save(); g.translate(w.x + (w.dir < 0 ? 10 : -10), w.y - 23 + (atDesk(w) ? 3 : 0));
    if (w.dir < 0) g.scale(-1, 1);
    if (w.summon) { g.beginPath(); g.rect(0, 24 * (1 - materializing), 20, 24 * materializing); g.clip(); }
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
    for (const link of SIGIL_LINKS) {
      const p = Math.max(0, Math.min(1, (t - link.at) / link.life));
      g.save(); g.globalAlpha = Math.sin(p * Math.PI) * .65;
      g.strokeStyle = link.returning ? '#ffd84a' : '#b9a5e8'; g.lineWidth = 1; g.setLineDash([2, 4]);
      g.beginPath();
      link.points.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
      g.stroke();
      let distance = p * link.length;
      for (let i = 0; i < link.lengths.length; i++) {
        if (distance > link.lengths[i]) { distance -= link.lengths[i]; continue; }
        const a = link.points[i], b = link.points[i + 1], k = link.lengths[i] ? distance / link.lengths[i] : 1;
        g.fillStyle = link.returning ? '#ffe89a' : '#e8dcff';
        g.fillRect(Math.round(a[0] + (b[0] - a[0]) * k) - 1, Math.round(a[1] + (b[1] - a[1]) * k) - 1, 3, 3);
        break;
      }
      g.restore();
    }
    for (const child of wizards.values()) {
      if (child.a.kind !== 'sub' || !child.a.parent) continue;
      const parent = wizards.get(child.a.parent);
      if (!parent || parent.leaving || child.leaving) continue;
      const hot = [sel, hover].includes(parent.a.id) || [sel, hover].includes(child.a.id);
      if (!hot) continue;
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
  // ---------- missives, shared files, drinkers, strays, and the library ----------
  const BIRDS = [], WINDOW_PERCH = [WIN_X[2] + 7, 24], DOOR_PERCH = [ST.door.spots[0][0], ST.door.spots[0][1] - 12];
  let missiveKeys = null;
  const perch = (id, fallback) => { const w = wizards.get(id); return w && !w.leaving ? [w.x, w.y - 22] : fallback; };
  function launchMissives(data) {
    const keys = new Set();
    for (const a of data.agents) {
      const sent = (a.missives || []).map(m => ({ ...m, from: a.id })), heard = (a.inbox || []).map(m => ({ ...m, to: a.id }));
      for (const m of [...sent, ...heard]) {
        const key = `${m.from}@${m.ts}`;  // a recipient resolved later is still the same missive
        keys.add(key);
        if (missiveKeys && !missiveKeys.has(key) && data.now - m.ts < 30 && BIRDS.length < 8)
          BIRDS.push({ from: m.from, to: m.to, t: 0, life: 2.4, seal: (wizards.get(m.from) || { sp: {} }).sp.demon ? '#f08a2a' : '#d86ad8' });
      }
    }
    missiveKeys = keys;  // the first poll only learns what has already been said
  }
  function birdAt(b) {
    const [sx, sy] = perch(b.from, WINDOW_PERCH), [tx, ty] = perch(b.to, DOOR_PERCH), k = Math.min(1, b.t / b.life);
    return [mix(sx, tx, k), mix(sy, ty, k) - Math.sin(k * Math.PI) * 26];
  }
  function updateBirds(dt) {
    for (let i = BIRDS.length - 1; i >= 0; i--) {
      const b = BIRDS[i];
      b.t += dt;
      if (b.t < b.life) continue;
      sparkleAt(...perch(b.to, DOOR_PERCH).map((v, j) => v + (j ? 10 : 0)));
      BIRDS.splice(i, 1);
    }
  }
  function drawBirds(t) { for (const b of BIRDS) PR.missive(g, ...birdAt(b), t, b.seal); }
  function drawClashes(t) {
    for (const w of wizards.values()) for (const c of w.a.clash || []) {
      const o = wizards.get(c.with);
      if (!o || o.leaving || w.leaving || w.a.id > c.with) continue;
      const hot = [sel, hover].some(id => id === w.a.id || id === o.a.id), n = Math.max(6, Math.hypot(o.x - w.x, o.y - w.y) / 4 | 0);
      g.globalAlpha = hot ? .85 : .3; g.fillStyle = '#ff7a4a';
      for (let i = 0; i <= n; i++) if ((i + (t * 4 | 0)) % 4 < 2)
        g.fillRect(Math.round(mix(w.x, o.x, i / n)), Math.round(mix(w.y, o.y, i / n) - 9), 1, 1);
      g.globalAlpha = 1;
      PR.crossedWands(g, (w.x + o.x) / 2, (w.y + o.y) / 2 - 9, t, hot);
    }
  }
  // Claude sessions name their account; anything else drinks from the only bottle in use on its machine.
  const BOTTLES = new Map();
  function assignBottles() {
    BOTTLES.clear();
    const probes = usageProbes(), parts = v => [v.q, ...(v.parts || [])];
    for (const a of lastData.agents || []) {
      const provider = a.engine === 'codex' ? 'codex' : 'claude';
      const exact = a.login && probes.find(v => parts(v).some(q => q.loginId === a.login));
      const near = probes.filter(v => parts(v).some(q => q.provider === provider && (q.origins || []).includes(a.origin)));
      const v = exact || (near.length === 1 ? near[0] : null);
      if (v) BOTTLES.set(a.id, v.q.id);
    }
  }
  const drinkersOf = v => (lastData.agents || []).filter(a => BOTTLES.get(a.id) === v.q.id);
  function drawDrips(t) {
    const v = usageProbe(hover), w = wizards.get(hover) || wizards.get(sel);
    const own = w && usageProbes().find(p => p.q.id === BOTTLES.get(w.a.id));
    const pairs = v ? drinkersOf(v).map(a => [v, wizards.get(a.id)]) : own ? [[own, w]] : [];
    for (const [p, x] of pairs) {
      if (!x || x.leaving || x.alpha < .5) continue;
      const sx = p.x + 8, sy = p.y + 26, n = Math.max(8, Math.hypot(x.x - sx, x.y - 24 - sy) / 5 | 0);
      g.fillStyle = p.color;
      for (let i = 0; i < n; i++) {
        const k = (i / n + t * .35) % 1;
        g.globalAlpha = .25 + .55 * Math.sin(k * Math.PI);
        g.fillRect(Math.round(mix(sx, x.x, k)), Math.round(mix(sy, x.y - 24, k) + Math.sin(k * Math.PI) * 10), 1, 2);
      }
      g.globalAlpha = 1;
    }
  }
  function drawStrays(t) {
    const strays = lastData.orphans || [], remote = lastData.resources?.remote?.host;
    [o => !o.host, o => remote && o.host === remote].forEach((mine, col) => strays.filter(mine).slice(0, 3).forEach((o, i) =>
      PR.ghost(g, 201 + col * 22 + Math.cos(t * .6 + i * 2.1) * 13, 94 + Math.sin(t * .9 + i * 2.1) * 5, t + i)));
  }
  let annals = { days: [], library: [], edges: [] }, annalsStamp = null, copied = null;
  const SHELVES = () => [[10 - labExtra, 60], [10 - labExtra, 96]];
  const shelfBooks = () => (annals.library || []).slice(0, 48).map((book, i) => {
    const [x, y] = SHELVES()[i / 24 | 0];
    return { book, i, x: x + 3 + (i % 6) * 3, y: y + 3 + ((i % 24) / 6 | 0) * 7 };
  });
  function drawShelfBooks(gg, shelf) {
    for (const { book, i, x, y } of shelfBooks().filter(b => (b.i / 24 | 0) === shelf)) {
      gg.fillStyle = '#2c2014'; gg.fillRect(x, y - 1, 2, 6);
      gg.fillStyle = `hsl(${hash(book.project || book.id) % 360} 55% ${hover === 'book:' + i ? 75 : 52}%)`; gg.fillRect(x, y, 2, 5);
      gg.fillStyle = '#f7f3e8'; gg.fillRect(x, y + 2, 2, 1);  // a title plate sets quest books apart from the shelf's own
      if ((book.prs || []).length) { gg.fillStyle = '#ffd84a'; gg.fillRect(x, y, 2, 1); }
      if (book.engine === 'codex') { gg.fillStyle = '#f0a83c'; gg.fillRect(x, y + 3, 2, 1); }
    }
  }
  async function fetchAnnals() {
    try {
      annals = await (await fetch('/api/annals')).json();
      if (!$('#annals').hidden) renderAnnals();
    } catch { /* the tower will be back */ }
  }

  function drawCafeChat(t) {
    if (!cafeChat) return;
    const second = t - cafeChat.start >= 3.6, w = wizards.get(second ? cafeChat.b : cafeChat.a);
    if (!w || !cafeReady(w)) { cafeChat = null; return; }
    bubble(w.x, Math.max(38, w.y - 51), cafeChat.lines[second ? 1 : 0]);
  }
  // A speech bubble kept inside the cafe, its tail pointing down at x.
  function bubble(x, y, text) {
    const width = textW(text) + 8, left = Math.max(274, Math.min(478 - width, x - width / 2));
    g.fillStyle = '#f7f3e8'; g.fillRect(left, y, width, 11);
    g.fillStyle = '#262032'; g.fillRect(left, y, width, 1); g.fillRect(left, y + 10, width, 1);
    g.fillRect(left, y, 1, 11); g.fillRect(left + width - 1, y, 1, 11);
    g.fillStyle = '#f7f3e8'; g.fillRect(Math.round(x), y + 11, 2, 2);
    drawText(g, left + 4, y + 3, text, '#30283e');
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
      drawLightning(s.sx, s.sy, s.tx, s.ty, s.seed + (s.t * 18 | 0) * 97, s.c || '#8fd0ff');
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
        const size = (j ? 2 : 4) * (s.size || 1);
        g.fillRect(Math.round(p[0] - size / 2), Math.round(p[1] - size / 2), size, size);
      }
    } else {
      const c = s.kind === 'rune' ? '#58d878' : '#d8ff58';
      g.fillStyle = c;
      g.fillRect(Math.round(x), Math.round(y) - 3, 2, 8);
      g.fillRect(Math.round(x) - 3, Math.round(y), 8, 2);
      if (s.kind === 'rune') { g.fillRect(Math.round(x) - 2, Math.round(y) - 2, 2, 2); g.fillRect(Math.round(x) + 3, Math.round(y) + 3, 2, 2); }
    }
  }
  const DESK_LABEL_COLORS = {
    wizard: { paper: '#d8c294', text: '#514034' },
    demon: { paper: '#e3bfc7', text: '#492737' },
  };
  const DESK_WOODS = {
    oak: [['#493025', '#986b45', '#c49560'], ['#382334', '#793c55', '#bd7184']],
    cherry: [['#522b27', '#a34e40', '#d98369'], ['#361a28', '#702b41', '#b95365']],
    maple: [['#957346', '#dab77d', '#f5dba5'], ['#574037', '#a17b69', '#d6ac91']],
    birch: [['#9c8870', '#e0cfac', '#fff0ce'], ['#51414e', '#a18c9b', '#d3bdcc']],
    walnut: [['#30231e', '#604333', '#937052'], ['#211b29', '#453047', '#80536e']],
    ash: [['#665c49', '#ad9c79', '#d9cba8'], ['#303b38', '#626f60', '#99a58a']],
  };
  function deskColors(w) {
    const id = w.a.parent || w.a.id, demon = (wizards.get(w.a.parent) || w).sp.demon;
    const woods = Object.values(DESK_WOODS);
    const [legs, wood, edge] = woods[hash(id + ':wood') % woods.length][demon ? 1 : 0];
    return { ...DESK_LABEL_COLORS[demon ? 'demon' : 'wizard'], legs, wood, edge, frame: wood, pins: edge };
  }
  function drawWorkDesk(d, front, t) {
    const { x, y, w } = d, width = w.sp.sub ? 30 : 48;
    const colors = deskColors(w);
    g.save(); g.globalAlpha = d.alpha;
    if (!front) {
      PR.chair(g, x - 7, y - 13, false);
    } else {
      g.fillStyle = colors.legs; g.fillRect(x - width / 2 + 3, y - 1, 3, 10); g.fillRect(x + width / 2 - 6, y - 1, 3, 10);
      g.fillStyle = colors.wood; g.fillRect(x - width / 2, y - 7, width, 8);
      g.fillStyle = colors.edge; g.fillRect(x - width / 2, y - 7, width, 2);
      const drink = d.active && atDesk(w) && w.order && w.order.stage === 'served' ? w.order.drink.key : null;
      const seed = hash(w.a.id + ':desk');
      if (!d.robbed) PR.deskDecor(g, x, y, width, seed, drink, t);
      if (!RITUALS.some(r => r.desk === d)) PR.deskPet(g, x + 5, y - 5, seed, t, false);
      const ctx = w.a.ctx;  // the candle burns down as the context window fills, and is relit by compaction
      if (ctx && ctx[1] > 0) PR.candle(g, x + width / 2 - 3, y - 7, 1 - ctx[0] / ctx[1], t, Math.max(0, 1 - (t - (w.relitAt ?? -9)) / 2));
    }
    g.restore();
  }
  function drawTaskLabel(d) {
    const colors = deskColors(d.w);
    const shown = taskLabelLines(d.w);
    if (!shown.length) return;
    const width = Math.max(...shown.map(line => textW(line))) + 8, left = Math.round(d.x - width / 2), top = d.y + 3;
    g.save(); g.globalAlpha = d.alpha;
    g.fillStyle = colors.frame; g.fillRect(left, top, width, shown.length * 8 + 3);
    g.fillStyle = colors.paper; g.fillRect(left + 1, top + 1, width - 2, shown.length * 8 + 1);
    g.fillStyle = colors.pins; g.fillRect(left - 1, top + 1, 3, 3); g.fillRect(left + width - 2, top + 1, 3, 3);
    shown.forEach((line, i) => drawText(g, Math.round(d.x - textW(line) / 2), top + 3 + i * 8, line, colors.text));
    g.restore();
  }
  function drawFloorSigils(t) {
    g.save();
    g.beginPath(); g.rect(8 - labExtra, 34, 256 + labExtra, 226 + labDown); g.rect(272, 34, 200, 286); g.clip();
    PR.floorSigil(g, CAULDRON_SIGIL.x, CAULDRON_SIGIL.y, CAULDRON_SIGIL.radius, t, BREW.color, '#ddfff1', 0);
    RESOURCE_BALLS.forEach((ball, i) => PR.floorSigil(g, ball.x + 7, ball.y + 21, 12, t,
      { cpu: '#dda1b1', memory: '#a9c7ff', disk: '#8ce8b0' }[ball.metric], '#e4f4ff', i));
    for (const d of desks) if (d.active && !d.w.summon) {
      g.save(); g.globalAlpha = d.alpha;
      const w = d.w;
      PR.workSigil(g, d.x, d.y - 9, w.sp.sub ? 18 : 29, w.sigil.seed, sigilColor(w), w.sigil.mode, t,
        w.sigil.charge, w.sigil.flash, sigilGust(d.x, d.y, t));
      g.restore();
    }
    for (const w of wizards.values()) if (w.sigil.mode === 'ask' && !w.walk && !w.leaving && !w.blast)
      PR.workSigil(g, w.x, w.y + 1, 18, w.sigil.seed, sigilColor(w), 'ask', t, 0, -9, 0);
    const summons = SIGIL_EVENTS.filter(e => (e.kind === 'summon' || e.kind === 'cat') && t >= e.at);
    const event = summons.find(e => e.demon) || summons.at(-1);
    PR.circle(g, 404, 206, t, !!event, event && { ...event, progress: (t - event.at) / event.life }, sigilGust(430, 220, t));
    for (const e of SIGIL_EVENTS) if (e.kind === 'landing') PR.sigilRipple(g, e.x, e.y, (t - e.at) / e.life, '#e8c77b');
    g.restore();
  }
  // Clodex's drifting, twinkling motes use the scene clock and expand with the lab.
  function drawStars(t) {
    g.save();
    for (let i = 0; i < 36; i++) {
      const x = 14 - labExtra + ((i * 97.3 + Math.sin(t * .25 + i) * 9) % (450 + labExtra));
      const y = 42 + ((i * 31.7 - t * (2 + i % 3)) % (210 + labDown) + 210 + labDown) % (210 + labDown);
      g.globalAlpha = .15 + (Math.sin(t * 1.3 + i * 2) + 1) * .22;
      g.fillStyle = ['#e8c77b', '#a9c7ff', '#8ce8ce'][i % 3];
      g.fillRect(Math.round(x), Math.round(y), 1, 1);
      if (i % 9 === 0) {
        g.globalAlpha *= .4;
        g.fillRect(Math.round(x) - 2, Math.round(y), 5, 1);
        g.fillRect(Math.round(x), Math.round(y) - 2, 1, 5);
      }
    }
    g.restore();
  }
  function draw(t) {
    g.clearRect(-labExtra, 0, VW + labExtra, VH + labDown);
    g.drawImage(bg, -labExtra, 0);
    drawFloorSigils(t);
    for (let i = 0; i < 5; i++) PR.window(g, WIN_X[i], 8, t, i * 7 + 3);
    drawLightningWindow(g, t);
    PR.torch(g, 24, 14, t); PR.torch(g, 240, 14, t + .5); PR.torch(g, 282, 14, t + .2); PR.torch(g, 444, 14, t + .8);
    drawLightningCast(g, t);
    drawBonds(t);
    drawClashes(t);
    drawCourt(g, t);
    const dragonFire = SPELLS.find(s => s.kind === 'counterfire' && s.t >= 0), fireVictim = dragonFire && wizards.get(dragonFire.target);
    const fireX = fireVictim ? fireVictim.x : dragonFire && dragonFire.tx;
    const items = props(t).map(([y, f]) => ({ y, f: () => f(g) }));
    for (const d of desks) {
      items.push({ y: d.y - 1, f: () => drawWorkDesk(d, false, t) });
      items.push({ y: d.y + 1, f: () => drawWorkDesk(d, true, t) });
    }
    for (const w of wizards.values()) items.push({ y: w.y, f: () => drawWizardSprite(w, t) });
    if (MIMIC.active) items.push({ y: MIMIC.y, f: () => PR.mimic(g, MIMIC.x, MIMIC.y, t, MIMIC.phase === 'steal', MIMIC.phase !== 'approach') });
    for (const todo of HAUNTED_TODOS) items.push({ y: todo.y, f: () => PR.hauntedTodo(g, todo.x, todo.y, t, todo.phase !== 'rise') });
    items.push({ y: dragon.y, f: () => {
      if (dragon.blast) { drawBlast(dragon, dragon.blast, t, '#f08a2a'); return; }
      const busy = !!dragon.task, brewing = busy && dragon.task.phase === 'brew', firing = !!dragonFire, flying = dragon.mode === 'fly';
      const stretch = !busy && !dragon.mode && t < dragon.flapUntil, flap = flying || stretch, p = stretch ? 1 - (dragon.flapUntil - t) / 3 : 0;
      const lift = flying ? 10 + Math.sin(t * 9) * 2 : Math.sin(p * Math.PI) * 7;
      g.globalAlpha = .3; g.fillStyle = '#0a0810';
      g.fillRect(dragon.x - 9 + lift / 2, dragon.y - 1, 18 - lift, 2);
      g.globalAlpha = 1;
      if (dragon.signal === 'empty' && dragonAtBar() && !busy) {
        g.drawImage(dragon.frames.sleep, Math.round(dragon.x - 15), Math.round(dragon.y - 23));
      } else if (flap && !firing) {
        const sway = Math.sin(t * 2.8) * 3 * Math.sin(p * Math.PI);
        g.drawImage(dragon.frames[(t * 7 | 0) % 2 ? 'flapA' : 'flapB'], Math.round(dragon.x - 22 + sway), Math.round(dragon.y - 29 - lift));
      } else {
        const fr = firing || brewing || t < dragon.roastUntil ? ((t * 8 | 0) % 2 ? 'roastA' : 'roastB') : (t % 2.6 < 1.3 ? 'idleA' : 'idleB');
        const img = dragon.frames[fr], y = Math.round(dragon.y - 25 - (firing ? lift : 0));
        if (firing ? fireX > dragon.x : !busy && t < dragon.lookUntil && dragon.lookX > dragon.x) {
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
    if (doorStandoff) tag(436, 284, t < doorStandoff.at + .9 ? 'YOU SHALL NOT PASS' : 'AFTER YOU');
    for (const todo of HAUNTED_TODOS) if (todo.caughtAt) tag(todo.x, todo.y - 10, 'TODO!');
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
    drawDrips(t);
    drawStrays(t);
    drawBirds(t);
    for (const p of PARTS) {
      g.globalAlpha = Math.max(0, 1 - p.t / p.life);
      if (p.kind === 'z') drawText(g, p.x, p.y, 'Z', p.c);
      else { g.fillStyle = p.c; g.fillRect(p.x, p.y, p.t < p.life / 2 ? 2 : 1, p.t < p.life / 2 ? 2 : 1); }
    }
    g.globalAlpha = 1;
    for (const w of wizards.values()) {
      if (w.emote && !w.walk && !w.blast && w.alpha > .8 && !SPELLS.some(s => s.source === w.a.id && (s.kind === 'rain' || s.kind === 'storm'))) drawEmote(g, w.x, w.y - 26, w.emote, t + w.ph);
      if (w.order && w.order.stage === 'served' && !atDesk(w) && w.game !== COURT.id && w.game !== MTG.id && !w.walk && !w.blast && w.alpha > .8) PR.cup(g, w.x + (w.dir < 0 ? -14 : 4), w.y - 11, w.order.drink.key, t + w.ph);
      if (w.order && w.order.stage !== 'served' && !w.walk && !w.blast && w.alpha > .8 && ((t + w.ph) % 6) < 2.4) tag(w.x, w.y - 45, w.order.drink.name);
      if ((hover === w.a.id || sel === w.a.id) && !w.blast && w.alpha > .5) tag(w.x, w.y - 38, w.sp.name);
    }
    drawRally(t);
    for (const r of RITUALS) {
      const p = Math.max(0, (t - r.at) / 3);
      PR.sigilSeal(g, r.x, r.y - 9, r.sigilSeed, p);
      g.save(); g.globalAlpha = 1 - p;
      PR.deskPet(g, r.x + 5, r.y - 5, r.seed, t, true); g.restore();
    }
    drawCafeChat(t);
    drawMagicFront(t);
    if (t - dragon.lookAt < 1.2 && !dragon.blast) drawEmote(g, dragon.x, dragon.y - 36, 'alert', t);
    if (cat.order && cat.order.stage === 'served') PR.cup(g, cat.x + 5, cat.y - 6, cat.order.drink.key, t);
    if (cat.order && cat.order.stage !== 'served' && ((t + 1.7) % 6) < 2.4) tag(cat.x, cat.y - 25, cat.order.drink.name);
    if (demonCat.active && demonCat.order && demonCat.order.stage === 'served') PR.cup(g, demonCat.x + 5, demonCat.y - 6, demonCat.order.drink.key, t);
    if (demonCat.active && demonCat.order && demonCat.order.stage !== 'served' && !demonCat.path.length && ((t + 2.3) % 6) < 2.4) tag(demonCat.x, demonCat.y - 25, demonCat.order.drink.name);
    if (hover === 'cat') tag(cat.x, cat.y - 20, 'BIGGLES, STAFF CAT');
    if (hover === 'demon-cat' && demonCat.active) tag(demonCat.x, demonCat.y - 20, 'LUCIPURR');
    if (hover === 'barista') tag(dragon.x, dragon.y - 32, `EARL GREY: ${dragon.signal === 'attention' ? 'ALERT' : dragon.signal === 'active' ? 'ROASTING' : dragon.signal === 'empty' ? 'ASLEEP' : 'BARISTA'}`);
    if (copied && t - copied.at < 2) tag(copied.x, copied.y, 'RESUME COMMAND COPIED');
    drawText(g, 334, 307, 'MANA CAFE', '#ffd84a');
    drawText(g, 60 - labExtra / 2, 240 + labDown, 'LABORATORIVM', '#8a84a0');
    for (const d of desks) drawTaskLabel(d);
    drawUsageProbes(t);
    drawUsageLabels();
    for (const ball of RESOURCE_BALLS.filter(b => b.metric === 'disk')) {
      const label = ball.origin === 'local' ? 'LOC' : 'REM', x = ball.x + 1, y = ball.y + 25;
      drawText(g, x, y, label, '#c8c4dc');
    }
    drawStars(t);
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
    const ball = RESOURCE_BALLS.find(b => mx >= b.x - 1 && mx <= b.x + 14 && my >= b.y - 2 && my <= b.y + (b.metric === 'disk' ? 30 : 24));
    if (ball) return ball.id;
    for (const w of [...wizards.values()].sort((a, b) => b.y - a.y))
      if (Math.abs(mx - w.x) <= 9 && my >= w.y - 26 && my <= w.y + 3) return w.a.id;
    const book = shelfBooks().find(b => mx >= b.x - 1 && mx <= b.x + 2 && my >= b.y - 1 && my <= b.y + 5);
    if (book) return 'book:' + book.i;
    if (mx >= dragon.x - 25 && mx <= dragon.x + 25 && my >= dragon.y - 40 && my <= dragon.y + 3) return 'barista';
    if (demonCat.active && Math.abs(mx - demonCat.x) <= 8 && Math.abs(my - demonCat.y + 4) <= 7) return 'demon-cat';
    if (Math.abs(mx - cat.x) <= 8 && Math.abs(my - cat.y + 4) <= 7) return 'cat';
    if (MTG.game && Math.abs(mx - MTG.x) <= 56 && my >= MTG.y - 68 && my <= MTG.y + 2) return 'mtg';
    return null;
  }
  function hoverRow(id) {
    document.querySelectorAll('#rows .row').forEach(row => row.classList.toggle('hover', row.dataset.id === id));
  }
  function placeTip(html, left, top) {
    const tip = $('#tip'), stage = $('#stage').getBoundingClientRect();
    tip.innerHTML = html;
    tip.hidden = false;
    tip.style.left = Math.max(4, Math.min(left, stage.width - tip.offsetWidth - 4)) + 'px';
    tip.style.top = Math.max(4, Math.min(top, stage.height - tip.offsetHeight - 4)) + 'px';
  }
  const showTip = (w, left, top) => placeTip(tipHTML(w), left, top);
  function showUsageTip(v, left, top) {
    const q = v.q, names = drinkersOf(v).map(a => nameOf(a.id));
    const expirations = q.reset_expirations || [];
    const credits = Array.from({ length: q.resets_left ?? expirations.length }, (_, i) => {
      const expires = expirations[i];
      const label = i >= expirations.length ? 'EXPIRATION UNAVAILABLE' : expires == null ? 'DOES NOT EXPIRE' :
        'EXPIRES ' + new Date(expires * 1000).toLocaleString([], {
          year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        });
      return `<div class="tt-age tt-credit">RESET ${i + 1}: ${esc(label)}</div>`;
    }).join('');
    const status = v.parts ? v.parts.map(part => `<div class="tt-status">${esc(part.model || part.name)}: ${part.left != null ? Math.round(part.left) + '% REMAINING' : 'QUOTA UNAVAILABLE'}</div>
      <div class="tt-age">${esc(part.model || part.name)}: ${part.resets_at ? 'RESETS IN ' + esc(detailedResetIn(part)) : 'RESET TIME UNAVAILABLE'}</div>`).join('') :
      `<div class="tt-status">${q.left != null ? Math.round(q.left) + '% REMAINING' : 'QUOTA UNAVAILABLE'}</div>`;
    placeTip(`<div class="tt-name">${esc(q.name)} <span>${esc((q.provider || 'codex').toUpperCase())}</span></div>
      ${q.origins.length ? `<div class="tt-meta">${esc(q.origins.join(' + ').toUpperCase())}</div>` : ''}
      ${status}
      ${v.parts ? '' : `<div class="tt-age">${q.resets_at ? 'RESETS IN ' + esc(detailedResetIn(q)) : 'RESET TIME UNAVAILABLE'}${q.resets_left === 0 ? '' : ' · ' + (q.resets_left ?? '?') + ' RESET' + (q.resets_left === 1 ? '' : 'S') + ' LEFT'}</div>`}
      ${credits}
      ${names.length ? `<div class="tt-title">DRINKERS: ${esc(names.slice(0, 6).join(', '))}${names.length > 6 ? ` +${names.length - 6}` : ''}</div>` : ''}
      ${q.error ? `<div class="tt-age">${esc(q.error)}</div>` : ''}`, left, top);
  }
  function showResourceTip(ball, left, top) {
    const machine = lastData.resources?.[ball.origin] || {}, value = ballReading(ball);
    const onMachine = o => ball.origin === 'local' ? !o.host : !!machine.host && o.host === machine.host;
    const key = ball.metric === 'memory' ? 'rss' : 'cpu', loads = (lastData.agents || [])
      .filter(a => a.load && onMachine(a) && a.load[key] > 0).sort((x, y) => y.load[key] - x.load[key]).slice(0, 3);
    const strays = (lastData.orphans || []).filter(onMachine);
    const gib = bytes => Math.round(bytes / 2**30) + ' GiB';
    const total = machine[ball.metric + 'Total'], used = machine[ball.metric + 'Used'];
    const name = ball.metric === 'memory' ? 'MEMORY' : ball.metric.toUpperCase();
    placeTip(`<div class="tt-name">${ball.origin.toUpperCase()} ${name}</div>
      <div class="tt-meta">${esc(machine.host || ball.origin)}</div>
      <div class="tt-status">${value == null ? 'USAGE UNAVAILABLE' : Math.round(value) + '% USED'}</div>
      <div class="tt-age">${ball.metric === 'cpu' ? (machine.cores == null ? 'CORE COUNT UNAVAILABLE' : machine.cores + ' LOGICAL CORES') :
        (total == null ? name + ' CAPACITY UNAVAILABLE' :
          (used == null ? '' : gib(used) + ' / ') + gib(total) + (ball.metric === 'memory' ? ' RAM' : ' DISK'))}</div>
      ${ball.metric !== 'disk' && loads.length ? `<div class="tt-title">BIGGEST DRAW: ${loads.map(a => esc(nameOf(a.id)) + ' ' +
        (key === 'cpu' ? Math.round(a.load.cpu) + '%' : gib(a.load.rss))).join(' · ')}</div>` : ''}
      ${ball.metric === 'cpu' && strays.length ? `<div class="tt-quest">${strays.length} STRAY PROCESS${strays.length === 1 ? '' : 'ES'} OUTLIVED ${strays.length === 1 ? 'ITS' : 'THEIR'} AGENT:
        ${strays.slice(0, 3).map(o => `<br>${esc(o.pid)} ${esc(o.cmd)}${o.project ? ' (' + esc(o.project) + ')' : ''}`).join('')}</div>` : ''}`, left, top);
  }
  const nameOf = id => id === 'tower' ? 'THE TOWER' : (wizards.get(id) || { sp: { name: 'A DISTANT AGENT' } }).sp.name;
  function bookHTML(b) {
    const now = Date.now() / 1000 - serverSkew;
    return `<div class="tt-name">${esc(b.title || b.quest || 'UNNAMED QUEST')}</div>
      <div class="tt-meta">${b.engine === 'codex' ? 'CODEX · ' : ''}${b.host ? esc(b.host) + ' · ' : ''}${esc(b.project || '?')}${b.branch ? ' · ' + esc(b.branch) : ''}</div>
      <div class="tt-age">FINISHED ${AGE(now - (b.ended || now))} AGO · ${esc(b.turns || 0)} TURN${b.turns === 1 ? '' : 'S'}${(b.prs || []).map(pr => ` · PR #${esc(pr.number)}${pr.ci ? ' ' + esc(String(pr.ci.state).toUpperCase()) : ''}`).join('')}</div>
      ${b.final ? `<div class="tt-quest">"${esc(b.final.slice(0, 220))}"</div>` : ''}
      <div class="tt-status">CLICK TO COPY THE RESUME COMMAND</div>`;
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
      const ball = RESOURCE_BALLS.find(b => b.id === hover);
      const book = hover && hover.startsWith('book:') && shelfBooks()[+hover.slice(5)];
      if (v) showUsageTip(v, e.clientX - sr.left + 14, e.clientY - sr.top + 10);
      else if (ball) showResourceTip(ball, e.clientX - sr.left + 14, e.clientY - sr.top + 10);
      else if (hover === 'mtg') placeTip(magicTipHTML(), e.clientX - sr.left + 14, e.clientY - sr.top + 10);
      else if (book) placeTip(bookHTML(book.book), e.clientX - sr.left + 14, e.clientY - sr.top + 10);
      else $('#tip').hidden = true;
    }
  });
  cv.addEventListener('mouseleave', () => clearHover());
  function selectWizard(id) {
    sel = id && wizards.has(id) && sel !== id ? id : null;
    renderJournal();
    renderSide();
  }
  async function copyResume(book, x, y) {
    try { await navigator.clipboard.writeText(book.resume); copied = { at: sceneTime, x, y }; } catch { copied = null; }
  }
  cv.addEventListener('click', e => {
    const id = pickAt(e), book = id && id.startsWith('book:') && shelfBooks()[+id.slice(5)];
    if (book) copyResume(book.book, Math.max(50, book.x + 30), book.y - 10);
    else selectWizard(id);
  });

  // ---------- status text ----------
  const VERB = { Bash: 'BREWING', Read: 'READING', Edit: 'INSCRIBING', Write: 'SCRIBING', Grep: 'SCOURING FOR', Glob: 'SCOURING FOR',
    WebFetch: 'SCRYING', WebSearch: 'SCRYING', Task: 'SUMMONING', Agent: 'SUMMONING', Workflow: 'GRAND RITE', Skill: 'INVOKING',
    TodoWrite: 'UPDATING THE QUESTBOOK', LSP: 'DIVINING', ToolSearch: 'RUMMAGING FOR', AskUserQuestion: 'PETITIONING YOU',
    EnterPlanMode: 'PLOTTING', ExitPlanMode: 'PRESENTING A PLAN', KillShell: 'DOUSING A POTION', Monitor: 'WATCHING A POTION',
    exec_command: 'BREWING', exec: 'CHANNELING', write_stdin: 'STIRRING', apply_patch: 'INSCRIBING', update_plan: 'UPDATING THE QUESTBOOK', web_search: 'SCRYING' };
  const SUBMIT_STATUS = { git: 'SUBMITTING WITH GIT', graphite: 'SUBMITTING WITH GRAPHITE', jujutsu: 'SUBMITTING WITH JUJUTSU' };
  const drinkName = d => (d.article === '' ? '' : d.article ? d.article + ' ' : /^(AMERICANO|ESPRESSO)/.test(d.name) ? 'AN ' : 'A ') + d.name;
  const playing = w => { const table = tableById(w && w.game); return table && table.game && 'PLAYING ' + gameName(table.game, w); };
  function cafeStatus(w) {
    if (!w || w.station !== 'cafe') return 'AWAITING YOUR COUNSEL AT THE CAFE';
    if (playing(w)) return playing(w);
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
        if (table && table.game) return 'WAITING OVER ' + gameName(table.game, w);
        if (waitingOnQuestion(a)) return 'AWAITING YOUR ANSWER' + d;
        const pr = (a.prs || []).at(-1);
        if (a.skill === 'pr-watch' && pr) return `WATCHING PR #${pr.number}${pr.ci ? ' (' + String(pr.ci.state).toUpperCase() + ')' : ''}`;
        const submit = submitKind(a);
        if (submit) return SUBMIT_STATUS[submit] + d;
        if (shellTool(a) && ACTS[a.act]) return ACTS[a.act][0] + d;
        if ((a.tool || '').startsWith('mcp__')) return 'FAR-SCRYING' + ': ' + a.tool.slice(5).replace('__', ' / ') + (a.detail ? ' — ' + a.detail : '');
        if (/page|click|snapshot|script|console|chrome|browser|devtools|playwright/.test((a.tool || '').toLowerCase())) return 'FAR-SCRYING: ' + a.tool + (a.detail ? ' — ' + a.detail : '');
        if (waitingOnRun(a)) return 'WAITING FOR A RUN' + d;
        return (VERB[a.tool] || 'CONJURING ' + (a.tool || '?')) + d;
      }
      case 'thinking': return 'PONDERING…';
      case 'responding': return 'COMPOSING A MISSIVE…';
      case 'waiting': return cafeStatus(w);
      case 'attention': return (a.engine === 'codex' ? 'Codex needs your help' : a.msg || 'SEEKS YOUR BLESSING') + ' (!)';
      case 'idle': return playing(w) || 'DOZING BY THE HEARTH…';
      case 'done': return 'QUEST COMPLETE!';
    }
    return a.status;
  }
  const AGE = sIn => { const s = Math.max(0, sIn); return s < 90 ? (s | 0) + 'S' : s < 5400 ? ((s / 60) | 0) + 'M' : ((s / 3600) | 0) + 'H' + (((s % 3600) / 60) | 0) + 'M'; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const base = path => String(path).split('/').pop();
  const tokens = n => n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'K';
  const contextText = a => a.ctx && a.ctx[1] ? `CONTEXT ${Math.round(100 * a.ctx[0] / a.ctx[1])}% (${tokens(a.ctx[0])}/${tokens(a.ctx[1])})` +
    (a.compactions ? ` · ${a.compactions} COMPACTION${a.compactions === 1 ? '' : 'S'}` : '') : '';
  const loadText = a => a.load ? `LOAD ${Math.round(a.load.cpu)}% CPU · ${(a.load.rss / 2**30).toFixed(1)} GB · ${a.load.procs} PROC${a.load.procs === 1 ? '' : 'S'}` : '';
  const prURL = pr => `https://app.graphite.com/github/pr/${pr.repo}/${pr.number}`;
  const prChip = pr => `<a class="chip pr ci-${esc(pr.ci ? pr.ci.state : 'unknown')}" href="${esc(prURL(pr))}" target="_blank" rel="noopener"
    title="${esc(pr.repo)}#${esc(pr.number)}: ${esc(pr.ci ? pr.ci.state + (pr.ci.draft ? ', draft' : '') + (pr.ci.review ? ', ' + pr.ci.review.replace('_', ' ') : '') : 'CI unknown')}">#${esc(pr.number)}</a>`;
  const BAND_COLORS = { b: '#58d878', w: '#ffd84a', i: '#5a5470' };
  function bandStyle(a, now) {
    const span = 3 * 3600, start = now - span, band = a.band || [], at = ts => Math.max(0, Math.min(100, (ts - start) / span * 100)).toFixed(2);
    if (!band.length) return { css: 'none', title: '' };
    const shares = {};
    const stops = band.map(([ts, st], i) => {
      const end = (band[i + 1] || [now])[0];
      shares[st] = (shares[st] || 0) + Math.max(0, end - Math.max(ts, start));
      return `${BAND_COLORS[st] || 'transparent'} ${at(ts)}% ${at(end)}%`;
    });
    const title = 'LAST 3 HOURS: ' + [['b', 'BUSY'], ['w', 'WAITING'], ['i', 'DOZING']].filter(([k]) => shares[k])
      .map(([k, label]) => `${Math.round(100 * shares[k] / span)}% ${label}`).join(', ');
    return { css: `linear-gradient(to right, transparent 0% ${at(band[0][0])}%, ${stops.join(', ')})`, title };
  }

  function tipHTML(w) {
    const a = w.a, now = Date.now() / 1000 - serverSkew;
    const kind = w.sp.demon ? (a.kind === 'sub' ? 'DEMON APPRENTICE · ' : 'DEMON · ') : a.kind === 'sub' ? 'APPRENTICE · ' : '';
    const honor = earned(a), facts = [contextText(a), a.effort && a.effort.toUpperCase() + ' EFFORT', loadText(a)].filter(Boolean);
    return `<div class="tt-name">${esc(w.sp.name)} <span>${esc(epithetOf(w))}</span></div>
      ${honor ? `<div class="tt-age">EARNED: ${esc(honor.why)}</div>` : ''}
      <div class="tt-meta">${a.engine === 'codex' ? 'CODEX · ' : ''}${kind}${a.host ? esc(a.host) + ' · ' : ''}${esc(a.project || '?')}${a.branch ? ' · ' + esc(a.branch) : ''}${a.model ? ' · ' + esc(a.model.replace('claude-', '')) : ''}</div>
      <div class="tt-status st-${a.status}">${esc(statusLine(a, w))}</div>
      ${a.title ? `<div class="tt-title">${esc(a.title)}</div>` : ''}
      ${a.quest ? `<div class="tt-quest">"${esc(a.quest.slice(0, 130))}"</div>` : ''}
      ${(a.clash || []).map(c => `<div class="tt-clash">&#9876; SHARES ${esc(c.paths.map(base).join(', '))} WITH ${esc(nameOf(c.with))}</div>`).join('')}
      ${facts.length ? `<div class="tt-age">${esc(facts.join(' · '))}</div>` : ''}
      <div class="tt-age">IN STATE ${AGE(now - (a.since || now))} · LAST SIGN ${AGE(now - (a.last || now))} AGO</div>`;
  }

  // ---------- sidebar ----------
  const ORDER = { attention: 0, working: 1, thinking: 2, responding: 3, waiting: 4, done: 5, idle: 6 };
  const agentDisplayName = a => (wizards.get(a.id)?.sp.name || a.id || '').toLocaleUpperCase();
  const sortAgents = agents => [...agents].sort((x, y) =>
    (ORDER[x.status] ?? 9) - (ORDER[y.status] ?? 9) ||
    agentDisplayName(x).localeCompare(agentDisplayName(y)) || String(x.id).localeCompare(String(y.id)));
  function journalSummary(a, w) {
    const quest = a.title || a.quest, tools = [...new Set((a.history || []).map(h => h.tool).filter(Boolean))].slice(-4);
    const state = a.status === 'waiting' ? 'Now awaiting your counsel at the café.' :
      a.status === 'done' ? 'The quest is complete.' : a.status === 'idle' ? 'Now resting by the hearth.' :
      `Currently ${statusLine(a, w).toLowerCase()}.`;
    return `${quest ? `Quest: ${quest}. ` : ''}${tools.length ? `Recent craft: ${tools.join(', ')}. ` : ''}${state}`;
  }
  function journalMissives(a) {
    const out = (a.missives || []).map(m => ({ ts: m.ts, missive: true, text: `Sent a missive to ${nameOf(m.to)}: ${m.text}` }));
    for (const o of lastData.agents || []) for (const m of o.missives || [])
      if (m.to === a.id) out.push({ ts: m.ts, missive: true, text: `Missive from ${nameOf(o.id)}: ${m.text}` });
    return [...out, ...(a.inbox || []).map(m => ({ ts: m.ts, missive: true, text: `Missive from ${nameOf(m.from)}: ${m.text}` }))];
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
    const missives = journalMissives(a), links = [...(a.prs || []).map(prChip), ...((a.load && a.load.ports) || []).map(port =>
      `<a class="chip portal" href="http://${esc(a.host || '127.0.0.1')}:${esc(port)}" target="_blank" rel="noopener" title="a server this agent started">:${esc(port)}</a>`)];
    const sig = JSON.stringify([a.id, a.status, a.tool, a.detail, a.title, a.quest, a.project, a.branch, a.chat, history.map(h => h.text),
      a.ctx && Math.round(100 * a.ctx[0] / a.ctx[1]), a.cost, a.effort, a.turns, a.clash, links, missives, earned(a)]);
    if (sig === journalSig && now - journalAt < JOURNAL_STALE && !panel.hidden) return;
    const fresh = journalId !== a.id;
    journalId = a.id;
    const body = $('#journalBody'), keep = fresh ? 0 : panel.scrollTop;  // #journal is the scroller
    const chatBox = $('.j-chat');
    const pinned = fresh || !chatBox || chatBox.scrollTop + chatBox.clientHeight >= chatBox.scrollHeight - 8;
    const chatKeep = chatBox ? chatBox.scrollTop : 0;
    journalSig = sig;
    journalAt = now;
    const stats = [a.model && a.model.replace('claude-', '').toUpperCase(), a.effort && a.effort.toUpperCase() + ' EFFORT', contextText(a),
      a.cost && `+${a.cost.added || 0} −${a.cost.removed || 0}`, a.cost && a.cost.usd != null && '$' + Number(a.cost.usd).toFixed(2),
      a.turns && `${a.turns} TURN${a.turns === 1 ? '' : 'S'}`].filter(Boolean);
    const events = [...history, ...missives].sort((x, y) => y.ts - x.ts), honor = earned(a);
    body.innerHTML = `<div class="j-head">${esc(w.sp.name)}</div>
      <div class="j-ep">${esc(epithetOf(w))}${honor ? ` (${esc(honor.why.toLowerCase())})` : ''} · ${esc(a.project || '?')}${a.branch ? ' · ' + esc(a.branch) : ''}</div>
      ${stats.length ? `<div class="j-stats">${esc(stats.join(' · '))}</div>` : ''}
      ${links.length ? `<div class="j-links">${links.join('')}</div>` : ''}
      ${(a.clash || []).map(c => `<div class="j-clash">&#9876; Also editing ${esc(c.paths.map(base).join(', '))}: ${esc(nameOf(c.with))}</div>`).join('')}
      <div class="j-summary">${esc(journalSummary(a, w))}</div>
      <div class="j-title">COUNSEL &amp; MISSIVES</div>
      ${chatHTML(w, now)}
      <div class="j-title">QUEST HISTORY</div>
      ${events.length ? events.map(h => `<div class="j-event${h.missive ? ' missive' : ''}"><span class="j-time">${AGE(now - h.ts)} AGO</span><span class="j-rune">${h.missive ? '✉' : '◆'}</span><span class="j-text">${esc(h.text)}</span></div>`).join('') :
        '<div class="j-empty">No deeds have reached the chronicle yet.</div>'}`;
    panel.hidden = false;
    panel.scrollTop = keep;
    const box = $('.j-chat');
    if (box) box.scrollTop = pinned ? box.scrollHeight : chatKeep;
  }
  const span = sec => sec < 60 ? Math.round(sec) + 'S' : sec < 3600 ? Math.round(sec / 60) + 'M' : Math.round(sec / 3600) + 'H';
  function medianWait(lat, edges) {
    const n = lat.reduce((x, y) => x + y, 0);
    for (let i = 0, seen = 0; n && i < lat.length; i++) if ((seen += lat[i]) >= n / 2)
      return i === 0 ? 'UNDER ' + span(edges[0]) : i >= edges.length ? 'OVER ' + span(edges.at(-1)) : `${span(edges[i - 1])}–${span(edges[i])}`;
    return '—';
  }
  function renderAnnals() {
    const now = Date.now() / 1000 - serverSkew, days = annals.days || [], books = annals.library || [];
    const most = Math.max(1, ...days.map(d => d.busy));
    $('#annalsBody').innerHTML = `<h2>THE ANNALS</h2>
      <h3>DAILY CHRONICLE</h3>
      ${days.length ? `<table class="chronicle"><tr><th>DAY</th><th>AGENT-HOURS</th><th>TURNS</th><th>PROMPTS</th><th>SESSIONS</th><th>MEDIAN WAIT FOR YOU</th></tr>
        ${days.map(d => `<tr><td>${esc(d.date)}</td><td><i class="bar" style="width:${Math.round(48 * d.busy / most)}px"></i>${(d.busy / 3600).toFixed(1)}</td>
          <td>${d.turns}</td><td>${d.prompts}</td><td>${d.sessions}</td><td>${medianWait(d.lat || [], annals.edges || [])}</td></tr>`).join('')}</table>` :
        '<p class="dim">The chronicle begins with this tower.</p>'}
      <h3>LIBRARY OF FINISHED QUESTS</h3>
      ${books.length ? books.map((b, i) => `<div class="book">
          <div class="b-title">${esc(b.title || b.quest || 'UNNAMED QUEST')}</div>
          <div class="b-meta">${b.engine === 'codex' ? 'CODEX · ' : ''}${b.host ? esc(b.host) + ' · ' : ''}${esc(b.project || '?')}${b.branch ? ' · ' + esc(b.branch) : ''} · FINISHED ${AGE(now - (b.ended || now))} AGO · ${esc(b.turns || 0)} TURN${b.turns === 1 ? '' : 'S'} ${(b.prs || []).map(prChip).join('')}</div>
          ${b.final ? `<div class="b-final">${esc(b.final)}</div>` : ''}
          <button class="pixbtn b-copy" data-i="${i}" title="${esc(b.resume)}">COPY RESUME COMMAND</button></div>`).join('') :
        '<p class="dim">Sessions are shelved here when they leave the tower.</p>'}`;
    $('#annalsBody').querySelectorAll('.b-copy').forEach(button => {
      button.onclick = async () => {
        try { await navigator.clipboard.writeText(books[+button.dataset.i].resume); button.textContent = 'COPIED'; }
        catch { button.textContent = 'COPY FAILED'; }
      };
    });
  }
  function renderSide() {
    const now = Date.now() / 1000 - serverSkew;
    const ags = sortAgents(lastData.agents);
    $('#num').textContent = ags.length || '';
    $('#rows').innerHTML = ags.map(a => {
      const w = wizards.get(a.id);
      if (!w) return '';
      const task = esc(a.title || a.quest || a.project || 'UNNAMED QUEST'), band = bandStyle(a, now);
      const left = a.ctx && a.ctx[1] ? Math.max(0, 1 - a.ctx[0] / a.ctx[1]) : null;
      const clashes = (a.clash || []).map(c => `<span class="chip clash" title="${esc('Shares ' + c.paths.map(base).join(', '))}">&#9876; ${esc(nameOf(c.with))}</span>`);
      return `<div class="row st-${a.status} ${sel === a.id ? 'sel' : ''} ${hover === a.id ? 'hover' : ''} ${a.kind}" data-id="${esc(a.id)}">
        <div class="ptw"><img class="pt" src="${w.sp.portrait}" alt="">${left == null ? '' :
          `<i class="mana ${left < .15 ? 'low' : left < .5 ? 'mid' : ''}" style="width:${Math.round(left * 34)}px" title="${esc(contextText(a))}"></i>`}</div>
        <div class="mid">
          <div class="task" title="${task}">${task}</div>
          <div class="ln">${esc(statusLine(a, w))}</div>
          <div class="nm">${a.kind === 'sub' ? '<span class="sub-arrow">&#8627;</span> ' : ''}${esc(w.sp.name)} <span class="ep">${esc(epithetOf(w))}</span></div>
          <div class="ch"><span class="chip">${esc(a.project || '?')}</span>${a.host ? `<span class="chip alt">${esc(a.host)}</span>` : ''}${a.engine === 'codex' ? '<span class="chip cdx">codex</span>' : ''}${(a.prs || []).slice(-2).map(prChip).join('')}${clashes.join('')}${a.branch ? `<span class="chip alt">${esc(a.branch)}</span>` : ''}<span class="time">${AGE(now - (a.since || now))}</span></div>
          ${band.title ? `<div class="band" style="background:${band.css}" title="${esc(band.title)}"></div>` : ''}
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
      el.querySelectorAll('a').forEach(link => { link.onclick = e => e.stopPropagation(); });
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
  const timerWindow = $('#timerWindow'), timerBody = $('#timerBody');
  const dismissedPrompts = new Set();
  let shownPrompts = new Set();
  function renderTimerPrompts(prompts) {
    const available = prompts.filter(p => p.fact && !dismissedPrompts.has(`${p.id}:${p.fact}`));
    const next = new Set(available.map(p => `${p.id}:${p.fact}`));
    if (!available.length) { timerWindow.hidden = true; shownPrompts = next; return; }
    if ([...next].some(key => !shownPrompts.has(key))) {
      timerBody.replaceChildren();
      for (const prompt of available) {
        const reply = document.createElement('div');
        reply.className = 'timerReply';
        const name = document.createElement('div');
        name.className = 'timerName';
        name.textContent = `${prompt.name} · ${prompt.provider === 'claude' ? 'OPUS LOW' : 'SOL LOW'}`;
        const fact = document.createElement('div');
        fact.className = 'timerFact';
        fact.textContent = prompt.fact;
        reply.append(name, fact);
        timerBody.append(reply);
      }
      timerWindow.hidden = false;
    }
    shownPrompts = next;
  }
  $('#timerClose').onclick = () => {
    for (const key of shownPrompts) dismissedPrompts.add(key);
    timerWindow.hidden = true;
  };
  $('#timerTitle').addEventListener('pointerdown', e => {
    if (e.target.id === 'timerClose') return;
    const bounds = timerWindow.getBoundingClientRect();
    const stage = $('#stage').getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const left = bounds.left - stage.left, top = bounds.top - stage.top;
    const title = e.currentTarget;
    title.setPointerCapture(e.pointerId);
    title.onpointermove = move => {
      timerWindow.style.left = `${Math.max(0, Math.min(stage.width - bounds.width, left + move.clientX - startX))}px`;
      timerWindow.style.top = `${Math.max(0, Math.min(stage.height - bounds.height, top + move.clientY - startY))}px`;
    };
    title.onpointerup = title.onpointercancel = () => { title.onpointermove = null; };
  });
  async function poll() {
    try {
      const res = await fetch('/api/state');
      lastData = await res.json();
      serverSkew = Date.now() / 1000 - lastData.now;
      isDemo = lastData.demo;
      offline = false;
      reconcile(lastData);
      assignBottles();
      launchMissives(lastData);
      if (lastData.annals !== annalsStamp) { annalsStamp = lastData.annals; fetchAnnals(); }
      renderSide();
      renderJournal();
      renderTimerPrompts(lastData.timerPrompts || []);
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
  $('#annalsBtn').onclick = () => {
    $('#annals').hidden = !$('#annals').hidden;
    if (!$('#annals').hidden) { renderAnnals(); fetchAnnals(); }
  };
  $('#annals').onclick = e => { if (e.target.id === 'annals' || e.target.id === 'annalsClose') $('#annals').hidden = true; };
  $('#journalClose').onclick = () => selectWizard(sel);
  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#annals').hidden) $('#annals').hidden = true;
    else if (sel) selectWizard(sel);
  });
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js?v=2');

  // ---------- main loop ----------
  // Pixel animation needs 30fps; hidden windows only advance the simulation.
  const FRAME_MS = 1000 / 30;
  let last = performance.now(), simT = 0, lastFrame = 0;
  function tick(ms) {
    let gap = Math.min(3, (ms - last) / 1000);
    last = ms;
    while (gap > 0) { const d = Math.min(.1, gap); simT += d; update(d, simT); gap -= d; }
  }
  function frame(ms) {
    requestAnimationFrame(frame);
    if (document.hidden || ms - lastFrame < FRAME_MS) return;
    lastFrame = ms - (ms - lastFrame) % FRAME_MS;
    tick(ms);
    draw(simT);
  }
  setInterval(() => { const n = performance.now(); if (n - last > 450) tick(n); }, 300);
  resize();
  catThink(0);
  poll();
  requestAnimationFrame(frame);
  window.WF = { wizards, ST, cat, demonCat, dragon, SPELLS, TABLES, BIRDS };
})();
