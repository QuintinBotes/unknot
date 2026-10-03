import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRng, modularity, leiden, labelPropagation, partitionDistance, nmi, robustness, clusterMetrics,
} from '../../../runtime/graph/community.mjs';

// Zachary's karate club (1-indexed, 78 edges).
const KARATE_ADJ = {
  1: [2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 18, 20, 22, 32],
  2: [3, 4, 8, 14, 18, 20, 22, 31],
  3: [4, 8, 9, 10, 14, 28, 29, 33],
  4: [8, 13, 14],
  5: [7, 11],
  6: [7, 11, 17],
  7: [17],
  9: [31, 33, 34],
  10: [34],
  14: [34],
  15: [33, 34],
  16: [33, 34],
  19: [33, 34],
  20: [34],
  21: [33, 34],
  23: [33, 34],
  24: [26, 28, 30, 33, 34],
  25: [26, 28, 32],
  26: [32],
  27: [30, 34],
  28: [34],
  29: [32, 34],
  30: [33, 34],
  31: [33, 34],
  32: [33, 34],
  33: [34],
};
const name = (i) => `k${String(i).padStart(2, '0')}`;
function karate() {
  const edges = [];
  for (const [a, list] of Object.entries(KARATE_ADJ)) for (const b of list) edges.push({ a: name(a), b: name(b), w: 1 });
  return { nodes: Array.from({ length: 34 }, (_, i) => name(i + 1)), edges };
}

function clique(prefix, size, w = 1) {
  const nodes = Array.from({ length: size }, (_, i) => `${prefix}${i}`);
  const edges = [];
  for (let i = 0; i < size; i++) for (let j = i + 1; j < size; j++) edges.push({ a: nodes[i], b: nodes[j], w });
  return { nodes, edges };
}

function union(...parts) {
  return { nodes: parts.flatMap((p) => p.nodes), edges: parts.flatMap((p) => p.edges) };
}

function groups(partition) {
  const m = new Map();
  for (const [id, c] of partition) m.set(c, [...(m.get(c) ?? []), id]);
  return [...m.values()].map((v) => v.sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** True when every community induces a connected subgraph. */
function allConnected(input, partition) {
  const adj = new Map(input.nodes.map((n) => [n, []]));
  for (const { a, b } of input.edges) if (a !== b) { adj.get(a).push(b); adj.get(b).push(a); }
  for (const members of groups(partition)) {
    const set = new Set(members);
    const seen = new Set([members[0]]);
    const stack = [members[0]];
    while (stack.length) for (const u of adj.get(stack.pop())) if (set.has(u) && !seen.has(u)) { seen.add(u); stack.push(u); }
    if (seen.size !== members.length) return false;
  }
  return true;
}

test('karate fixture has the canonical 78 edges', () => {
  assert.equal(karate().edges.length, 78);
});

test('modularity: hand-checkable values', () => {
  // Two disjoint edges, each its own community: Q = 2 * (1/2 - (2/4)^2) = 0.5.
  const input = { nodes: ['a', 'b', 'c', 'd'], edges: [{ a: 'a', b: 'b', w: 1 }, { a: 'c', b: 'd', w: 1 }] };
  assert.ok(Math.abs(modularity(input, new Map([['a', 0], ['b', 0], ['c', 1], ['d', 1]])) - 0.5) < 1e-12);
  assert.ok(Math.abs(modularity(input, new Map([['a', 0], ['b', 0], ['c', 0], ['d', 0]]))) < 1e-12);
  // Resolution scales the null-model term: gamma = 2 gives 2 * (1/2 - 2 * 1/4) = 0.
  assert.ok(Math.abs(modularity(input, new Map([['a', 0], ['b', 0], ['c', 1], ['d', 1]]), 2)) < 1e-12);
});

test('leiden: karate club modularity above 0.37 and deterministic', () => {
  const input = karate();
  const r1 = leiden(input, { seed: 7 });
  const r2 = leiden(input, { seed: 7 });
  assert.ok(r1.quality > 0.37, `Q = ${r1.quality}`);
  assert.ok(Math.abs(r1.quality - modularity(input, r1.partition)) < 1e-12);
  assert.deepEqual([...r1.partition], [...r2.partition]);
  assert.equal(r1.quality, r2.quality);
  // Input order must not matter.
  const shuffled = { nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() };
  assert.deepEqual([...leiden(shuffled, { seed: 7 }).partition].sort(), [...r1.partition].sort());
  assert.ok(allConnected(input, r1.partition));
});

test('leiden: communities are numbered by smallest member', () => {
  const { partition } = leiden(karate());
  const firsts = groups(partition).map((g) => partition.get(g[0]));
  assert.deepEqual(firsts, firsts.map((_, i) => i));
});

test('leiden: ring of cliques recovers the cliques', () => {
  const cliques = Array.from({ length: 8 }, (_, i) => clique(`c${i}_`, 5));
  const edges = cliques.flatMap((c) => c.edges);
  for (let i = 0; i < 8; i++) edges.push({ a: `c${i}_0`, b: `c${(i + 1) % 8}_1`, w: 1 });
  const input = { nodes: cliques.flatMap((c) => c.nodes), edges };
  const { partition } = leiden(input);
  assert.deepEqual(groups(partition), cliques.map((c) => c.nodes).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
});

test('leiden: communities are always connected (Louvain bridge-node case)', () => {
  // A bridge node tied weakly to both halves: Louvain can strand it in a community it no
  // longer touches once its neighbours move away. Leiden's guarantee must hold for all seeds.
  const input = union(clique('l', 6), clique('r', 6), { nodes: ['bridge'], edges: [{ a: 'bridge', b: 'l0', w: 3 }, { a: 'bridge', b: 'r0', w: 3 }] });
  for (let seed = 1; seed <= 25; seed++) {
    const { partition } = leiden(input, { seed });
    assert.ok(allConnected(input, partition), `seed ${seed}`);
  }
  for (let seed = 1; seed <= 10; seed++) assert.ok(allConnected(karate(), leiden(karate(), { seed }).partition), `karate seed ${seed}`);
  // Disconnected input: components can never share a community.
  const split = union(clique('x', 4), clique('y', 4));
  const part = leiden(split).partition;
  assert.ok(allConnected(split, part));
  assert.notEqual(part.get('x0'), part.get('y0'));
});

test('leiden: resolution changes granularity, edge cases are safe', () => {
  const input = karate();
  const coarse = new Set(leiden(input, { resolution: 0.3 }).partition.values()).size;
  const fine = new Set(leiden(input, { resolution: 3 }).partition.values()).size;
  assert.ok(coarse < fine, `${coarse} vs ${fine}`);
  assert.equal(leiden({ nodes: [], edges: [] }).partition.size, 0);
  const lone = leiden({ nodes: ['a', 'b'], edges: [] });
  assert.deepEqual([...lone.partition], [['a', 0], ['b', 1]]);
  assert.throws(() => leiden({ nodes: ['a'], edges: [{ a: 'a', b: 'zz', w: 1 }] }), /unknown node/);
});

test('leiden: handles a graph with 3000 nodes quickly', () => {
  const rng = makeRng(5);
  const parts = Array.from({ length: 100 }, (_, i) => {
    const nodes = Array.from({ length: 30 }, (_, j) => `g${i}_${j}`);
    const edges = [];
    for (let a = 0; a < 30; a++) for (let b = a + 1; b < 30; b++) if (rng() < 0.3) edges.push({ a: nodes[a], b: nodes[b], w: 1 });
    for (let j = 1; j < 30; j++) edges.push({ a: nodes[j - 1], b: nodes[j], w: 1 }); // keep each group connected
    return { nodes, edges };
  });
  const input = union(...parts);
  for (let i = 0; i < 100; i++) input.edges.push({ a: `g${i}_0`, b: `g${(i + 1) % 100}_5`, w: 1 });
  const t0 = performance.now();
  const { partition, quality } = leiden(input);
  assert.ok(performance.now() - t0 < 5000);
  assert.ok(quality > 0.8, `Q = ${quality}`);
  assert.ok(allConnected(input, partition));
});

test('labelPropagation: deterministic and finds obvious clusters', () => {
  const input = union(clique('a', 6), clique('b', 6), { nodes: [], edges: [{ a: 'a0', b: 'b0', w: 0.1 }] });
  const p1 = labelPropagation(input, { seed: 3 });
  const p2 = labelPropagation(input, { seed: 3 });
  assert.deepEqual([...p1], [...p2]);
  assert.deepEqual(groups(p1).map((g) => g.length), [6, 6]);
  const k1 = labelPropagation(karate(), { seed: 11 });
  assert.deepEqual([...k1], [...labelPropagation(karate(), { seed: 11 })]);
  assert.deepEqual([...labelPropagation({ nodes: ['q'], edges: [] })], [['q', 0]]);
});

test('partitionDistance and nmi', () => {
  const p = new Map([['a', 0], ['b', 0], ['c', 1], ['d', 1], ['e', 2], ['f', 2]]);
  const relabelled = new Map([['a', 'x'], ['b', 'x'], ['c', 'y'], ['d', 'y'], ['e', 'z'], ['f', 'z']]);
  assert.equal(partitionDistance(p, relabelled), 0);
  assert.equal(nmi(p, relabelled), 1);
  // One node moves from community 2 to community 1: 1 of 6 changes.
  const moved = new Map(p).set('e', 1);
  assert.ok(Math.abs(partitionDistance(p, moved) - 1 / 6) < 1e-12);
  assert.equal(partitionDistance(p, moved), partitionDistance(moved, p));
  assert.ok(nmi(p, moved) < 1 && nmi(p, moved) > 0);
  // Everything in one community versus three: independent, NMI 0; best match keeps 2 of 6.
  const one = new Map([...p.keys()].map((k) => [k, 0]));
  assert.equal(nmi(p, one), 0);
  assert.ok(Math.abs(partitionDistance(p, one) - 4 / 6) < 1e-12);
  assert.equal(nmi(one, one), 1);
});

test('robustness: planted clusters are robust, a noise region is not', () => {
  const planted = [clique('A', 8, 5), clique('B', 8, 5), clique('C', 8, 5)];
  const edges = planted.flatMap((c) => c.edges);
  edges.push({ a: 'A0', b: 'B0', w: 0.1 }, { a: 'B1', b: 'C1', w: 0.1 }, { a: 'C2', b: 'A2', w: 0.1 });
  const noiseNodes = Array.from({ length: 60 }, (_, i) => `N${String(i).padStart(2, '0')}`);
  const rng = makeRng(99);
  for (let i = 0; i < 60; i++) for (let j = i + 1; j < 60; j++) if (rng() < 0.07) edges.push({ a: noiseNodes[i], b: noiseNodes[j], w: 5 });
  edges.push({ a: 'N00', b: 'A5', w: 0.1 });
  const input = { nodes: [...planted.flatMap((c) => c.nodes), ...noiseNodes], edges };

  const res = robustness(input, { seed: 1 });
  const again = robustness(input, { seed: 1 });
  assert.deepEqual(res.communities, again.communities);

  for (const c of res.communities) {
    const isPlanted = c.members.every((m) => /^[ABC]\d$/.test(m));
    // Singletons (isolated noise nodes) are trivially stable, so only real regions count.
    const isNoise = c.members.length >= 3 && c.members.every((m) => m.startsWith('N'));
    if (isPlanted) assert.ok(c.robust && c.stability === 1, `planted ${c.members}`);
    if (isNoise) assert.ok(!c.robust, `noise ${c.members} stability ${c.stability}`);
  }
  assert.ok(res.communities.some((c) => c.members.length >= 3 && c.members.every((m) => m.startsWith('N')) && !c.robust));
  assert.ok(res.communities.some((c) => c.robust));
  assert.ok(res.communities.some((c) => !c.robust));
  assert.equal(res.stats.communities, res.communities.length);
  assert.equal(res.runs.length, 4 + 1 + 5);
});

test('clusterMetrics: cohesion, volume, coupling, modularity', () => {
  const input = { nodes: ['a', 'b', 'c', 'd'], edges: [{ a: 'a', b: 'b', w: 3 }, { a: 'c', b: 'd', w: 2 }, { a: 'b', b: 'c', w: 1 }] };
  const part = new Map([['a', 0], ['b', 0], ['c', 1], ['d', 1]]);
  const m = clusterMetrics(input, part);
  const [c0, c1] = m.clusters;
  assert.deepEqual([c0.size, c0.internal, c0.external, c0.volume], [2, 3, 1, 7]);
  assert.deepEqual([c1.size, c1.internal, c1.external, c1.volume], [2, 2, 1, 5]);
  assert.equal(c0.cohesion, 3 / 4);
  assert.equal(c1.cohesion, 2 / 3);
  assert.deepEqual(m.coupling, [{ a: 0, b: 1, weight: 1, coupling: 1 / 5 }]);
  assert.ok(Math.abs(m.modularity - modularity(input, part)) < 1e-12);
  assert.equal(c0.sizeFlag, 'nano');
});
