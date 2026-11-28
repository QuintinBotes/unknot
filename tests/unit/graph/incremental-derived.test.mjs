// Incremental derived facts (#145): when projection changed only some nodes and edges, the derived
// rows are brought forward from the stored ones and equal, in content and order, what a full
// recompute of the stored graph gives. Here the stored graph is changed by hand in the ways a
// map rarely produces on its own: a member of a component (one the build forbids) becomes test
// code, an end of a declared-only edge does, and a module gains or loses its node-level rows
// (its layer among them).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import { mapRepository } from '../../../runtime/graph/builder.mjs';
import { computeDerived, DERIVED_EDGE_TYPES, DERIVED_KINDS, layerSpec, rowsGeneration, updateDerived } from '../../../runtime/graph/derived.mjs';
import { Graph } from '../../../runtime/graph/graph.mjs';

after(() => K.cleanup());

const cls = (ns, name, body, usings = '') => `${usings}namespace ${ns}\n{\n    public class ${name}\n    {\n        ${body}\n    }\n}\n`;
const files = {
  // B references A, while A's file names B's type: a cycle across build units (#72).
  'A/A.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="$(RepoRoot)Other/Other.csproj" /></ItemGroup></Project>\n',
  'A/Ledger.cs': cls('Shop.A', 'Ledger', 'Invoice i;', 'using Shop.B;\n'),
  'A/Mailer.cs': cls('Shop.A', 'Mailer', 'public void Send() { }'),
  'B/B.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../A/A.csproj" /></ItemGroup></Project>\n',
  'B/Invoice.cs': cls('Shop.B', 'Invoice', 'Ledger l;', 'using Shop.A;\n'),
  // A member nothing reads: the edge to Mailer is declared only.
  'B/Notify.cs': cls('Shop.B', 'Notify', '[Dependency]\n        public Mailer Mailer { get; set; }', 'using Shop.A;\n'),
  'web/a.js': "import { b } from './b.js';\nexport const a = () => b();\n",
  'web/b.js': "import { a } from './a.js';\nexport const b = () => a();\n",
  'web/api/c.js': 'export const c = 1;\n',
};

/** Every stored row of the current generation, kind by kind, in the order readers get them. */
function stored(ctx) {
  const at = rowsGeneration(ctx, Number(ctx.store.meta('generation')));
  const out = Object.fromEntries(DERIVED_KINDS.map((k) => [k, []]));
  for (const r of ctx.store.all("SELECT kind, key, body FROM derived WHERE generation = ? AND kind != '_done' ORDER BY rowid", at)) out[r.kind].push({ key: r.key, body: JSON.parse(r.body) });
  return out;
}

test('updated derived facts equal a full recompute of the changed graph, rows in the same order', async () => {
  const p = K.makeProject({ files });
  await mapRepository(p.ctx, { config: K.cfg({ mode: 'plan' }), configDigest: 'd', history: false });
  const { ctx } = p;
  const scc = stored(ctx).scc.find((r) => r.body.members.includes('module:A/Ledger.cs'));
  assert.equal(scc?.body.impossible_by_build, true, 'the fixture has a component the build forbids');
  assert.ok(stored(ctx).declared_only.some((r) => r.key === 'module:B/Notify.cs>module:A/Mailer.cs'), 'and a declared-only edge');
  assert.deepEqual(computeDerived(Graph.fromStore(ctx.store, { edgeTypes: DERIVED_EDGE_TYPES })), computeDerived(Graph.fromStore(ctx.store)), 'the edges derived facts read are enough');

  // Change node rows by hand, as projection would, and bring the derived facts forward.
  const change = (edits, edges = []) => {
    const generation = Number(ctx.store.meta('generation'));
    const nodes = new Map();
    for (const [id, edit] of Object.entries(edits)) {
      const before = ctx.store.get('SELECT * FROM nodes WHERE id = ?', id);
      const attrs = JSON.parse(before.attrs);
      edit(attrs);
      const after = { ...before, attrs: JSON.stringify(attrs) };
      ctx.store.run('UPDATE nodes SET attrs = ? WHERE id = ?', after.attrs, id);
      nodes.set(id, [before, after]);
    }
    for (const [type, src, dst] of edges) ctx.store.run("INSERT INTO edges(type, src, dst, attrs, label, fact_ids) VALUES (?, ?, ?, '{}', 'observed', '[]')", type, src, dst);
    assert.equal(updateDerived(ctx, { nodes, edges }, generation, generation + 1), true);
    ctx.store.meta('generation', generation + 1);
    const full = computeDerived(Graph.fromStore(ctx.store));
    assert.deepEqual(stored(ctx), Object.fromEntries(DERIVED_KINDS.map((k) => [k, full[k]])));
  };
  change({ 'module:A/Ledger.cs': (a) => { a.is_test = true; } });
  assert.equal(stored(ctx).scc.find((r) => r.key === scc.key).body.finding, false, 'with one non-test member left, the component is no finding');
  change({ 'module:A/Mailer.cs': (a) => { a.is_test = true; } });
  assert.equal(stored(ctx).declared_only.find((r) => r.key === 'module:B/Notify.cs>module:A/Mailer.cs').body.test, true);
  change({ 'module:web/a.js': (a) => { delete a.exports; a.is_test = true; }, 'module:A/Ledger.cs': (a) => { delete a.is_test; } });
  change({ 'module:web/a.js': (a) => { a.exports = [{ name: 'a' }, { name: 'z' }]; delete a.is_test; } });
  // A module leaves its layer and comes back (#245).
  change({ 'module:web/api/c.js': (a) => { a.is_test = true; } });
  assert.equal(stored(ctx).layers.find((r) => r.key === 'module:web/api/c.js'), undefined);
  change({ 'module:web/api/c.js': (a) => { delete a.is_test; } });
  assert.deepEqual(stored(ctx).layers.find((r) => r.key === 'module:web/api/c.js')?.body, { layer: 'presentation', index: 0, source: 'directory' });
  // Owners change with no change to the module's own row.
  change({}, [['OWNED_BY', 'module:web/b.js', 'team:@example/web']]);
  assert.deepEqual(stored(ctx).ownership.find((r) => r.key === 'module:web/b.js')?.body, { owners: ['team:@example/web'] });
});

test('a change to the import graph, a package or package containment is not brought forward', async () => {
  const p = K.makeProject({ files });
  await mapRepository(p.ctx, { config: K.cfg({ mode: 'plan' }), configDigest: 'd', history: false });
  const g = Number(p.ctx.store.meta('generation'));
  const pkg = p.ctx.store.get("SELECT * FROM nodes WHERE type = 'package' LIMIT 1");
  for (const delta of [
    { nodes: new Map(), edges: [['IMPORTS', 'module:web/a.js', 'module:web/b.js']] },
    { nodes: new Map(), edges: [['DEPENDS_ON', 'package:x', 'package:y']] },
    { nodes: new Map(), edges: [['CONTAINS', pkg.id, 'module:A/Ledger.cs']] },
    { nodes: new Map([[pkg.id, [pkg, pkg]]]), edges: [] },
  ]) assert.equal(updateDerived(p.ctx, delta, g, g + 1), false, JSON.stringify(delta.edges));
  assert.equal(updateDerived(p.ctx, { nodes: new Map(), edges: [] }, g, g + 1, layerSpec(['web/**', 'A/**'])), false, 'other layers than the stored ones');
});

test('a change to the configured layers rewrites the layers rows on the next map (#245)', async () => {
  const p = K.makeProject({ files });
  const layersOf = () => Object.fromEntries(stored(p.ctx).layers.map((r) => [r.key, `${r.body.layer}:${r.body.index}:${r.body.source}`]));
  const map = (layers) => mapRepository(p.ctx, { config: K.cfg({ mode: 'plan', ...(layers && { detectors: { 'module.layer-bypass': { layers } } }) }), configDigest: JSON.stringify(layers ?? null), history: false });
  const byDirectory = { 'module:web/a.js': 'presentation:0:directory', 'module:web/api/c.js': 'presentation:0:directory', 'module:web/b.js': 'presentation:0:directory' };
  await map();
  assert.deepEqual(layersOf(), byDirectory);
  await map([{ name: 'web', globs: ['web/**'] }, { name: 'core', glob: 'A/**' }]);
  assert.deepEqual(layersOf(), { 'module:A/Ledger.cs': 'core:1:configured', 'module:A/Mailer.cs': 'core:1:configured', 'module:web/a.js': 'web:0:configured', 'module:web/api/c.js': 'web:0:configured', 'module:web/b.js': 'web:0:configured' });
  await map();
  assert.deepEqual(layersOf(), byDirectory);
});
