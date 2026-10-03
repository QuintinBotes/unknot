import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../../../runtime/graph/graph.mjs';
import {
  stronglyConnected, shortestCycle, impactCone, fanIn, fanOut, instability, condense, hubs, topoOrder,
} from '../../../runtime/graph/algorithms.mjs';

function graphOf(edges, type = 'module') {
  const g = new Graph();
  for (const [a, b] of edges) {
    g.addNode(a, type);
    g.addNode(b, type);
    g.addEdge('IMPORTS', a, b);
  }
  return g;
}

test('stronglyConnected: self-loop, two SCCs, DAG parts ignored', () => {
  const g = graphOf([['a', 'b'], ['b', 'c'], ['c', 'a'], ['x', 'y'], ['y', 'x'], ['c', 'd'], ['s', 's'], ['d', 'e']]);
  assert.deepEqual(stronglyConnected(g), [['a', 'b', 'c'], ['s'], ['x', 'y']]);
});

test('stronglyConnected: diamond has no cycle', () => {
  const g = graphOf([['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]);
  assert.deepEqual(stronglyConnected(g), []);
});

test('stronglyConnected: respects edgeTypes and nodeTypes', () => {
  const g = graphOf([['a', 'b'], ['b', 'a']]);
  g.addNode('f', 'file');
  g.addEdge('CALLS', 'a', 'f');
  g.addEdge('CALLS', 'f', 'a');
  assert.deepEqual(stronglyConnected(g, { edgeTypes: ['CALLS'] }), [['a', 'f']]);
  assert.deepEqual(stronglyConnected(g, { nodeTypes: ['file'] }), []);
});

test('stronglyConnected: 200k-node chain, iteratively and fast', () => {
  const g = new Graph();
  const n = 200000;
  for (let i = 0; i < n; i++) g.addNode(`n${String(i).padStart(6, '0')}`, 'module');
  for (let i = 0; i < n - 1; i++) g.addEdge('IMPORTS', `n${String(i).padStart(6, '0')}`, `n${String(i + 1).padStart(6, '0')}`);
  const t0 = performance.now();
  assert.deepEqual(stronglyConnected(g), []);
  assert.ok(performance.now() - t0 < 2000, `took ${performance.now() - t0}ms`);
  // Closing the chain into one giant ring must yield a single component.
  g.addEdge('IMPORTS', `n${String(n - 1).padStart(6, '0')}`, 'n000000');
  const sccs = stronglyConnected(g);
  assert.equal(sccs.length, 1);
  assert.equal(sccs[0].length, n);
});

test('shortestCycle: finds the shortest, handles self-loop', () => {
  const g = graphOf([['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['b', 'a']]);
  assert.deepEqual(shortestCycle(g, ['a', 'b', 'c', 'd']), ['a', 'b']);
  const loop = graphOf([['s', 's']]);
  assert.deepEqual(shortestCycle(loop, ['s']), ['s']);
  const ring = graphOf([['a', 'b'], ['b', 'c'], ['c', 'a']]);
  assert.deepEqual(shortestCycle(ring, ['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('impactCone: direction and maxDepth', () => {
  const g = graphOf([['a', 'b'], ['b', 'c'], ['c', 'd'], ['x', 'c']]);
  assert.deepEqual([...impactCone(g, ['c'])].sort(), [['a', 2], ['b', 1], ['c', 0], ['x', 1]]);
  assert.deepEqual([...impactCone(g, ['c'], { maxDepth: 1 })].sort(), [['b', 1], ['c', 0], ['x', 1]]);
  assert.deepEqual([...impactCone(g, ['b'], { direction: 'out' })].sort(), [['b', 0], ['c', 1], ['d', 2]]);
});

test('fanIn / fanOut count distinct neighbours and skip self-loops', () => {
  const g = graphOf([['a', 'c'], ['b', 'c'], ['c', 'd'], ['c', 'c']]);
  assert.equal(fanIn(g, 'c'), 2);
  assert.equal(fanOut(g, 'c'), 1);
});

test('instability: Martin I at package granularity', () => {
  const g = graphOf([['p/a', 'q/x'], ['p/b', 'q/x'], ['q/x', 'r/z'], ['p/a', 'p/b']]);
  const group = (id) => id.split('/')[0];
  const res = instability(g, null, ['IMPORTS'], group);
  assert.deepEqual(res.get('p'), { ca: 0, ce: 1, instability: 1 });
  assert.deepEqual(res.get('q'), { ca: 2, ce: 1, instability: 1 / 3 });
  assert.deepEqual(res.get('r'), { ca: 1, ce: 0, instability: 0 });
});

test('condense: counts between groups, intra-group edges tallied', () => {
  const g = graphOf([['p/a', 'q/x'], ['p/b', 'q/x'], ['p/a', 'p/b'], ['q/x', 'p/a']]);
  const c = condense(g, (id) => id.split('/')[0]);
  assert.equal(c.edges().length, 2);
  assert.equal(c.edges().find((e) => e.from === 'p' && e.to === 'q').attrs.count, 2);
  assert.equal(c.edges().find((e) => e.from === 'q' && e.to === 'p').attrs.count, 1);
  assert.equal(c.node('p').attrs.internal, 1);
});

test('hubs: thresholds and order', () => {
  const g = new Graph();
  for (let i = 0; i < 5; i++) g.addNode(`m${i}`, 'module');
  g.addNode('hub', 'module');
  for (let i = 0; i < 5; i++) g.addEdge('IMPORTS', `m${i}`, 'hub');
  g.addEdge('IMPORTS', 'hub', 'm0');
  assert.deepEqual(hubs(g, { minFanIn: 5, minFanOut: 99 }), [{ id: 'hub', fanIn: 5, fanOut: 1 }]);
  assert.deepEqual(hubs(g, { minFanIn: 99, minFanOut: 99 }), []);
});

test('topoOrder: deterministic order, dedup, unknown node', () => {
  const order = topoOrder(['c', 'a', 'b', 'd'], [{ from: 'a', to: 'c' }, ['b', 'c'], ['a', 'c'], ['c', 'd']]);
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
  assert.throws(() => topoOrder(['a'], [['a', 'z']]), /unknown node/);
});

test('topoOrder: throws with the cycle named', () => {
  assert.throws(
    () => topoOrder(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'b'], ['c', 'd']]),
    (err) => {
      assert.deepEqual([...err.cycle].sort(), ['b', 'c']);
      assert.match(err.message, /cycle detected: (b -> c -> b|c -> b -> c)/);
      return true;
    },
  );
});
