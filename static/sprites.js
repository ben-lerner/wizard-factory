// sprites.js — seeded pixel art: font, names, wizards, props, emotes. Exposes window.SP.
'use strict';
window.SP = (() => {
  // ---------- prng ----------
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = seed => { let a = seed || 1; return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
  const pick = (r, arr) => arr[r() * arr.length | 0];

  // ---------- colors ----------
  const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  const hsl = (h, s, l) => { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); return hex(f(0) * 255, f(8) * 255, f(4) * 255); };
  const shade = (c, f) => hex(parseInt(c.slice(1, 3), 16) * f, parseInt(c.slice(3, 5), 16) * f, parseInt(c.slice(5, 7), 16) * f);

  // ---------- 3x5 pixel font ----------
  const F = {
    A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
    F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
    K: '101110100110101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
    P: '110101110100100', Q: '010101101110011', R: '110101110110101', S: '011100010001110', T: '111010010010010',
    U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
    Z: '111001010100111', '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
    '4': '101101111001001', '5': '111100110001110', '6': '011100110101010', '7': '111001010010010', '8': '111101111101111',
    '9': '111101111001110', ' ': '000000000000000', '!': '010010010000010', '?': '110001010000010', '.': '000000000000010',
    ',': '000000000010100', ':': '000010000010000', '-': '000000111000000', "'": '010010000000000', '+': '000010111010000',
    '/': '001001010100100', '(': '001010010010001', ')': '100010010010100', '*': '000101010101000', '…': '000000000000101',
  };
  const drawText = (ctx, x, y, str, color, s = 1) => {
    ctx.fillStyle = color;
    let cx = x;
    for (const ch of String(str).toUpperCase()) {
      const g = F[ch] || F['?'];
      for (let i = 0; i < 15; i++) if (g[i] === '1') ctx.fillRect(cx + (i % 3) * s, y + ((i / 3) | 0) * s, s, s);
      cx += 4 * s;
    }
  };
  const textW = (str, s = 1) => [...String(str)].length * 4 * s - s;

  // ---------- names ----------
  const N1 = ['AL', 'BEL', 'COR', 'DAG', 'ELD', 'FEN', 'GAL', 'HOB', 'IGN', 'JAS', 'KEL', 'LOR', 'MAG', 'NIM', 'ORM', 'PYR', 'QUIL', 'RAV', 'SOR', 'THAM', 'ULM', 'VOR', 'WEN', 'XAN', 'YBB', 'ZEPH'];
  const N2 = ['A', 'E', 'I', 'O', 'U', 'AR', 'EN', 'IL', 'OR', 'UM', 'ARA', 'IBO', 'ODO', 'UMI'];
  const N3 = ['BART', 'BERT', 'DOR', 'DRIC', 'FIUS', 'GAST', 'GRIM', 'LIN', 'LOCK', 'MIRE', 'MUND', 'NOR', 'RICK', 'STAR', 'THORN', 'WICK', 'WIN', 'WYN', 'ZAR', 'CASTER', 'MANCER'];
  const EPITHETS = ['THE WISE', 'THE PATIENT', 'THE UNTESTED', 'BUGBANE', 'THE RECURSIVE', 'TOKENWEAVER', 'THE PARALLEL', 'NULLSEEKER', 'THE VERBOSE', 'MERGEWRIGHT', 'LINTBANE', 'THE ASYNC', 'OOMSLAYER', 'THE IDEMPOTENT', 'SHIPWRIGHT', 'THE CACHED', 'DAEMONFRIEND', 'THE WELL-TYPED', 'THE REBASED', 'OF THE LONG BUILD', 'QUERYBINDER', 'THE PROFILED', 'FLAKEBANE', 'THE VECTORIZED', 'HOTFIX', 'THE GREPWORN', 'OF THE NINTH STACK', 'SEGFAULTSBANE', 'THE PROMPTSMITH', 'THE BRANCHWALKER', 'CACHEKEEPER', 'THE SMALL DIFF', 'OF THE CLEAN TREE', 'THE EDGECASE', 'THE UNBLOCKER', 'THE NIGHTLY', 'THE SHARDMENDER', 'THE QUIET FIXER', 'THE LAST RESORT', 'OF THE HIDDEN TOKEN', 'THE POLYMATH', 'THE THREADWEAVER', 'THE QUOTAKEEPER', 'THE LATENT', 'THE BOUNDARY RIDER'];
  const APPRENTICE_EPITHETS = ['THE EAGER', 'THE QUICK', 'THE BRIGHT-EYED', 'THE UNLICENSED', 'THE SECOND PAIR OF HANDS', 'THE SPELLING BEE', 'THE JUNIOR ARCANIST', 'THE TINY TINKER', 'THE NOTE-TAKER'];
  const INFERNAL_EPITHETS = ['OF THE INFERNAL STACK', 'THE ASHEN RECURSOR', 'THE BRIMSTONE BUILDER', 'THE FORKED TONGUE', 'KEEPER OF THE HOTFIX', 'THE RED TEAM', 'OF THE LAST RESORT'];
  const APPRENTICE = ['PIP', 'WICK', 'NIB', 'TWIG', 'MOTE', 'FIG', 'DOT', 'BRAN', 'COG', 'LUMEN', 'SPECK', 'WISP', 'FERN', 'SOOT', 'PEBBLE', 'QUILL', 'MOSS', 'FLINT', 'BEAN', 'SPROUT', 'INKY', 'PATCH'];
  const DRINKS = [
    { key: 'drip', name: 'DRIP COFFEE', milk: false },
    { key: 'pourover', name: 'POUROVER', milk: false },
    { key: 'americano', name: 'AMERICANO', milk: false },
    { key: 'long-black', name: 'LONG BLACK', milk: false },
    { key: 'espresso', name: 'ESPRESSO', milk: false },
    { key: 'double-espresso', name: 'DOUBLE ESPRESSO', milk: false },
    { key: 'macchiato', name: 'MACCHIATO', milk: true },
    { key: 'cortado', name: 'CORTADO', milk: true },
    { key: 'flat-white', name: 'FLAT WHITE', milk: true },
    { key: 'cappuccino', name: 'CAPPUCCINO', milk: true },
    { key: 'latte', name: 'LATTE', milk: true },
    { key: 'cafe-au-lait', name: 'CAFE AU LAIT', milk: true },
    { key: 'mana-potion', name: 'MANA POTION', milk: false, potion: '#5aa9e6' },
    { key: 'health-potion', name: 'HEALTH POTION', milk: false, potion: '#d84a4a' },
    { key: 'antimatter', name: 'ANTIMATTER', milk: false, article: '' },
  ];
  const INFERNAL_DRINKS = [
    { key: 'hellfire-shot', name: 'HELLFIRE SHOT', milk: false, potion: '#f05a3a' },
    { key: 'molten-brimstone', name: 'MOLTEN BRIMSTONE', milk: false, potion: '#f08a2a' },
    { key: 'void-latte', name: 'VOID LATTE', milk: true, potion: '#8a4fc8' },
    { key: 'soul-cold-brew', name: 'SOUL COLD BREW', milk: false, potion: '#4fc8c0' },
  ];
  const WARM_MILK = { key: 'warm-milk', name: 'WARM MILK', milk: true };
  const drinkFor = (id, demon = false) => {
    const menu = demon ? INFERNAL_DRINKS : DRINKS;
    return menu[hash(id + ':drink') % menu.length];
  };
  const drinkByKey = key => key === WARM_MILK.key ? WARM_MILK : [...DRINKS, ...INFERNAL_DRINKS].find(d => d.key === key) || DRINKS[0];

  // ---------- wizard sprite ----------
  const SKINS = ['#f0c8a0', '#e6b88e', '#cf9a66', '#b07845', '#8a5a32', '#6b4226'];
  const BEARDS = ['#f4f4f4', '#d8d8d8', '#b8bcc8', '#9c6b3d', '#c8803c', '#494949'];

  function paintWizard(ctx, o, mode) {
    const P = (x, y, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); };
    const R = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
    const sleeping = mode.startsWith('sleep');
    const b = (o.sub ? 2 : 0) + ((mode === 'idleB' || mode === 'walkB' || mode === 'sleepB') ? 1 : 0);
    const cx = 10;
    // robe
    R(cx - 4, 12 + b, 8, 3, o.robe); R(cx - 5, 15 + b, 10, 4, o.robe); R(cx - 6, 19 + b, 12, Math.max(1, 23 - (19 + b)), o.robe);
    R(cx + 2, 12 + b, 2, 3, o.robeD); R(cx + 3, 15 + b, 2, 4, o.robeD); R(cx + 4, 19 + b, 2, Math.max(1, 23 - (19 + b)), o.robeD);
    R(cx - 4, 16 + b, 8, 1, o.trim);                       // belt
    R(cx - 6, Math.min(22, 21 + b), 12, 1, o.trim);        // hem
    R(cx - 6, 13 + b, 1, 4, o.robeD); R(cx + 5, 13 + b, 1, 4, o.robeD);  // sleeves
    P(cx - 6, 17 + b, o.skin); P(cx + 5, 17 + b, o.skin);  // hands
    // feet (fixed to ground)
    const feet = mode === 'walkA' ? [-4, 2] : mode === 'walkB' ? [-2, 0] : [-3, 1];
    R(cx + feet[0], 22, 2, 2, '#241a2e'); R(cx + feet[1], 22, 2, 2, '#241a2e');
    // head
    R(cx - 3, 5 + b, 6, 6, o.skin); R(cx + 2, 5 + b, 1, 6, o.skinD);
    if (sleeping) { R(cx - 3, 9 + b, 2, 1, '#1c1430'); R(cx + 1, 9 + b, 2, 1, '#1c1430'); }
    else { P(cx - 2, 8 + b, '#1c1430'); P(cx + 1, 8 + b, '#1c1430'); }
    // beard
    const bc = o.beardC, bh = shade(bc, 1.2);
    if (o.beardType === 'stache') { R(cx - 3, 10 + b, 2, 1, bc); R(cx + 1, 10 + b, 2, 1, bc); P(cx, 11 + b, bc); }
    else if (o.beardType === 'short') {
      R(cx - 3, 10 + b, 2, 1, bc); R(cx + 1, 10 + b, 2, 1, bc);
      R(cx - 3, 11 + b, 6, 1, bc); R(cx - 2, 12 + b, 4, 2, bc); R(cx - 1, 14 + b, 2, 1, bc); P(cx - 1, 12 + b, bh);
    } else if (o.beardType === 'long') {
      R(cx - 3, 10 + b, 2, 1, bc); R(cx + 1, 10 + b, 2, 1, bc);
      R(cx - 3, 11 + b, 6, 1, bc); R(cx - 2, 12 + b, 5, 2, bc); R(cx - 2, 14 + b, 4, 2, bc); R(cx - 1, 16 + b, 2, 2, bc);
      P(cx - 1, 12 + b, bh); P(cx, 15 + b, bh);
    } else if (o.beardType === 'forked') {
      R(cx - 3, 10 + b, 2, 1, bc); R(cx + 1, 10 + b, 2, 1, bc);
      R(cx - 3, 11 + b, 6, 1, bc); R(cx - 2, 12 + b, 2, 2, bc); R(cx + 1, 12 + b, 2, 2, bc); R(cx - 2, 14 + b, 1, 3, bc); R(cx + 2, 14 + b, 1, 3, bc);
      P(cx - 1, 12 + b, bh); P(cx + 1, 12 + b, bh);
    }
    // hat
    const H = o.hat, HD = o.hatD;
    if (o.hatType === 'pointy') {
      R(cx - 5, 6 + b, 10, 1, HD); R(cx - 3, 5 + b, 6, 1, o.trim);
      R(cx - 3, 3 + b, 6, 2, H); R(cx - 2, 1 + b, 4, 2, H); R(cx, 0 + b, 2, 1, H); P(cx + 1, 0 + b, HD); P(cx + 2, 3 + b, HD);
    } else if (o.hatType === 'bent') {
      R(cx - 5, 6 + b, 10, 1, HD); R(cx - 3, 5 + b, 6, 1, o.trim);
      R(cx - 3, 3 + b, 6, 2, H); R(cx - 2, 2 + b, 4, 1, H); R(cx, 1 + b, 3, 1, H); P(cx + 3, 2 + b, H); P(cx + 4, 3 + b, HD);
    } else if (o.hatType === 'wide') {
      R(cx - 7, 6 + b, 14, 1, HD); R(cx - 3, 5 + b, 6, 1, o.trim);
      R(cx - 2, 3 + b, 4, 2, H); R(cx - 1, 2 + b, 2, 1, H); P(cx, 1 + b, H);
    } else if (o.hatType === 'hood') {
      R(cx - 4, 3 + b, 8, 2, H); R(cx - 4, 5 + b, 1, 6, H); R(cx + 3, 5 + b, 1, 6, HD); R(cx - 5, 11 + b, 10, 1, H);
    } else if (o.hatType === 'cap') {
      R(cx - 2, 3 + b, 4, 1, H); R(cx - 3, 4 + b, 6, 1, H); R(cx - 3, 5 + b, 6, 1, o.trim);
    } else { // bare: hair
      R(cx - 3, 4 + b, 6, 1, bc); P(cx - 4, 5 + b, bc); P(cx - 4, 6 + b, bc); P(cx + 3, 5 + b, bc); P(cx + 3, 6 + b, bc);
    }
    if (o.demon) {
      P(cx - 4, 3 + b, '#ece3c4'); P(cx - 5, 2 + b, '#ece3c4');
      P(cx + 3, 3 + b, '#ece3c4'); P(cx + 4, 2 + b, '#ece3c4');
    }
    if (o.decal && (o.hatType === 'pointy' || o.hatType === 'bent' || o.hatType === 'wide')) {
      if (o.decal === 'star') { P(cx - 1, 3 + b, '#ffe89a'); P(cx, 4 + b, '#ffe89a'); }
      else { P(cx, 3 + b, '#ffe89a'); P(cx - 1, 4 + b, '#ffe89a'); }
    }
    // accessory
    if (o.acc === 'staff') { R(16, 6 + b, 1, 17 - b, '#8a5a32'); P(16, 11 + b, '#6b4226'); R(15, 4 + b, 2, 2, o.trim); P(15, 4 + b, '#ffffff'); }
    else if (o.acc === 'wand') { P(15, 15 + b, '#8a5a32'); P(16, 14 + b, '#8a5a32'); P(17, 13 + b, o.trim); }
    else if (o.acc === 'tome') { R(2, 14 + b, 4, 4, o.accC); R(5, 14 + b, 1, 4, '#efe6c8'); P(3, 16 + b, o.trim); }
  }

  const CODEX_EPITHETS = ['OF THE CODEX ORDER', 'THE VISITING SCHOLAR', 'OF THE FOREIGN GUILD', 'THE GUEST ARTIFICER', 'THE EMISSARY', 'THE MODEL-SMITH', 'THE TOKEN DIPLOMAT', 'OF THE OPENAI ARCHIVE', 'THE REMOTE ADEPT'];

  function makeWizard(id, kind, engine, demon) {
    const r = rng(hash(id));
    const sub = kind === 'sub', codex = engine === 'codex';
    const hue = (r() * 360) | 0;
    const robe = hsl(hue, 42, 40), robeD = hsl(hue, 44, 28);
    const trim = pick(r, ['#e8c04a', '#d8def0', hsl((hue + 150) % 360, 55, 62), '#e8c04a']);
    const hatHue = r() < .3 ? (r() * 360) | 0 : hue;
    const o = {
      sub, robe, robeD, trim,
      hat: hsl(hatHue, 48, 36), hatD: hsl(hatHue, 48, 24),
      skin: pick(r, SKINS), beardC: pick(r, BEARDS),
      hatType: demon ? 'bare' : codex ? 'hood' : sub ? pick(r, ['cap', 'bare', 'pointy', 'cap']) : pick(r, ['pointy', 'pointy', 'pointy', 'bent', 'wide', 'hood', 'bare']),
      beardType: sub ? 'none' : pick(r, ['long', 'long', 'short', 'short', 'forked', 'stache', 'none']),
      acc: pick(r, sub ? ['none', 'tome', 'wand', 'none'] : ['staff', 'staff', 'wand', 'tome', 'none']),
      accC: hsl((hue + 90) % 360, 45, 45),
    };
    r(); // preserve seeded appearances after retiring glasses
    o.decal = r() < .5 ? (r() < .5 ? 'star' : 'moon') : null;
    if (demon) Object.assign(o, { demon, skin: '#b84a48', beardC: '#241622', robe: '#542238', robeD: '#321424', trim: '#f08a2a' });
    o.skinD = shade(o.skin, .82);
    let name = sub ? (demon ? 'DEMON ' : 'APPRENTICE ') + pick(r, APPRENTICE) : pick(r, N1) + pick(r, N2) + pick(r, N3);
    for (let i = 0; !sub && name.length > 11 && i < 4; i++) name = pick(r, N1) + pick(r, N2) + pick(r, N3);
    const epithet = demon ? pick(r, INFERNAL_EPITHETS) : codex ? pick(r, CODEX_EPITHETS) : sub ? pick(r, APPRENTICE_EPITHETS) : pick(r, EPITHETS);
    const frames = {};
    for (const m of ['idleA', 'idleB', 'walkA', 'walkB', 'sleepA', 'sleepB']) {
      const c = document.createElement('canvas'); c.width = 20; c.height = 24;
      paintWizard(c.getContext('2d'), o, m);
      frames[m] = c;
    }
    const pc = document.createElement('canvas'); pc.width = 42; pc.height = 42;
    const pg = pc.getContext('2d'); pg.imageSmoothingEnabled = false;
    pg.drawImage(frames.idleA, 3, sub ? 1 : 0, 14, 14, 0, 0, 42, 42);
    return { name, epithet, frames, portrait: pc.toDataURL(), hue, sub, demon, drink: drinkFor(id, demon) };
  }

  // ---------- the staff cat ----------
  function makeCat(demon = false) {
    const frames = {};
    for (const m of ['sitA', 'sitB', 'walkA', 'walkB', 'sleep']) {
      const c = document.createElement('canvas'); c.width = 14; c.height = 10;
      const g = c.getContext('2d');
      const P = (x, y, col) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };
      const R = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
      const B = demon ? '#713650' : '#cf8a3e', S = demon ? '#3b1930' : '#a8632a', E = demon ? '#f08a2a' : '#3fae5a';
      if (m === 'sleep') {
        R(3, 5, 9, 4, B); R(4, 4, 6, 1, B); P(5, 5, S); P(8, 6, S); P(10, 5, S);
        R(11, 4, 2, 2, B); P(2, 6, B); P(1, 5, B);
      } else {
        R(3, 4, 7, 4, B); P(5, 4, S); P(8, 5, S);
        R(9, 1, 4, 4, B); P(9, 0, B); P(12, 0, B);                       // head+ears
        P(10, 2, m === 'sitB' ? S : E); P(12, 2, m === 'sitB' ? S : E);
        if (demon) { P(9, 0, '#ece3c4'); P(8, 0, '#ece3c4'); P(12, 0, '#ece3c4'); P(13, 0, '#ece3c4'); }
        if (m.startsWith('walk')) { const l = m === 'walkA' ? [3, 8] : [5, 6]; P(l[0], 8, S); P(l[1] + 3, 8, S); }
        else { R(3, 8, 2, 1, S); R(8, 8, 2, 1, S); }
        if (m === 'walkB' || m === 'sitB') { P(2, 3, B); P(1, 2, B); } else { P(2, 4, B); P(1, 4, B); P(1, 3, B); }
      }
      frames[m] = c;
    }
    return frames;
  }

  // ---------- the barista dragon ----------
  function makeDragon() {
    const B = '#3f9b5e', D = '#2e7a46', BEL = '#d8e8b0', HORN = '#ece3c4', LIT = '#4fb87a';
    const body = (g, ox, oy, alt, roast, folded) => {
      const P = (x, y, col) => { g.fillStyle = col; g.fillRect(x + ox, y + oy, 1, 1); };
      const R = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x + ox, y + oy, w, h); };
      const ty = alt ? 1 : 0;
      R(21, 15, 3, 2, B); R(23, 13 + ty, 3, 2, B); R(25, 12 + ty, 2, 2, B);                   // tail
      P(27, 11 + ty, B); P(27, 10 + ty, HORN); P(28, 11 + ty, HORN);
      R(12, 11, 8, 1, B); R(10, 12, 12, 1, B); R(9, 13, 13, 8, B); R(10, 21, 11, 1, B);       // body
      R(18, 13, 4, 8, D);
      R(9, 14, 4, 7, BEL); R(10, 13, 3, 1, BEL);                                              // belly
      R(11, 22, 3, 3, B); R(17, 22, 3, 3, D); P(10, 24, HORN); P(16, 24, HORN);               // legs
      if (folded) {                                                                           // wing at rest
        const wv = (alt && !roast) ? 1 : 0;
        R(15, 11 - wv, 5, 3, D); R(16, 9 - wv, 4, 2, D); R(17, 7 - wv, 3, 2, D); R(18, 6 - wv, 2, 1, D);
        P(18, 5 - wv, HORN);
        P(17, 6 - wv, LIT); P(16, 8 - wv, LIT); P(15, 10 - wv, LIT); P(14, 12 - wv, LIT);     // wing-bone ridge
      }
      P(12, 10, HORN);                                                                        // spine nub
      const hy = roast ? 2 : 0;                                                               // neck + head
      R(8, 7 + hy, 3, 2, B); R(7, 8 + hy, 4, 4, B);
      R(4, 3 + hy, 6, 5, B); R(0, 5 + hy, 5, 2, B);
      P(8, 3 + hy, D); P(9, 4 + hy, D);
      if (roast) {
        R(1, 7 + hy, 3, 2, '#7a1f1f'); P(2, 7 + hy, '#f0a83c');                               // glowing maw
        R(1, 9 + hy, 4, 1, B);                                                                // open jaw
      } else {
        R(1, 7, 4, 1, B); P(0, 6, '#1c1430');                                                 // chin + nostril
      }
      P(4, 4 + hy, '#1c1430'); P(5, 4 + hy, '#ffd84a');                                       // eye
      P(6, 1 + hy, HORN); P(7, 2 + hy, HORN); P(9, 1 + hy, HORN); P(10, 2 + hy, HORN);        // horns
    };
    const wing = (g, up, flip) => {  // spread wing on the 44-wide flap canvas; flip mirrors it
      const R = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(flip ? 44 - x - w : x, y, w, h); };
      if (up) {
        R(8, 3, 3, 1, D); R(7, 4, 5, 2, D); R(8, 6, 6, 2, D); R(10, 8, 6, 2, D); R(12, 10, 6, 2, D); R(14, 12, 6, 3, D);
        R(7, 2, 1, 1, HORN);
        R(9, 4, 1, 1, LIT); R(11, 6, 1, 1, LIT); R(13, 8, 1, 1, LIT); R(15, 10, 1, 1, LIT);
      } else {
        R(2, 12, 4, 1, D); R(1, 13, 6, 2, D); R(3, 15, 8, 2, D); R(8, 17, 9, 2, D);
        R(1, 11, 1, 1, HORN);
        R(4, 13, 1, 1, LIT); R(7, 15, 1, 1, LIT); R(11, 17, 1, 1, LIT);
      }
    };
    const frames = {};
    for (const m of ['idleA', 'idleB', 'roastA', 'roastB']) {
      const c = document.createElement('canvas'); c.width = 30; c.height = 26;
      body(c.getContext('2d'), 0, 0, m.endsWith('B'), m.startsWith('roast'), true);
      frames[m] = c;
    }
    for (const m of ['flapA', 'flapB']) {
      const c = document.createElement('canvas'); c.width = 44; c.height = 30;
      const g = c.getContext('2d'), up = m === 'flapA';
      wing(g, up, false); wing(g, up, true);
      body(g, 7, 4, up, false, false);
      frames[m] = c;
    }
    const c = document.createElement('canvas'); c.width = 30; c.height = 26;
    const g = c.getContext('2d'), R = (x, y, w, h, color) => { g.fillStyle = color; g.fillRect(x, y, w, h); };
    R(7, 14, 16, 7, B); R(10, 12, 10, 3, D); R(17, 9, 4, 4, D); R(20, 7, 2, 3, HORN);
    R(4, 16, 6, 5, B); R(1, 18, 5, 3, B); R(2, 17, 1, 1, HORN); R(5, 18, 3, 1, '#1c1430');
    R(21, 18, 6, 3, B); R(25, 16, 3, 2, B); R(27, 14, 2, 2, HORN); R(9, 21, 4, 2, BEL);
    frames.sleep = c;
    return frames;
  }

  // ---------- props ----------
  const PR = {};
  const px = (g, x, y, c) => { g.fillStyle = c; g.fillRect(x, y, 1, 1); };
  const rc = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

  PR.cauldron = (g, x, y, t, brew) => {
    const p = Math.max(0, Math.min(1, (t - brew.changed) / 2));
    const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    const a = rgb(brew.from), b = rgb(brew.color), color = hex(...a.map((v, i) => v + (b[i] - v) * p));
    const active = t < brew.fire;
    if (t - brew.strike >= 0 && t - brew.strike < .65) {
      g.save(); g.globalAlpha = 1 - (t - brew.strike) / .65;
      g.strokeStyle = brew.color; g.lineWidth = 2; g.beginPath();
      [[x + 6, y - 35], [x + 17, y - 25], [x + 10, y - 17], [x + 20, y - 10], [x + 14, y + 6]].forEach(([bx, by], i) => i ? g.lineTo(bx, by) : g.moveTo(bx, by));
      g.stroke(); g.restore();
    }
    rc(g, x + 6, y + 19, 3, 3, '#23272f'); rc(g, x + 19, y + 19, 3, 3, '#23272f');
    if (active) {
      const f = (t * 7 | 0) % 2;
      [[10, 19], [13, 18 + f], [17, 19 - f], [11, 20], [15, 20]].forEach(([dx, dy]) => px(g, x + dx, y + dy, color));
      [[12, 19 + f], [14, 20]].forEach(([dx, dy]) => px(g, x + dx, y + dy, '#ffd84a'));
    }
    rc(g, x + 5, y + 8, 18, 1, '#3d4356');
    rc(g, x + 3, y + 9, 22, 6, '#444c62');
    rc(g, x + 5, y + 15, 18, 2, '#3a4154'); rc(g, x + 7, y + 17, 14, 2, '#30364a'); rc(g, x + 9, y + 19, 10, 1, '#282d3e');
    rc(g, x + 21, y + 9, 3, 6, '#333a4e');
    rc(g, x + 5, y + 10, 2, 4, '#677292'); px(g, x + 7, y + 10, '#677292');
    rc(g, x + 2, y + 5, 24, 3, '#525c7a'); rc(g, x + 2, y + 5, 24, 1, '#6c7796'); rc(g, x + 23, y + 5, 3, 3, '#414a62');
    rc(g, x + 4, y + 6, 20, 1, color);
    px(g, x + 7 + ((t * 3 | 0) % 3) * 5, y + 6, '#ecffe2');
    if (active) for (let i = 0; i < 5; i++) {
      const h = 4 + Math.round((Math.sin(t * 10 + i * 3) + 1) * 4);
      rc(g, x + 5 + i * 4, y + 5 - h, 3, h, color);
      rc(g, x + 6 + i * 4, y + 8 - h, 1, Math.max(1, h - 4), '#fff1cd');
    }
  };

  PR.bench = (g, x, y, t) => {
    rc(g, x, y + 6, 34, 4, '#7d5636'); rc(g, x, y + 10, 34, 7, '#6e4a2f'); rc(g, x, y + 10, 34, 1, '#8a6242');
    rc(g, x + 2, y + 17, 3, 3, '#4a3220'); rc(g, x + 29, y + 17, 3, 3, '#4a3220');
    rc(g, x + 6, y + 1, 3, 5, '#58d878'); px(g, x + 7, y, '#58d878');
    rc(g, x + 15, y + 3, 3, 3, '#5aa9e6'); px(g, x + 16, y + 2, '#9cc8e8');
    px(g, x + 26, y + 2, '#d86ad8'); rc(g, x + 25, y + 3, 3, 3, '#d86ad8');
    if ((t * 4 | 0) % 2) px(g, x + 7, y - 2, '#a8f0b0');
  };

  PR.shelf = (g, x, y, seed) => {
    const r = rng(seed);
    rc(g, x, y, 24, 31, '#5a3c26'); rc(g, x + 2, y + 2, 20, 27, '#2c2014');
    const cols = ['#a84848', '#4878a8', '#48a868', '#a8a848', '#8858a8', '#c87838'];
    for (let s = 0; s < 4; s++) {
      const sy = y + 2 + s * 7;
      rc(g, x + 2, sy + 6, 20, 1, '#6e4a2f');
      for (let bx = x + 3; bx < x + 20; bx += 3) {
        if (r() < .15) continue;
        if (r() < .06) { rc(g, bx, sy + 3, 2, 2, '#ded8c8'); px(g, bx, sy + 4, '#444'); continue; }
        const h = 4 + (r() * 2 | 0);
        rc(g, bx, sy + 6 - h, 2, h, pick(r, cols));
      }
    }
  };

  PR.mimic = (g, x, y, t, open, loot) => {
    const step = (t * 8 | 0) % 2;
    rc(g, x - 6, y - 8, 13, 7, '#6b4226'); rc(g, x - 5, y - 7, 11, 2, '#a66a32');
    rc(g, x - 7, y - 2, 15, 6, '#875027'); rc(g, x - 5, y - 1, 11, 1, open ? '#f7f3e8' : '#c88a43');
    px(g, x, y + 1, '#ffd84a');
    rc(g, x - 5, y + 4, 2, 3 + step, '#3b2820'); rc(g, x + 4, y + 4, 2, 4 - step, '#3b2820');
    if (open) { px(g, x - 3, y - 1, '#1c1018'); px(g, x + 3, y - 1, '#1c1018'); }
    if (loot) { px(g, x + 8, y - 5, '#8fd0ff'); px(g, x + 9, y - 6, '#f7f3e8'); }
  };

  PR.hauntedTodo = (g, x, y, t, eyes) => {
    const bob = Math.round(Math.sin(t * 5) * 1.5), xx = Math.round(x) - 9, yy = Math.round(y) - 8 + bob;
    rc(g, xx, yy, 18, 11, '#e8dfc0'); rc(g, xx + 1, yy + 1, 16, 1, '#b9a673');
    px(g, xx + 17, yy, '#8f805e'); px(g, xx + 16, yy + 1, '#8f805e');
    drawText(g, xx + 2, yy + 5, 'TODO', '#49372c');
    if (eyes) { px(g, xx + 5, yy + 2, '#d86ad8'); px(g, xx + 12, yy + 2, '#d86ad8'); }
    px(g, xx - 1, yy + 2, '#c8b4ff'); px(g, xx + 18, yy + 7, '#c8b4ff');
  };

  PR.gameTable = (g, x, y) => {
    rc(g, x - 3, y + 3, 6, 12, '#4a3220'); rc(g, x - 9, y + 13, 18, 2, '#4a3220');
    rc(g, x - 14, y - 6, 28, 14, '#6b4932'); rc(g, x - 17, y - 3, 34, 8, '#6b4932');
    rc(g, x - 14, y - 7, 28, 12, '#a27a50'); rc(g, x - 17, y - 4, 34, 6, '#a27a50');
  };

  PR.tableStillLife = (g, x, y, t) => {
    rc(g, x - 11, y - 5, 8, 5, '#e7dfc1'); rc(g, x - 10, y - 4, 6, 1, '#a84848');
    px(g, x - 8, y - 2, '#4878a8'); px(g, x - 6, y - 2, '#4878a8');
    rc(g, x - 1, y - 6, 4, 6, '#5aa9e6'); rc(g, x, y - 7, 2, 1, '#d8def0');
    rc(g, x + 5, y - 5, 5, 4, '#d8b878'); px(g, x + 6, y - 6, '#ffd84a');
    px(g, x + 8, y - 3, '#8a6242');
    if ((t * 3 | 0) % 2) px(g, x + 1, y - 4, '#f7f3e8');
  };

  PR.blackHole = (g, cx, cy, rotating, angle) => {
    const ring = front => {
      const tilt = .3 + Math.sin(angle * .6) * .25;
      for (let i = 0; i < 64; i++) {
        const a = i * Math.PI / 32;
        if ((Math.sin(a) >= 0) !== front) continue;
        const x = Math.cos(a) * 7, y = Math.sin(a) * 2.5;
        px(g, Math.round(cx + x * Math.cos(tilt) - y * Math.sin(tilt)),
          Math.round(cy + x * Math.sin(tilt) + y * Math.cos(tilt)), Math.cos(a - angle * 2) > .2 ? '#ffffff' : '#d8dce8');
      }
    };
    if (rotating) ring(false);
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const radius = dx * dx + dy * dy;
      if (radius <= 20) px(g, Math.round(cx) + dx, Math.round(cy) + dy, radius > 13 ? '#756b88' : '#030208');
    }
    if (rotating) ring(true);
  };

  function sportNet(g, x1, y1, x2, y2, height) {
    g.save(); g.lineWidth = 1;
    g.fillStyle = '#d4dadd'; g.fillRect(x1 - 1, y1 - height - 2, 2, height + 3); g.fillRect(x2 - 1, y2 - height - 2, 2, height + 3);
    g.strokeStyle = '#7b9096'; g.beginPath();
    for (let i = 0; i <= 4; i++) {
      const x = x1 + (x2 - x1) * i / 4, y = y1 + (y2 - y1) * i / 4;
      g.moveTo(x, y - height); g.lineTo(x, y - 1);
    }
    for (let h = 3; h < height; h += 5) { g.moveTo(x1, y1 - h); g.lineTo(x2, y2 - h); }
    g.stroke();
    g.strokeStyle = '#f2efda'; g.lineWidth = 1; g.beginPath();
    g.moveTo(x1, y1 - height); g.lineTo(x2, y2 - height); g.stroke(); g.restore();
  }

  PR.pingPongTable = (g, x, y) => {
    rc(g, x - 30, y + 14, 73, 3, '#392d2b');
    for (const [dx, dy] of [[-31,-8],[30,-8],[-22,5],[38,5]]) {
      rc(g, x + dx, y + dy, 3, 13, '#9aa6af'); rc(g, x + dx + 1, y + dy, 1, 13, '#52616e');
      rc(g, x + dx - 1, y + dy + 12, 5, 2, '#242b35');
    }
    rc(g, x - 21, y + 12, 60, 2, '#6a7c8b');
    const outline = () => { g.beginPath(); g.moveTo(x - 36, y - 17); g.lineTo(x + 36, y - 17); g.lineTo(x + 45, y + 5); g.lineTo(x - 27, y + 5); g.closePath(); };
    g.save(); g.translate(0, 4); outline(); g.fillStyle = '#182f4b'; g.fill(); g.restore();
    outline(); g.fillStyle = '#287bac'; g.fill(); g.strokeStyle = '#e8eff0'; g.lineWidth = 1; g.stroke();
    g.beginPath(); g.moveTo(x - 31.5, y - 6); g.lineTo(x + 40.5, y - 6); g.stroke();
    rc(g, x - 26, y + 6, 71, 2, '#356084');
    sportNet(g, x, y - 17, x + 9, y + 5, 7);
  };

  PR.badmintonCourt = (g, x, y) => {
    rc(g, x - 54, y - 18, 108, 36, '#345b48');
    g.strokeStyle = '#d4d7ae'; g.lineWidth = 1;
    g.strokeRect(x - 51.5, y - 16.5, 103, 33);
    g.beginPath();
    for (const dy of [-12, 12]) { g.moveTo(x - 51, y + dy); g.lineTo(x + 51, y + dy); }
    for (const dx of [-44, -19, 19, 44]) { g.moveTo(x + dx, y - 16); g.lineTo(x + dx, y + 16); }
    g.moveTo(x - 51, y); g.lineTo(x - 19, y); g.moveTo(x + 19, y); g.lineTo(x + 51, y); g.stroke();
    rc(g, x - 8, y - 17, 7, 2, '#293f35'); rc(g, x + 2, y + 16, 7, 2, '#293f35');
    sportNet(g, x - 5, y - 17, x + 5, y + 17, 17);
  };

  PR.summon = (g, x, y, p) => {
    g.save(); g.globalAlpha = Math.sin(p * Math.PI); g.strokeStyle = '#c4a5fa'; g.lineWidth = 1;
    g.beginPath(); g.ellipse(x, y + 8, 12 + p * 38, 5 + p * 12, 0, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6 + p * 2, dx = Math.cos(a) * (12 + p * 38), dy = Math.sin(a) * (5 + p * 12);
      rc(g, x + dx, y + 8 + dy, 2, 2, '#e6d6ff');
      rc(g, x + dx, y + dy - p * 20, 1, 4, '#b48ced');
    }
    g.restore();
  };

  PR.experiment = (g, x, y, kind, color, t) => {
    if (kind === 5) {
      rc(g, x - 5, y - 4, 10, 4, '#7c8baa'); rc(g, x - 3, y - 6, 6, 3, '#aebed1');
      for (let i = 0; i < 3; i++) rc(g, x - 4 + i * 3, y + (t * 7 + i * 2) % 6, 1, 2, '#8bd2f0');
      if (t % 4 < .4) { rc(g, x, y, 2, 3, '#ffe697'); rc(g, x - 1, y + 3, 2, 3, '#ffe697'); }
    } else if (kind === 7) {
      for (let i = 0; i < 3; i++) {
        const h = 4 + (Math.sin(t * .6 + i) + 1) * 3, bx = x - 5 + i * 4;
        rc(g, bx, y + 5 - h, 3, h, color); px(g, bx + 1, y + 4 - h, '#effbe7');
        rc(g, bx, y + 6 - h, 1, h - 2, '#eef3d5');
      }
    }
  };

  PR.deskPet = (g, x, y, seed, t, excited) => {
    const kind = (seed >>> 8) % 3, bob = excited ? Math.abs(Math.sin(t * 9)) * 5 : Math.sin(t * 1.4 + seed % 9) * .5;
    y = Math.round(y - bob); x = Math.round(x);
    if (kind === 0) {
      rc(g, x - 3, y - 3, 6, 3, '#e5d8b7'); rc(g, x + 2, y - 5, 3, 3, '#f4e8cc');
      const wing = Math.sin(t * (excited ? 14 : 3)) > 0 ? 4 : 2;
      for (let i = 0; i < 4; i++) rc(g, x - i, y - 3 - wing + i, 1, wing, '#bcaacb');
      px(g, x + 4, y - 4, '#463650'); rc(g, x - 5, y - 2, 2, 1, '#e5d8b7');
    } else if (kind === 1) {
      rc(g, x - 3, y - 4, 6, 4, '#6d558f'); rc(g, x - 4, y - 2, 8, 2, '#6d558f');
      px(g, x - 1, y - 3, '#ece2a3'); px(g, x + 2, y - 3, '#ece2a3');
      for (let i = 0; i < 3; i++) px(g, x - 3 + i * 3, y + (Math.sin(t * 3 + i) > 0 ? 1 : 0), '#6d558f');
    } else {
      rc(g, x - 1, y - 4, 3, 4, '#e1cda8'); rc(g, x - 4, y - 6, 9, 3, '#b56b87');
      rc(g, x - 2, y - 8, 5, 2, '#b56b87'); px(g, x - 2, y - 5, '#f1dabc'); px(g, x + 2, y - 6, '#f1dabc');
      rc(g, x, y - 2, excited ? 1 : 2, 1, '#4f3b51');
    }
    if (excited) { px(g, x - 6, y - 7, '#ffe5a4'); px(g, x + 6, y - 9, '#ffe5a4'); }
  };

  PR.ritual = (g, x, y, elapsed, completion) => {
    const count = Math.min(6, 1 + Math.floor(elapsed / 6)), p = completion;
    g.save(); g.globalAlpha = completion ? 1 - p : .45;
    const points = Array.from({ length: count }, (_, i) => {
      const a = i * Math.PI / 3 + (completion ? 0 : elapsed * .15);
      return [Math.round(x + Math.cos(a) * (17 - p * 8)), Math.round(y + Math.sin(a) * 8 - p * 19)];
    });
    if (completion) {
      g.strokeStyle = '#eedaa1'; g.lineWidth = 1; g.beginPath();
      points.forEach(([px, py], i) => i ? g.lineTo(px, py) : g.moveTo(px, py)); g.closePath(); g.stroke();
    }
    for (const [dx, dy] of points) {
      rc(g, dx - 1, dy, 3, 1, '#eedaa1'); rc(g, dx, dy - 1, 1, 3, '#eedaa1');
    }
    g.restore();
  };

  PR.oneRing = (g, cx, cy, angle) => {
    const tilt = .35 + Math.sin(angle * .6) * .3;
    const point = (a, h) => [Math.round(cx + Math.cos(a) * 8),
      Math.round(cy + Math.sin(a) * 3 + Math.cos(a) * tilt + h)];
    for (const front of [false, true]) {
      for (let i = 0; i < 80; i++) {
        const a = i * Math.PI / 40;
        if ((Math.sin(a) >= 0) !== front) continue;
        for (let h = -2; h <= 2; h++)
          px(g, ...point(a, h), h === -2 ? '#ffe9a0' : h === 2 ? '#93601d' : front ? '#dba337' : '#9b7028');
      }
      // Tiny flowing strokes travel around the band with its rotation.
      for (let i = 0; i < 12; i++) {
        const a = angle + i * Math.PI / 6;
        if ((Math.sin(a) >= 0) !== front) continue;
        px(g, ...point(a, -1), '#fff2bc');
        px(g, ...point(a + .06, 0), '#ff6b25');
        px(g, ...point(a + .12, 1), '#ffb54a');
        if (i % 2) px(g, ...point(a + .2, 0), '#ff6b25');
      }
    }
  };

  PR.deskDecor = (g, x, y, width, seed, drink, t) => {
    const r = rng(seed), color = pick(r, ['#88d8d0', '#b9a0eb', '#e9ba69', '#91c978', '#e998bc']);
    const kind = [0, 1, 2, 3, 4, 5, 7][Math.floor(r() * 7)], angle = t * (.35 + r() * .3) + r() * Math.PI * 2;
    const phase = (t + seed % 47) % (50 + seed % 21), mishap = phase < 3 ? Math.sin(phase / 3 * Math.PI) : 0;
    const accident = (seed >>> 12) % 3;
    const cx = x - width / 2 + 7 + (accident === 0 ? mishap * 7 : 0);
    const cy = y - 16 + Math.sin(t * 1.5 + seed % 13) * 1.5 - (accident === 0 ? mishap * 7 : 0);
    if (seed % 7 === 0) PR.oneRing(g, cx, cy, angle);
    else if (kind >= 5) PR.experiment(g, cx, cy, kind, color, t);
    else if (kind >= 3) PR.blackHole(g, cx, cy, kind === 4, angle);
    else {
      const vertices = kind === 0 ? [[1,1,1],[1,-1,-1],[-1,1,-1],[-1,-1,1]] : kind === 1 ?
        [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]] :
        [[-1,-1,-1],[1,-1,-1],[-1,1,-1],[1,1,-1],[-1,-1,1],[1,-1,1],[-1,1,1],[1,1,1]];
      const points = vertices.map(([a,b,c]) => [Math.round(cx + (a * Math.cos(angle) - c * Math.sin(angle)) * 3),
        Math.round(cy + b * 3 + (a * Math.sin(angle) + c * Math.cos(angle)) * 1.5)]);
      g.strokeStyle = color; g.lineWidth = 1; g.beginPath();
      vertices.forEach((v, i) => vertices.slice(i + 1).forEach((w, j) => {
        if (v.reduce((sum, n, k) => sum + (n - w[k]) ** 2, 0) !== (kind === 0 ? 8 : kind === 1 ? 2 : 4)) return;
        g.moveTo(...points[i]); g.lineTo(...points[i + j + 1]);
      }));
      g.stroke();
    }
    rc(g, cx - 4, y - 7, 9, 1, '#6b5378'); px(g, cx, y - 8, color);
    const fx = x + width / 2 - 9 + (accident === 1 && !drink ? mishap * Math.sin(phase * 8) * 3 : 0);
    if (drink) PR.cup(g, fx - 4, y - 15, drink, t);
    else {
      const tall = r() > .5;
      rc(g, fx, y - 14 - Number(tall), 3, 4, '#bed0d8');
      rc(g, fx - 2, y - 10, 7, 4, '#bed0d8'); rc(g, fx - 1, y - 9, 5, 3, color);
      if (accident === 1 && mishap > .2) { px(g, fx - 1, y - 5, '#8b6347'); px(g, fx + 3, y - 5, '#8b6347'); }
      px(g, fx - 1, y - 10, '#edf4e2'); rc(g, fx, y - 15 - Number(tall), 3, 1, '#8b6347');
    }
    if (width > 30) {
      rc(g, x + 4, y - 9, 6, 3, '#715683'); rc(g, x + 5, y - 8, 4, 1, '#ddcea9');
      rc(g, x + 3, y - 11, 6, 2, '#547b78');
      if (accident === 2 && mishap > .2) for (let i = 0; i < 4; i++)
        px(g, x + 6 + Math.sin(i * 2) * mishap * 7, y - 12 - mishap * (4 + i * 2), '#f0d88b');
    }
  };

  PR.crystal = (g, x, y, t, usage) => {
    rc(g, x + 3, y + 12, 8, 7, '#5e6478'); rc(g, x + 9, y + 12, 2, 7, '#4c5164');
    rc(g, x + 1, y + 19, 12, 3, '#4c5164'); rc(g, x + 2, y + 10, 10, 2, '#6c7390');
    const value = Math.max(0, Math.min(100, Number(usage) || 0)), rows = [6, 8, 8, 8, 8, 6];
    rows.forEach((width, i) => rc(g, x + 7 - width / 2, y + 2 + i, width, 1,
      i >= rows.length - Math.ceil(rows.length * value / 100) ? (value > 75 ? '#ff4a4a' : '#d84a5f') : '#243047'));
    const pulse = (t * 2 | 0) % 2;
    rc(g, x + 5, y + 3, 1 + pulse, 1, value > 75 ? '#ffe89a' : '#e6f6ff');
    if (value > 75 && (t * 5 | 0) % 2) {
      px(g, x, y + 2, '#ff8a6a'); px(g, x + 13, y + 4, '#ff8a6a');
      px(g, x + 2, y - 1, '#ffe89a'); px(g, x + 11, y, '#ffe89a');
    }
  };

  PR.quotaVat = (g, x, y, shape, fill, color, t) => {
    const big = shape !== 'thin', rows = big ? [3, 3, 4, 6, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 7, 6, 5] :
      [2, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
    const cx = x + (big ? 8 : 4), top = y + 3, bottom = top + rows.length - 1;
    const fills = Array.isArray(fill) ? fill : [{ value: fill, color }], interior = rows.length - 2;
    let used = 0;
    const ranges = fills.map(part => {
      const start = used, value = Math.max(0, Number(part.value) || 0);
      used = Math.min(100, used + value);
      return [start, used, part.color || color];
    }), total = used;
    if (shape === 'spiral') {
      const fillY = bottom - Math.round((rows.length - 2) * total / 100);
      for (let yy = top + 1, i = 0; yy < bottom - 2; yy += 4, i++) {
        const full = yy + 2 >= fillY, back = full ? '#2f7898' : '#596278', front = full ? color : '#8d98ad';
        rc(g, cx - 6, yy, 5, 1, back); rc(g, cx + 2, yy, 5, 1, back);
        px(g, cx - 7, yy + 1, back); px(g, cx + 7, yy + 1, back);
        px(g, cx - 8, yy + 1, front); px(g, cx + 8, yy + 1, front);
        rc(g, cx - 7, yy + 2, 6, 1, front); rc(g, cx + 2, yy + 2, 6, 1, front);
        px(g, cx + (i % 2 ? 7 : -7), yy + 3, front);
      }
      rc(g, cx - 4, y, 9, 2, '#4c5164'); rc(g, cx - 3, y + 2, 7, 1, '#9aa3b8');
      if (total > 2) px(g, cx + 3, bottom - 3, '#e6f6ff');
      return;
    }
    rows.forEach((half, iy) => {
      const yy = top + iy, edge = iy === 0 || iy === rows.length - 1;
      if (shape === 'vat') half = Math.min(half, 6);
      rc(g, cx - half, yy, half * 2 + 1, 1, edge ? '#30364a' : '#778096');
      if (!edge) {
        const fromBottom = bottom - yy;
        const liquid = ranges.find(([start, end]) => fromBottom > Math.round(interior * start / 100) && fromBottom <= Math.round(interior * end / 100));
        if (liquid) rc(g, cx - half + 1, yy, half * 2 - 1, 1, liquid[2]);
      }
    });
    rc(g, cx - (big ? 4 : 3), y, big ? 9 : 7, 2, '#4c5164');
    rc(g, cx - (big ? 3 : 2), y + 2, big ? 7 : 5, 1, '#9aa3b8');
    if (total > 2) px(g, cx - 2 + ((t * 2 + x) % 3 | 0), bottom - Math.max(1, Math.round((rows.length - 3) * total / 100)), '#f0ecff');
  };

  PR.circle = (g, x, y, t, active) => {
    const cx = x + 26, cy = y + 14, col = active ? '#9a7cf0' : '#5c4a8a';
    for (let a = 0; a < 32; a++) {
      const th = a / 32 * Math.PI * 2;
      px(g, cx + Math.round(Math.cos(th) * 24), cy + Math.round(Math.sin(th) * 11), col);
      if (a % 4 === 0) px(g, cx + Math.round(Math.cos(th) * 18), cy + Math.round(Math.sin(th) * 8), col);
    }
    if (active) { const th = t * 2.4; px(g, cx + Math.round(Math.cos(th) * 24), cy + Math.round(Math.sin(th) * 11), '#e8dcff'); px(g, cx + Math.round(Math.cos(th + 3.14) * 24), cy + Math.round(Math.sin(th + 3.14) * 11), '#e8dcff'); }
  };

  PR.board = (g, x, y) => {
    rc(g, x, y, 30, 21, '#5a3c26'); rc(g, x + 2, y + 2, 26, 17, '#8a6a42');
    rc(g, x + 4, y + 4, 5, 6, '#ece3c4'); px(g, x + 6, y + 3, '#a83a3a');
    rc(g, x + 12, y + 5, 6, 5, '#e8d890'); px(g, x + 14, y + 4, '#3a6ad8');
    rc(g, x + 21, y + 4, 5, 7, '#ece3c4'); px(g, x + 23, y + 3, '#a83a3a');
    rc(g, x + 8, y + 13, 7, 4, '#ece3c4'); px(g, x + 9, y + 14, '#888'); px(g, x + 12, y + 15, '#888');
    rc(g, x + 19, y + 13, 3, 5, '#a83a3a');
  };

  PR.hearth = (g, x, y, t) => {
    rc(g, x, y, 28, 24, '#5e6478'); rc(g, x, y, 28, 2, '#6c7390'); rc(g, x + 24, y, 4, 24, '#4c5164');
    rc(g, x + 4, y + 6, 20, 18, '#1c1018');
    rc(g, x + 8, y + 20, 12, 2, '#5a3a22');
    const f = (t * 6 | 0) % 3;
    [[10, 15 + (f === 0 ? 0 : 1)], [13, 13 + (f === 1 ? 0 : 2)], [17, 15 + (f === 2 ? 0 : 1)]].forEach(([dx, dy]) => { rc(g, x + dx, y + dy, 2, 19 - dy, '#f08a2a'); px(g, x + dx, y + dy + 1, '#ffd84a'); });
    rc(g, x + 11, y + 18, 6, 2, '#ffd84a');
  };

  PR.chair = (g, x, y, flip) => {
    const X = dx => flip ? x + 13 - dx : x + dx;
    rc(g, Math.min(X(0), X(3)), y, 4, 12, '#7a3b4a');
    rc(g, Math.min(X(4), X(11)), y + 5, 8, 5, '#8a4456');
    rc(g, Math.min(X(4), X(11)), y + 3, 8, 2, '#6a3242');
    rc(g, Math.min(X(4), X(11)), y + 10, 8, 2, '#542838');
  };

  PR.counter = (g, x, y) => {
    rc(g, x, y, 96, 7, '#7d5636'); rc(g, x, y, 96, 1, '#8f6743');
    rc(g, x, y + 7, 96, 11, '#6e4a2f'); rc(g, x, y + 7, 96, 2, '#8a6242');
    for (let i = 0; i < 5; i++) px(g, x + 10 + i * 18, y + 12, '#4a3220');
    rc(g, x + 56, y + 2, 3, 3, '#ece3c4'); px(g, x + 59, y + 3, '#ece3c4');
    rc(g, x + 70, y + 2, 3, 3, '#a8d8e8'); px(g, x + 73, y + 3, '#a8d8e8');
  };

  PR.beans = (g, x, y, hot) => {
    rc(g, x, y + 1, 8, 3, '#2c2530'); rc(g, x + 1, y + 1, 6, 1, '#3c3548');
    rc(g, x + 8, y + 2, 3, 1, '#2c2530');
    [[1, 0], [3, 0], [5, 0], [2, 1], [4, 1]].forEach(([dx, dy], i) =>
      px(g, x + 1 + dx, y + dy, hot ? (i % 2 ? '#ffd84a' : '#f08a2a') : '#6b4226'));
  };

  PR.espresso = (g, x, y, t) => {
    rc(g, x + 1, y, 14, 2, '#8a92a8'); rc(g, x, y + 2, 16, 9, '#aab2c4'); rc(g, x + 12, y + 2, 4, 9, '#8a92a8');
    rc(g, x + 4, y + 7, 4, 3, '#5c6478'); rc(g, x + 6, y + 9, 4, 1, '#3a2c20');
    rc(g, x + 13, y - 3, 2, 4, '#c43c3c'); px(g, x + 2, y + 4, '#e8c04a');
    rc(g, x + 4, y + 10, 3, 2, '#f4f0e0');
    if ((t * 3 | 0) % 2) { px(g, x + 5, y + 5, '#e8edf5'); }
  };

  PR.plant = (g, x, y) => {
    rc(g, x + 3, y + 9, 8, 5, '#a85a32'); rc(g, x + 2, y + 8, 10, 2, '#c4703e');
    [[6, 0], [4, 2], [8, 2], [5, 4], [9, 4], [3, 5], [7, 5], [10, 6], [6, 7]].forEach(([dx, dy], i) => rc(g, x + dx, y + dy, 2, 2, i % 2 ? '#2f7b3c' : '#3f9b4f'));
  };

  PR.doorway = (g, x, y, t) => {
    rc(g, x - 2, y, 2, 14, '#5a3c26'); rc(g, x + 24, y, 2, 14, '#5a3c26');
    rc(g, x, y, 24, 14, '#16101e');
    rc(g, x + 2, y + 2, 9, 12, '#5e4028'); rc(g, x + 13, y + 2, 9, 12, '#5e4028');
    px(g, x + 9, y + 8, '#e8c04a'); px(g, x + 14, y + 8, '#e8c04a');
    rc(g, x + 9, y - 5, 6, 4, '#3c3344'); px(g, x + 11, y - 4, (t * 4 | 0) % 2 ? '#ffd84a' : '#f0a83c');
  };

  PR.window = (g, x, y, t, seed) => {
    const r = rng(seed);
    rc(g, x, y, 14, 16, '#2c2535'); rc(g, x + 2, y + 2, 10, 12, '#0e1230');
    px(g, x + 2, y + 2, '#2c2535'); px(g, x + 11, y + 2, '#2c2535');
    for (let i = 0; i < 5; i++) {
      const sx = x + 3 + (r() * 8 | 0), sy = y + 3 + (r() * 9 | 0);
      if ((t * 2 + i) % 4 < 3) px(g, sx, sy, i % 2 ? '#cdd6f0' : '#8a93b8');
    }
    if (seed % 3 === 0) { rc(g, x + 7, y + 4, 3, 3, '#e8e4d0'); px(g, x + 7, y + 4, '#0e1230'); }
    rc(g, x + 1, y + 14, 12, 2, '#3c3344');
  };

  PR.banner = (g, x, y, c) => {
    rc(g, x - 1, y, 12, 1, '#8a6242');
    rc(g, x, y + 1, 10, 9, c); rc(g, x, y + 10, 4, 3, c); rc(g, x + 6, y + 10, 4, 3, c);
    px(g, x + 4, y + 4, '#e8c04a'); px(g, x + 5, y + 4, '#e8c04a'); px(g, x + 4, y + 5, '#e8c04a'); px(g, x + 5, y + 5, '#e8c04a');
  };

  PR.torch = (g, x, y, t) => {
    rc(g, x + 2, y + 5, 2, 5, '#6c5132'); rc(g, x + 1, y + 9, 4, 1, '#4c3a24');
    const f = (t * 7 | 0) % 2;
    rc(g, x + 1, y + 2 - f, 4, 3 + f, '#f08a2a'); rc(g, x + 2, y + 3, 2, 2, '#ffd84a');
  };

  PR.rug = (g, x, y) => {
    rc(g, x, y, 36, 16, '#5e2c3a'); rc(g, x + 1, y + 1, 34, 14, '#7a3b4a');
    rc(g, x + 3, y + 3, 30, 10, '#6a3242'); rc(g, x + 4, y + 4, 28, 8, '#7a3b4a');
    [[2, 2], [33, 2], [2, 13], [33, 13]].forEach(([dx, dy]) => px(g, x + dx, y + dy, '#e8c04a'));
    px(g, x + 17, y + 6, '#e8c04a'); px(g, x + 18, y + 6, '#e8c04a');
    px(g, x + 16, y + 7, '#e8c04a'); px(g, x + 19, y + 7, '#e8c04a');
    px(g, x + 17, y + 8, '#e8c04a'); px(g, x + 18, y + 8, '#e8c04a');
    px(g, x + 17, y + 9, '#e8c04a'); px(g, x + 18, y + 9, '#e8c04a');
  };

  PR.sign = (g, x, y, txt) => {
    const w = textW(txt) + 6;
    rc(g, x, y, w, 11, '#3c2c1c'); rc(g, x + 1, y + 1, w - 2, 9, '#5a3c26');
    drawText(g, x + 3, y + 3, txt, '#ffd84a');
  };

  function drawCup(g, x, y, drink, t) {
    const d = typeof drink === 'string' ? drinkByKey(drink) : drink || DRINKS[0];
    if (d.key === 'antimatter') {
      rc(g, x + 3, y + 6, 6, 3, '#f4f0e0'); px(g, x + 9, y + 7, '#f4f0e0'); rc(g, x + 4, y + 6, 4, 1, '#1c1430');
      [[6, 2], [6, 1], [5, 3], [7, 3], [4, 4], [3, 5], [8, 4], [9, 5], [6, 4]].forEach(([dx, dy], i) => px(g, x + dx, y + dy + ((t * 3 | 0) % 2 === 0 && i > 0 ? -1 : 0), i ? '#d8ff58' : '#1c1430'));
      return;
    }
    if (d.potion) {
      rc(g, x + 5, y + 2, 3, 2, '#d8def0'); rc(g, x + 4, y + 4, 5, 5, d.potion); rc(g, x + 3, y + 6, 7, 3, d.potion);
      px(g, x + 5, y + 2, '#f7f3e8'); px(g, x + 8, y + 5, shade(d.potion, .72)); px(g, x + 5, y + 6, '#f7f3e8');
      px(g, x + 6, y + 4 + ((t * 3 | 0) % 2), '#e8f6ff');
      return;
    }
    const small = d.key === 'espresso' || d.key === 'double-espresso' || d.key === 'macchiato';
    const milk = d.milk || d.key === 'warm-milk';
    const dark = d.key === 'warm-milk' ? '#f2ead0' : milk ? '#d8b98c' : '#5a321d';
    const foam = d.key === 'cappuccino' ? '#f7f3e8' : d.key === 'flat-white' ? '#eadfc8' : '#f0e6d0';
    if (small) {
      const w = d.key === 'double-espresso' ? 6 : 5;
      rc(g, x + 3, y + 6, w, 3, '#f4f0e0'); px(g, x + 3 + w, y + 7, '#f4f0e0');
      rc(g, x + 4, y + 6, w - 2, 1, d.key === 'macchiato' ? foam : '#5a321d');
      if (d.key === 'macchiato') px(g, x + 5, y + 5, '#f7f3e8');
    } else {
      rc(g, x + 2, y + 5, 7, 4, '#f4f0e0'); px(g, x + 9, y + 6, '#f4f0e0'); px(g, x + 9, y + 7, '#f4f0e0');
      rc(g, x + 3, y + 5, 5, 1, dark);
      if (milk) { px(g, x + 4, y + 4, foam); px(g, x + 6, y + 4, foam); if (d.key === 'latte' || d.key === 'cappuccino') px(g, x + 5, y + 3, foam); }
    }
    px(g, x + 4, y + 2 - ((t * 2 | 0) % 2), '#c8c2d8');
    px(g, x + 7, y + 1 + ((t * 2 | 0) % 2), '#c8c2d8');
  }
  PR.cup = drawCup;

  // ---------- emotes ----------
  function drawEmote(g, cx, topY, key, t) {
    if (key === 'sleep') return;
    const x = cx - 6, y = topY - 14 + Math.round(Math.sin(t * 2.2) * 1.5);
    rc(g, x, y, 12, 11, '#f7f3e8');
    rc(g, x, y, 12, 1, '#262032'); rc(g, x, y + 10, 12, 1, '#262032');
    rc(g, x - 1, y + 1, 1, 9, '#262032'); rc(g, x + 12, y + 1, 1, 9, '#262032');
    px(g, x + 5, y + 11, '#262032'); px(g, x + 5, y + 12, '#f7f3e8'); px(g, x + 4, y + 11, '#f7f3e8');
    const I = (dx, dy, c) => px(g, x + dx, y + dy, c);
    if (key && key.startsWith('drink:')) { drawCup(g, x, y, key.slice(6), t); return; }
    switch (key) {
      case 'alert': drawText(g, x + 5, y + 3, '!', '#d83a3a'); break;
      case 'ask': drawText(g, x + 4, y + 3, '?', '#3a6ad8'); break;
      case 'think': { const f = (t * 2.5 | 0) % 3; [[2, 7], [5, 7], [8, 7]].forEach(([dx, dy], i) => I(dx + 1, dy - (i === f ? 1 : 0), i === f ? '#4a4458' : '#8a84a0')); break; }
      case 'write': I(3, 8, '#30364a'); I(4, 7, '#8a5a32'); I(5, 6, '#8a5a32'); I(6, 5, '#d8def0'); I(7, 4, '#d8def0'); I(8, 3, '#d8def0'); break;
      case 'brew': rc(g, x + 3, y + 4, 6, 4, '#3a3f4c'); rc(g, x + 2, y + 3, 8, 1, '#4d5468'); I(4, 2, '#58d878'); I(7, 1 + ((t * 3 | 0) % 2), '#58d878'); break;
      case 'book': rc(g, x + 2, y + 4, 4, 5, '#a84848'); rc(g, x + 6, y + 4, 4, 5, '#c8b890'); I(7, 5, '#8a7a58'); I(8, 6, '#8a7a58'); break;
      case 'scry': rc(g, x + 4, y + 3, 4, 4, '#8fd0ff'); I(5, 4, '#e6f6ff'); rc(g, x + 3, y + 7, 6, 2, '#5e6478'); break;
      case 'summon': I(5, 2, '#9a7cf0'); I(5, 3, '#9a7cf0'); I(3, 4, '#9a7cf0'); I(4, 4, '#9a7cf0'); I(5, 4, '#c8b4ff'); I(6, 4, '#9a7cf0'); I(7, 4, '#9a7cf0'); I(5, 5, '#9a7cf0'); I(4, 6, '#9a7cf0'); I(6, 6, '#9a7cf0'); break;
      case 'scroll': rc(g, x + 3, y + 3, 6, 6, '#ece3c4'); I(4, 4, '#a89878'); I(6, 4, '#a89878'); I(4, 6, '#a89878'); I(5, 6, '#a89878'); break;
      case 'coffee': rc(g, x + 3, y + 5, 5, 4, '#f4f0e0'); I(8, 6, '#f4f0e0'); rc(g, x + 4, y + 5, 3, 1, '#6b4226'); I(4, 3 - ((t * 2 | 0) % 2), '#c8c2d8'); I(6, 2 + ((t * 2 | 0) % 2), '#c8c2d8'); break;
      case 'star': I(5, 2, '#ffd84a'); I(5, 3, '#ffd84a'); rc(g, x + 3, y + 4, 6, 1, '#ffd84a'); I(4, 5, '#ffd84a'); I(6, 5, '#ffd84a'); I(3, 7, '#ffd84a'); I(7, 7, '#ffd84a'); break;
      case 'flask': I(5, 2, '#d8def0'); I(5, 3, '#d8def0'); rc(g, x + 4, y + 4, 4, 4, '#d86ad8'); I(4, 4, '#e8a8e8'); break;
      case 'search': rc(g, x + 3, y + 3, 4, 4, '#d8def0'); I(4, 4, '#f7f3e8'); I(7, 7, '#8a92a8'); I(8, 8, '#8a92a8'); break;
    }
  }

  return { hash, rng, pick, hsl, shade, drawText, textW, makeWizard, makeCat, makeDragon, PR, drawEmote, EPITHETS, DRINKS, INFERNAL_DRINKS, WARM_MILK, drinkFor };
})();
