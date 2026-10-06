import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../../../runtime/graph/graph.mjs';
import {
  stronglyConnected, shortestCycle, cycleBreakdown, impactCone, fanIn, fanOut, instability, condense, hubs, topoOrder,
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

test('rankHubs ranks modules by distinct importers and imports', async () => {
  const { rankHubs } = await import('../../../runtime/graph/algorithms.mjs');
  const { Graph } = await import('../../../runtime/graph/graph.mjs');
  const g = new Graph();
  for (const id of ['a', 'b', 'c', 'u']) g.addNode(`module:${id}`, 'module', { name: id });
  for (const [f, t] of [['a', 'u'], ['b', 'u'], ['c', 'u'], ['a', 'u'], ['a', 'b'], ['u', 'u']]) g.addEdge('IMPORTS', `module:${f}`, `module:${t}`);
  const h = rankHubs(g, { limit: 2 });
  assert.deepEqual(h.fan_in[0], { id: 'module:u', n: 3 });
  assert.deepEqual(h.fan_out[0], { id: 'module:a', n: 2 });
});

test('rankHubs: package-level imports are not fan-in of a file but still count as its fan-out', async () => {
  const { rankHubs } = await import('../../../runtime/graph/algorithms.mjs');
  const { Graph } = await import('../../../runtime/graph/graph.mjs');
  const g = new Graph();
  for (const id of ['a', 'b', 'u']) g.addNode(`module:${id}`, 'module', { name: id });
  g.addEdge('IMPORTS', 'module:a', 'module:u', { package_level: true });
  g.addEdge('IMPORTS', 'module:b', 'module:u');
  const h = rankHubs(g);
  assert.deepEqual(h.fan_in, [{ id: 'module:u', n: 1 }]);
  assert.equal(h.fan_out.find((x) => x.id === 'module:a').n, 1);
});

test('rankHubs: several edge types are a union, a node filter ranks accepted nodes, within counts only accepted neighbours', async () => {
  const { rankHubs } = await import('../../../runtime/graph/algorithms.mjs');
  const { Graph } = await import('../../../runtime/graph/graph.mjs');
  const g = new Graph();
  for (const id of ['a', 'b', 'c', 'u']) g.addNode(`module:${id}`, 'module', { name: id });
  g.addEdge('IMPORTS', 'module:a', 'module:u');
  g.addEdge('CALLS', 'module:a', 'module:u');
  g.addEdge('CALLS', 'module:b', 'module:u');
  g.addEdge('IMPORTS', 'module:c', 'module:u');
  g.addEdge('IMPORTS', 'module:u', 'module:a');
  assert.equal(rankHubs(g, {}).fan_in[0].n, 2);
  const union = rankHubs(g, { edgeTypes: ['IMPORTS', 'CALLS'] });
  assert.deepEqual(union.fan_in[0], { id: 'module:u', n: 3 });
  assert.equal(union.edge_type, 'IMPORTS,CALLS');
  const inScope = (n) => ['module:u', 'module:a'].includes(n.id);
  const scoped = rankHubs(g, { edgeTypes: ['IMPORTS', 'CALLS'], nodeFilter: inScope });
  assert.deepEqual(scoped.fan_in.map((x) => x.id), ['module:u', 'module:a']);
  assert.equal(scoped.fan_in[0].n, 3);
  assert.deepEqual(rankHubs(g, { edgeTypes: ['IMPORTS', 'CALLS'], nodeFilter: inScope, within: true }).fan_in[0], { id: 'module:a', n: 1 });
});

test('stronglyConnected: a node filter finds cycles of the subgraph only', () => {
  const g = graphOf([['a', 'b'], ['b', 'a'], ['b', 'c'], ['c', 'b'], ['x', 'y'], ['y', 'x']]);
  assert.deepEqual(stronglyConnected(g, { nodeFilter: (n) => n.id !== 'c' }), [['a', 'b'], ['x', 'y']]);
  assert.deepEqual(stronglyConnected(g, { nodeFilter: (n) => ['a', 'c'].includes(n.id) }), []);
});

test('resolveRef and neighbourhood: ids, module paths, declared types and bounded breadth-first walks', async () => {
  const { resolveRef, neighbourhood } = await import('../../../runtime/graph/algorithms.mjs');
  const g = new Graph();
  g.addNode('module:src/x.cs', 'module', { path: 'src/x.cs', attrs: { types: ['Widget'] } });
  g.addNode('module:src/y.cs', 'module', { path: 'src/y.cs' });
  g.addNode('module:src/z.cs', 'module', { path: 'src/z.cs' });
  g.addEdge('IMPORTS', 'module:src/x.cs', 'module:src/y.cs');
  g.addEdge('CALLS', 'module:src/y.cs', 'module:src/z.cs');
  assert.deepEqual(resolveRef(g, 'module:src/x.cs'), ['module:src/x.cs']);
  assert.deepEqual(resolveRef(g, 'src/x.cs'), ['module:src/x.cs']);
  assert.deepEqual(resolveRef(g, 'Widget'), ['module:src/x.cs']);
  assert.deepEqual(resolveRef(g, 'y'), ['module:src/y.cs']);
  assert.deepEqual(resolveRef(g, 'Nope'), []);
  assert.equal(neighbourhood(g, ['module:src/x.cs'], { depth: 1 }).nodes.length, 2);
  assert.equal(neighbourhood(g, ['module:src/x.cs'], { depth: 2 }).nodes.length, 3);
  assert.equal(neighbourhood(g, ['module:src/x.cs'], { depth: 2, edgeTypes: ['CALLS'] }).nodes.length, 1);
  assert.equal(neighbourhood(g, ['module:src/x.cs'], { depth: 2, nodeCap: 2 }).capped, true);
});

test('cycleBreakdown: elementary cycles shortest first, cut set breaks them all', () => {
  const g = graphOf([['a', 'b'], ['b', 'a'], ['b', 'c'], ['c', 'a'], ['c', 'd'], ['d', 'c']]);
  const r = cycleBreakdown(g, ['a', 'b', 'c', 'd']);
  assert.deepEqual(r.cycles.map((c) => c.nodes), [['a', 'b'], ['c', 'd'], ['a', 'b', 'c']]);
  assert.equal(r.truncated, false);
  const cutKeys = new Set(r.cut.map((e) => `${e.from}>${e.to}`));
  const rest = graphOf([]);
  for (const id of ['a', 'b', 'c', 'd']) rest.addNode(id, 'module');
  for (const e of g.edges('IMPORTS')) if (!cutKeys.has(`${e.from}>${e.to}`)) rest.addEdge('IMPORTS', e.from, e.to);
  assert.deepEqual(stronglyConnected(rest), []);
});

test('cycleBreakdown: declared-only edges are cut first and marked', () => {
  const g = graphOf([['a', 'b'], ['b', 'c']]);
  g.addEdge('IMPORTS', 'c', 'a', { declared_only: true, unused_member: 'Foo', line: 7 });
  const r = cycleBreakdown(g, ['a', 'b', 'c']);
  assert.deepEqual(r.cut.map((e) => [e.from, e.to, e.declared_only, e.unused_member]), [['c', 'a', true, 'Foo']]);
  assert.equal(r.cycles[0].edges.find((e) => e.from === 'c').declared_only, true);
  assert.equal(r.cycles[0].edges.find((e) => e.from === 'a').declared_only, false);
});

test('cycleBreakdown: caps the cycle list and says so', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const g = graphOf(ids.flatMap((x) => ids.filter((y) => y !== x).map((y) => [x, y])));
  const r = cycleBreakdown(g, ids, { maxCycles: 6 });
  assert.equal(r.cycles.length, 6);
  assert.equal(r.truncated, true);
  assert.ok(r.cycles.every((c, i, l) => !i || l[i - 1].length <= c.length));
  assert.ok(r.cut.length >= 4);
});
