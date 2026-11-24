// FR-003 (#89): decompose reads the graph into memory once and answers per-type edge queries
// from an index, not by scanning every edge on each call. Counts scans, never wall time.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { analyse } from '../../golden/_harness.mjs';

const { decompose } = await import('../../../runtime/decompose/index.mjs');
const { Graph } = await import('../../../runtime/graph/graph.mjs');

const legacyEdges = function (type) {
  const all = [...this.edgeMap.values()];
  return type ? all.filter((e) => e.type === type) : all;
};

/** Run decompose; count the full passes over the edge map and the stores read into a graph. */
async function run(r, { legacy = false } = {}) {
  const fromStore = Graph.fromStore;
  const edges = Graph.prototype.edges;
  const counts = { scans: 0, loads: 0 };
  Graph.fromStore = (store) => {
    counts.loads++;
    const g = fromStore.call(Graph, store);
    const values = g.edgeMap.values.bind(g.edgeMap);
    g.edgeMap.values = () => { counts.scans++; return values(); };
    return g;
  };
  if (legacy) Graph.prototype.edges = legacyEdges;
  try {
    const res = await decompose(r.ctx, { config: r.config, dryRun: true });
    return { res, counts };
  } finally {
    Graph.fromStore = fromStore;
    Graph.prototype.edges = edges;
  }
}

describe('decompose reads edges through an index', () => {
  test('results are identical to the full-scan reads, with far fewer scans and one load', async () => {
    const r = await analyse('modular-monolith', { skipDiagnose: true });
    const before = await run(r, { legacy: true });
    const after = await run(r);
    assert.deepEqual(after.res, before.res);
    assert.ok(after.res.details.length >= 1);
    assert.equal(after.counts.loads, 1);
    assert.ok(before.counts.scans > 10, `legacy scans ${before.counts.scans}`);
    assert.ok(after.counts.scans <= 1, `indexed scans ${after.counts.scans}`);
  });

  test('edges(type) keeps insertion order and the untyped call returns every edge', () => {
    const g = Graph.fromFacts([
      { kind: 'node', id: 'a', type: 'module' }, { kind: 'node', id: 'b', type: 'module' },
      { kind: 'edge', type: 'IMPORTS', from: 'a', to: 'b' }, { kind: 'edge', type: 'CALLS', from: 'b', to: 'a' }, { kind: 'edge', type: 'IMPORTS', from: 'b', to: 'a' },
    ]);
    assert.deepEqual(g.edges('IMPORTS').map((e) => e.from), ['a', 'b']);
    assert.equal(g.edges().length, 3);
    assert.deepEqual(g.edges('NOPE'), []);
  });
});
