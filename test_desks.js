// Run with node --test test_desks.js. Exercise the real scene without a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function scene() {
  const ctx = new Proxy({}, { get: () => () => {} });
  const element = { getContext: () => ctx, toDataURL: () => '', addEventListener() {}, style: {} };
  const sandbox = { console, ResizeObserver: class { observe() {} }, document: { querySelector: () => element, createElement: () => element }, window: { addEventListener() {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('static/sprites.js', 'utf8'), sandbox);
  sandbox.SP = sandbox.window.SP;
  const source = fs.readFileSync('static/game.js', 'utf8').split('  // ---------- logo ----------')[0];
  vm.runInContext(source + 'window.test = { reconcile, update, wizards, desks, separateActors }; })();', sandbox);
  return sandbox.window.test;
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
