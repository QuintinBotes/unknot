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
    assert.ok(impactOf({ kind: 'module.hub-module', measurements: { 'module.fan_in': 3, 'module.loc': 10 } }) < impactOf({ kind: 'module.hub-module', measurements: { 'module.fan_in': 4, 'module.loc': 20 } }), 'small hubs are not clamped into a tie');
  });
});

test('a package cycle folds into a file cycle only over exactly the same files', async () => {
  const { default: module_ } = await import('../../../runtime/diagnose/detectors/module.mjs');
  const { Graph } = await import('../../../runtime/graph/graph.mjs');
  const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');
  const P = prov({ source_type: 'ast', source_ref: 't.js:1', extractor: 'test@0.0.1', confidence: 'high' });
  const mod = (path) => nodeFact('module', path, { name: path, path, attrs: { language: 'js', loc: 10, is_test: false } }, P);
  const imp = (a, b) => edgeFact('IMPORTS', `module:${a}`, `module:${b}`, {}, P);
  const run = (facts) => module_.find((d) => d.id === 'module.dependency-cycle').detect({ graph: Graph.fromFacts(facts), options: {} }).map((d) => [d.kind, d.related_kinds ?? []]);
  // right/z.js keeps the package cycle alive without the file cycle: two subjects.
  assert.deepEqual(run([mod('left/x.js'), mod('right/y.js'), mod('right/z.js'), imp('left/x.js', 'right/y.js'), imp('right/y.js', 'left/x.js'), imp('left/x.js', 'right/z.js')]).map(([k]) => k).sort(), ['module.dependency-cycle', 'module.package-cycle']);
  // Three packages of one file each, A importing and imported by B and C: one subject.
  assert.deepEqual(run([mod('a/a.js'), mod('b/b.js'), mod('c/c.js'), imp('a/a.js', 'b/b.js'), imp('b/b.js', 'a/a.js'), imp('a/a.js', 'c/c.js'), imp('c/c.js', 'a/a.js')]), [['module.dependency-cycle', ['module.package-cycle']]]);
});

test('a tie in rank goes to the larger impact, then to the id', async () => {
  const { byRank, impactRank } = await import('../../../runtime/diagnose/impact.mjs');
  // Equal rank: 0.5 × sqrt(1 + 3) = 1 × sqrt(1 + 0) = 1.
  const big = { id: 'F-0002', kind: 'local.x', scope: ['a', 'b', 'c'], priority: { score: 0.5 }, measurements: {} };
  const small = { id: 'F-0001', kind: 'local.x', scope: [], priority: { score: 1 }, measurements: {} };
  const twin = { id: 'F-0000', kind: 'local.x', scope: [], priority: { score: 1 }, measurements: {} };
  assert.equal(impactRank(big), impactRank(small));
  assert.deepEqual([small, twin, big].sort(byRank(impactRank)).map((f) => f.id), ['F-0002', 'F-0000', 'F-0001']);
});

test('the MCP finding list uses the same order as diagnose', async () => {
  const { TOOLS } = await import('../../../runtime/mcp/tools.mjs');
  const listed = TOOLS.findings_list.run(p.ctx, { status: 'open', limit: 5 }).findings ?? TOOLS.findings_list.run(p.ctx, { status: 'open', limit: 5 });
  assert.deepEqual(listed.map((f) => f.id), res.findings.slice(0, 5).map((f) => f.id));
});

test('a stored package-cycle finding folded into a file cycle is resolved as replaced by it', async () => {
  const q = K.makeProject({ files: { 'left/x.js': js(['../right/y'], 'x'), 'right/y.js': js(['../left/x'], 'y') } });
  await mapRepository(q.ctx, { config: config(), configDigest: 'd', scope: [], history: false });
  const keyed = await diagnose(q.ctx, { config: config(), only: ['module'] });
  const kept = keyed.findings.find((f) => f.kind === 'module.dependency-cycle');
  assert.ok(kept?.replaces?.length === 1, JSON.stringify(kept?.replaces));
  // As an earlier version stored it: an open package-cycle finding of its own.
  q.ctx.store.insert('findings', { id: 'F-0900', fingerprint: kept.replaces[0], schema_version: kept.schema_version, kind: 'module.package-cycle', category: 'module', status: 'open', priority: 0.1, body: { ...kept, id: 'F-0900', kind: 'module.package-cycle', fingerprint: kept.replaces[0], status: 'open' }, first_seen_commit: 'x', last_seen_commit: 'x', last_run_id: null, created_at: 'x', updated_at: 'x' });
  await diagnose(q.ctx, { config: config() });
  const row = JSON.parse(q.ctx.store.get("SELECT body FROM findings WHERE id = 'F-0900'").body);
  assert.equal(row.status, 'resolved');
  assert.equal(row.replaced_by, kept.id);
});
