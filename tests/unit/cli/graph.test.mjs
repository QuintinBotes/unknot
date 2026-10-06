// `unknot graph` against a small real project: filters, scope, value-less flags, id columns.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'uk-cligraph-home-'));
const proj = mkdtempSync(join(tmpdir(), 'uk-cligraph-proj-'));
process.env.UNKNOT_HOME = home;

const { openProject } = await import('../../../runtime/context.mjs');
const { project } = await import('../../../runtime/graph/builder.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');
const { table } = await import('../../../runtime/cli/util.mjs');

const p = prov({ source_type: 'ast', source_ref: 'x:1', extractor: 'test' });
const LONG = `src/very/long/directory/name/that/keeps/going/and/going/Services/Catalog/ProductAttributeFormatter.cs`;
const mod = (path, extra = {}) => nodeFact('module', path, { name: path.split('/').pop(), path, attrs: extra }, p);
const imp = (a, b) => edgeFact('IMPORTS', `module:${a}`, `module:${b}`, {}, p);

before(() => {
  const ctx = openProject(proj, { create: true });
  project(
    ctx,
    [
      mod('src/cat/A.cs', { namespace: 'Shop.Catalog', types: ['Alpha'] }),
      mod('src/cat/B.cs', { namespace: 'Shop.Catalog' }),
      mod('src/cat/C.cs', { namespace: 'Shop.Catalog' }),
      mod('src/ord/X.cs', { namespace: 'Shop.Orders' }),
      mod('src/ord/Y.cs', { namespace: 'Shop.Orders' }),
      mod('src/dec/P.cs'),
      mod('src/dec/Q.cs'),
      mod('tests/AlphaTests.cs', { is_test: true }),
      mod(LONG),
      imp('src/cat/A.cs', 'src/cat/B.cs'),
      imp('src/cat/B.cs', 'src/cat/A.cs'),
      imp('src/cat/C.cs', 'src/cat/A.cs'),
      imp('src/ord/X.cs', 'src/ord/Y.cs'),
      imp('src/ord/Y.cs', 'src/ord/X.cs'),
      imp('src/ord/X.cs', 'src/cat/A.cs'),
      imp('src/dec/P.cs', 'src/dec/Q.cs'),
      edgeFact('IMPORTS', 'module:src/dec/Q.cs', 'module:src/dec/P.cs', { declared_only: true, unused_member: 'Ledger' }, p),
      edgeFact('TESTS', 'module:tests/AlphaTests.cs', 'module:src/cat/A.cs', {}, p),
      edgeFact('CALLS', 'module:src/ord/Y.cs', 'module:src/cat/A.cs', {}, p),
      edgeFact('IMPORTS', `module:${LONG}`, 'module:src/cat/A.cs', {}, p),
    ],
    { commit: 'abc123', observedAt: '2026-01-01T00:00:00Z' },
  );
  ctx.store.close();
});

const graph = (...args) => {
  const r = spawnSync(process.execPath, [BIN, 'graph', ...args, '--cwd', proj], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const json = (...args) => JSON.parse(graph(...args, '--json').out);

test('edges: --type, the positional and a comma list all filter; --from and --to take ids or paths', () => {
  assert.deepEqual([...new Set(json('edges', '--type', 'TESTS').map((e) => e.type))], ['TESTS']);
  assert.deepEqual([...new Set(json('edges', 'TESTS').map((e) => e.type))], ['TESTS']);
  assert.deepEqual([...new Set(json('edges', '--type', 'TESTS,CALLS').map((e) => e.type))].sort(), ['CALLS', 'TESTS']);
  const from = json('edges', '--from', 'src/ord/X.cs');
  assert.equal(from.length, 2);
  assert.ok(from.every((e) => e.src === 'module:src/ord/X.cs'));
  const to = json('edges', '--type', 'IMPORTS', '--to', 'module:src/cat/A.cs');
  assert.deepEqual(to.map((e) => e.src).sort(), ['module:src/cat/B.cs', 'module:src/cat/C.cs', 'module:src/ord/X.cs', `module:${LONG}`]);
  assert.equal(json('edges', '--from', 'src/ord/X.cs', '--to', 'src/ord/Y.cs').length, 1);
  assert.equal(json('edges', '--type', 'TESTS', '--limit', '1').length, 1);
  assert.equal(graph('edges', '--from', 'nope.cs').code, 1);
  assert.equal(graph('edges', '--type', 'NOPE').code, 1);
});

test('a flag that needs a value and has none is an error, not NaN', () => {
  for (const args of [['edges', '--limit'], ['edges', '--limit', 'abc'], ['edges', '--limit', '0'], ['edges', '--type'], ['edges', '--from'], ['hubs', '--limit'], ['neighbourhood', 'Alpha', '--depth']]) {
    const r = graph(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /needs/);
  }
});

test('cycles: --limit applies, scope narrows to the in-scope subgraph, an empty scope warns', () => {
  const members = (...a) => json('cycles', ...a).map((c) => c.members);
  assert.equal(json('cycles').length, 3);
  assert.equal(json('cycles', '--limit', '1').length, 1);
  assert.deepEqual(members('src/cat'), [['module:src/cat/A.cs', 'module:src/cat/B.cs']]);
  assert.deepEqual(members('ns:Shop.Orders'), [['module:src/ord/X.cs', 'module:src/ord/Y.cs']]);
  assert.deepEqual(json('cycles', 'src/cat/C.cs'), []);
  const none = graph('cycles', 'src/nothing');
  assert.match(none.err, /matched 0/);
  assert.match(none.out, /no cycles/);
});

test('cycles: lists the cycle, the edge to cut and marks a declared-only edge', () => {
  const [c] = json('cycles', 'src/dec');
  assert.equal(c.size, 2);
  assert.equal(c.cycles.length, 1);
  assert.deepEqual(c.cut.map((e) => [e.from, e.to, e.declared_only, e.unused_member]), [['module:src/dec/Q.cs', 'module:src/dec/P.cs', true, 'Ledger']]);
  const text = graph('cycles', 'src/dec').out;
  assert.match(text, /src\/dec\/Q\.cs → src\/dec\/P\.cs \(declared only: src\/dec\/P\.cs member Ledger is never used\)/);
  assert.match(text, /src\/dec\/P\.cs → src\/dec\/Q\.cs → src\/dec\/P\.cs/);
  assert.doesNotMatch(text, /…/);
});

test('hubs: union of edge types, scope ranks in-scope nodes, --within counts only in-scope sources', () => {
  const imports = json('hubs');
  assert.equal(imports.fan_in[0].id, 'module:src/cat/A.cs');
  assert.equal(imports.fan_in[0].n, 4);
  const both = json('hubs', '--type', 'IMPORTS,CALLS');
  assert.equal(both.fan_in[0].n, 5);
  assert.deepEqual(both.edge_types, ['IMPORTS', 'CALLS']);
  const calls = json('hubs', 'CALLS');
  assert.equal(calls.fan_in[0].n, 1);
  const scoped = json('hubs', 'ns:Shop.Catalog');
  assert.ok(scoped.fan_in.every((x) => x.id.startsWith('module:src/cat/')));
  assert.equal(scoped.fan_in[0].n, 4);
  const within = json('hubs', '--within', 'ns:Shop.Catalog');
  assert.equal(within.fan_in[0].n, 2);
  assert.match(graph('hubs', 'src/nothing').err, /matched 0/);
});

test('neighbourhood: id, path or type name; depth and types honoured; depth above 3 rejected', () => {
  const byType = json('neighbourhood', 'Alpha');
  assert.deepEqual(byType.roots, ['module:src/cat/A.cs']);
  assert.ok(byType.nodes.length >= 5);
  const byPath = json('neighbourhood', 'src/cat/A.cs', '--type', 'TESTS');
  assert.equal(byPath.nodes.length, 2);
  assert.equal(byPath.edges.length, 1);
  assert.ok(json('neighbourhood', 'src/cat/C.cs', '--depth', '2').nodes.length > json('neighbourhood', 'src/cat/C.cs').nodes.length);
  assert.equal(graph('neighbourhood', 'Alpha', '--depth', '4').code, 1);
  assert.equal(graph('neighbourhood', 'Missing').code, 1);
  assert.match(graph('neighbourhood', 'Alpha').out, /module:src\/cat\/A\.cs/);
});

test('table never truncates ids, other cells still cap at 60', () => {
  const id = `module:${LONG}${LONG}`;
  const long = 'y'.repeat(100);
  const t = table([{ id, label: long, src: id, other: `module:${long}` }], ['id', 'label', 'src', 'other']);
  assert.equal(t.split(id).length - 1, 2);
  assert.ok(t.includes(`module:${long}`));
  assert.ok(!t.includes(long) || t.includes(`module:${long}`));
  assert.ok(t.includes('y'.repeat(60)) && !t.split('\n')[2].includes(`  ${'y'.repeat(61)}`));
  const text = table([{ a: 'z'.repeat(80) }], ['a']);
  assert.equal(text.split('\n')[2], 'z'.repeat(60));
  assert.ok(graph('edges', '--from', `module:${LONG}`).out.includes(`module:${LONG}`));
});

test('nodes: --name and --path filter, and a cut-off list says how many there are', () => {
  const byName = json('nodes', 'module', '--name', 'ord/');
  assert.deepEqual(byName.nodes.map((n) => n.id).sort(), ['module:src/ord/X.cs', 'module:src/ord/Y.cs']);
  assert.equal(byName.total, 2);
  assert.deepEqual(json('nodes', 'module', '--path', 'src/dec/**').nodes.map((n) => n.id).sort(), ['module:src/dec/P.cs', 'module:src/dec/Q.cs']);
  const cut = graph('nodes', 'module', '--limit', '2');
  assert.match(cut.out, /\(2 of \d+ nodes; raise --limit or narrow with a type, --name or --path\)/);
});

test('edges <node>: a node or path instead of an edge type gives its edges in both directions', () => {
  const rows = json('edges', 'src/cat/A.cs');
  assert.ok(rows.length >= 5);
  assert.ok(rows.every((e) => e.src === 'module:src/cat/A.cs' || e.dst === 'module:src/cat/A.cs'));
  assert.ok(rows.some((e) => e.type === 'CALLS') && rows.some((e) => e.type === 'TESTS'));
});

test('neighbourhood: counts per relation, and says when calls cannot be seen for code read lexically', () => {
  const r = graph('neighbourhood', 'src/cat/A.cs');
  assert.match(r.out, /\(IMPORTS \d+.*CALLS 1.*\)|\(.*CALLS 1.*IMPORTS \d+.*\)/);
});

test('neighbourhood: call edges appear by default, drop the missing-calls note, and --type narrows them', () => {
  const all = graph('neighbourhood', 'src/cat/A.cs');
  assert.match(all.out, /CALLS\s+module:src\/ord\/Y\.cs\s+module:src\/cat\/A\.cs/);
  assert.doesNotMatch(all.out, /No CALLS edges/);
  const only = json('neighbourhood', 'src/cat/A.cs', '--type', 'CALLS');
  assert.deepEqual([...new Set(only.edges.map((e) => e.type))], ['CALLS']);
  assert.ok(!json('neighbourhood', 'src/cat/A.cs', '--type', 'IMPORTS').edges.some((e) => e.type === 'CALLS'));
});
