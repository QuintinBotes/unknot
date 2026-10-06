// explainRef: resolve with notes and suggestions

import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'uk-explainref-home-'));
const proj = mkdtempSync(join(tmpdir(), 'uk-explainref-proj-'));

const { openProject } = await import('../../../runtime/context.mjs');
const { project } = await import('../../../runtime/graph/builder.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');
const { explainRef } = await import('../../../runtime/graph/algorithms.mjs');
const { Graph } = await import('../../../runtime/graph/graph.mjs');

const p = prov({ source_type: 'ast', source_ref: 'x:1', extractor: 'test' });
const mod = (path, extra = {}) => nodeFact('module', path, { name: path.split('/').pop(), path, attrs: extra }, p);
const imp = (a, b) => edgeFact('IMPORTS', `module:${a}`, `module:${b}`, {}, p);

before(() => {
  process.env.UNKNOT_HOME = home;
  const ctx = openProject(proj, { create: true });
  project(
    ctx,
    [
      mod('src/cat/A.cs', { types: ['Alpha'] }),
      mod('src/cat/B.cs'),
      mod('src/cat/C.cs'),
      mod('src/ord/X.cs'),
      mod('src/ord/Y.cs'),
      imp('src/cat/A.cs', 'src/cat/B.cs'),
      imp('src/cat/B.cs', 'src/cat/A.cs'),
    ],
    { commit: 'abc123', observedAt: '2026-01-01T00:00:00Z' },
  );
  ctx.store.close();
});

const getGraph = () => {
  const ctx = openProject(proj);
  const g = Graph.fromStore(ctx.store);
  ctx.store.close();
  return g;
};

test('resolves exact id', () => {
  const g = getGraph();
  const r = explainRef(g, 'module:src/cat/A.cs');
  assert.deepEqual(r.ids, ['module:src/cat/A.cs']);
  assert.equal(r.note, undefined);
  assert.deepEqual(r.suggestions, []);
});

test('resolves path without module: prefix', () => {
  const g = getGraph();
  const r = explainRef(g, 'src/cat/A.cs');
  assert.deepEqual(r.ids, ['module:src/cat/A.cs']);
  assert.equal(r.note, undefined);
  assert.deepEqual(r.suggestions, []);
});

test('resolves declared type name', () => {
  const g = getGraph();
  const r = explainRef(g, 'Alpha');
  assert.deepEqual(r.ids, ['module:src/cat/A.cs']);
  assert.equal(r.note, undefined);
  assert.deepEqual(r.suggestions, []);
});

test('unknown prefix resolves with a note', () => {
  const g = getGraph();
  const r = explainRef(g, 'file:src/cat/A.cs');
  assert.deepEqual(r.ids, ['module:src/cat/A.cs']);
  assert.equal(r.note, 'treated file:src/cat/A.cs as module:src/cat/A.cs');
  assert.deepEqual(r.suggestions, []);
});

test('unknown prefix with type: also resolves with a note', () => {
  const g = getGraph();
  const r = explainRef(g, 'type:Alpha');
  assert.deepEqual(r.ids, ['module:src/cat/A.cs']);
  assert.equal(r.note, 'treated type:Alpha as module:src/cat/A.cs');
  assert.deepEqual(r.suggestions, []);
});

test('no match returns empty ids and up to 3 suggestions by edit distance', () => {
  const g = getGraph();
  const r = explainRef(g, 'src/cat/AA.cs');
  assert.deepEqual(r.ids, []);
  assert.equal(r.note, undefined);
  assert.ok(r.suggestions.length <= 3);
  assert.ok(r.suggestions.some(s => s.includes('src/cat/A.cs')));
});

test('suggestions include module: prefix', () => {
  const g = getGraph();
  const r = explainRef(g, 'src/ord/XX.cs');
  assert.deepEqual(r.ids, []);
  assert.ok(r.suggestions.every(s => s.startsWith('module:')));
});

test('suggestions only for similar-length paths', () => {
  const g = getGraph();
  const r = explainRef(g, 'ab');
  // A very short path should not suggest much longer paths
  assert.ok(!r.suggestions.some(s => s.length > 30));
});
