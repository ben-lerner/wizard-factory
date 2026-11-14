const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loop() {
  let now = 0, frame, interval;
  const draws = [], updates = [], document = { hidden: false };
  const source = fs.readFileSync('static/game.js', 'utf8')
    .split('  // ---------- main loop ----------')[1].split('  resize();')[0];
  vm.runInNewContext(source + '\nrequestAnimationFrame(frame);', {
    document, performance: { now: () => now },
    requestAnimationFrame: fn => { frame = fn; },
    setInterval: fn => { interval = fn; },
    update: (dt, t) => updates.push([dt, t]), draw: t => draws.push(t),
  });
  return { document, draws, updates,
    frame: ms => { now = ms; frame(ms); },
    interval: ms => { now = ms; interval(); },
  };
}

test('30fps cap preserves elapsed animation time on 60Hz and 120Hz displays', () => {
  for (const hz of [60, 120]) {
    const s = loop();
    for (let i = 0; i <= hz * 10; i++) s.frame(i * 1000 / hz);
    assert.ok(s.draws.length >= 298 && s.draws.length <= 300, `${hz}Hz: ${s.draws.length} draws`);
    assert.ok(s.draws.at(-1) > 9.96 && s.draws.at(-1) <= 10.001);
    assert.ok(s.updates.every(([dt]) => dt > 0 && dt <= .1));
  }
});

test('hidden windows advance the simulation without drawing and resume on return', () => {
  const s = loop();
  s.frame(100);
  s.document.hidden = true;
  for (let ms = 400; ms <= 3100; ms += 300) { s.frame(ms); s.interval(ms); }
  assert.equal(s.draws.length, 1);
  assert.ok(s.updates.at(-1)[1] >= 3);
  s.document.hidden = false;
  s.frame(3200);
  assert.equal(s.draws.length, 2);
  assert.ok(Math.abs(s.draws.at(-1) - 3.2) < .001);
});

test('fallback updates cap catch-up and leave rendering to the next visible frame', () => {
  const s = loop();
  s.interval(60000);
  assert.equal(s.draws.length, 0);
  assert.ok(Math.abs(s.updates.at(-1)[1] - 3) < .001);
  s.frame(60050);
  assert.equal(s.draws.length, 1);
  assert.ok(Math.abs(s.draws.at(-1) - 3.05) < .001);
});
