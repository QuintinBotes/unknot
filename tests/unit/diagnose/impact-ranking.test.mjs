// Findings are ranked by impact, one kind cannot fill the top, and one subject is one finding (#76).

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';

const { mapRepository } = await import('../../../runtime/graph/builder.mjs');
const { diagnose } = await import('../../../runtime/diagnose/engine.mjs');
const { capPerKind, impactOf, IMPACT } = await import('../../../runtime/diagnose/impact.mjs');

after(() => K.cleanup());

const js = (imports, name) => `${imports.map((i) => `import { ${i.split('/').pop()} } from '${i}.js';`).join('\n')}\nexport function ${name}() { return 1; }\n`;
function fixture() {
  const f = {};
  // One cycle of 50 files.
  for (let i = 0; i < 50; i++) f[`big/f${i}.js`] = js([`./f${(i + 1) % 50}`], `f${i}`);
  // Twenty cycles of two files, each in one directory.
  for (let i = 0; i < 20; i++) {
    f[`pair${i}/a.js`] = js(['./b'], 'a');
    f[`pair${i}/b.js`] = js(['./a'], 'b');
  }
  // Three hubs: fan-in 3, 4 and 5, each importing one file, with sizes that reverse the fan-in order.
  for (const [h, fanIn, lines] of [['h3', 3, 300], ['h4', 4, 100], ['h5', 5, 20]]) {
    f[`hubs/${h}.js`] = `${js(['./leaf'], h)}${'export const pad = 1;\n'.repeat(0)}${Array.from({ length: lines }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`;
    for (let i = 0; i < fanIn; i++) f[`users/${h}u${i}.js`] = js([`../hubs/${h}`], `u${i}`);
  }
  f['hubs/leaf.js'] = 'export function leaf() { return 1; }\n';
  // A cycle of two files in two directories: a file cycle and a package cycle about one subject.
  f['left/x.js'] = js(['../right/y'], 'x');
  f['right/y.js'] = js(['../left/x'], 'y');
  return f;
}

const config = () => {
  const c = K.cfg({ mode: 'plan' });
  c.detectors = { ...c.detectors, 'module.hub-module': { fan_in: 3, fan_out: 1 } };
  c.diagnose = { max_per_kind: 5 }; // below the default 10, so the fixture shows the cap
  return c;
};
const p = K.makeProject({ files: fixture() });
await mapRepository(p.ctx, { config: config(), configDigest: 'd', scope: [], history: false });
const res = await diagnose(p.ctx, { config: config(), only: ['module'] });

test('scenario 1: the 50-file cycle ranks above every two-file cycle', () => {
  const cycles = res.findings.filter((f) => f.kind === 'module.dependency-cycle');
  const big = cycles.findIndex((f) => f.measurements['cycle.size'] === 50);
  assert.ok(big >= 0);
  assert.ok(cycles.slice(0, big).every((f) => f.measurements['cycle.size'] > 2), 'no two-file cycle above the big one');
  assert.equal(res.findings.findIndex((f) => f.measurements['cycle.size'] === 50), 0, 'and it is first overall');
});

test('scenario 2: hubs are ordered by fan-in times size', () => {
  const hubs = res.findings.filter((f) => f.kind === 'module.hub-module').map((f) => f.scope[0]);
  assert.deepEqual(hubs, ['hubs/h3.js', 'hubs/h4.js', 'hubs/h5.js']);
});

test('scenario 3: one kind fills at most its cap of the top, and the rest follow', () => {
  const top = res.findings.slice(0, 10);
  assert.ok(top.filter((f) => f.kind === 'module.dependency-cycle').length <= 5);
  assert.ok(top.some((f) => f.kind === 'module.hub-module'));
  const list = [...Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, kind: 'a' })), ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, kind: `b${i}` }))];
  const capped = capPerKind(list, 10);
  assert.equal(capped.length, 110, 'nothing is hidden');
  assert.equal(capped.slice(0, 20).filter((f) => f.kind === 'a').length, 10, 'the default cap of 10');
  assert.deepEqual(capped.slice(20).map((f) => f.id), list.slice(10, 100).map((f) => f.id), 'the capped rest follows in order');
});

test('scenario 4: a cycle two detectors report is one finding with both sources', () => {
  const about = res.findings.filter((f) => f.scope.join() === 'left/x.js,right/y.js');
  assert.equal(about.length, 1, JSON.stringify(about.map((f) => f.kind)));
  assert.deepEqual([about[0].kind, ...about[0].related_kinds].sort(), ['module.dependency-cycle', 'module.package-cycle']);
});

test('scenario 5: ties order by impact, then id, and every kind has a documented measure', () => {
  const again = diagnose(p.ctx, { config: config(), only: ['module'] });
  return again.then((r) => {
    assert.deepEqual(r.findings.map((f) => f.id), res.findings.map((f) => f.id));
    for (const k of ['module.dependency-cycle', 'module.package-cycle', 'module.hub-module']) assert.ok(IMPACT[k].measure);
    assert.equal(impactOf({ kind: 'local.long-function', scope: ['a.js', 'a.js', 'b.js'], measurements: {} }), 2, 'default: distinct files in scope');
  });
});
