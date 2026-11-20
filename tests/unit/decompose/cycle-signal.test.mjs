// A candidate's cycle signal is its own part in a cycle (#73): the boundary edges that lie on a
// cycle once the candidate is collapsed to one node, not the size of the component it touches.

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');
const { boundaryMetrics } = await import('../../../runtime/decompose/candidates.mjs');
const { sccsOf } = await import('../../../runtime/graph/derived.mjs');

const p = prov({ source_type: 'ast', extractor: 'test@1.0.0' });
const mod = (path) => nodeFact('module', path, { path, attrs: {} }, p);
const imp = (a, b) => edgeFact('IMPORTS', `module:${a}`, `module:${b}`, {}, p);
const id = (a, b) => `IMPORTS|module:${a}|module:${b}`;

// A ring of 200 files (one strongly connected component), and two candidates that join it through different edges.
function world(extra = []) {
  const ring = Array.from({ length: 200 }, (_, i) => `r/r${i}.ts`);
  return Graph.fromFacts([
    ...ring.map(mod), ...['c/a.ts', 'c/b.ts', 'd/x.ts', 'e/solo.ts', 'f/a.ts', 'f/b.ts'].map(mod),
    ...ring.map((r, i) => imp(r, ring[(i + 1) % ring.length])),
    imp('c/a.ts', 'r/r0.ts'), imp('r/r100.ts', 'c/b.ts'), imp('c/b.ts', 'c/a.ts'),
    imp('d/x.ts', 'r/r50.ts'), imp('r/r150.ts', 'd/x.ts'),
    imp('e/solo.ts', 'r/r10.ts'),
    imp('f/a.ts', 'f/b.ts'), imp('f/b.ts', 'f/a.ts'),
    ...extra,
  ]);
}
const measure = (g, members) => boundaryMetrics(g, new Set(members.map((m) => `module:${m}`)), { tableOwners: new Map(), sccs: sccsOf(g).map((c) => c.members), candidateOf: () => null, self: 0 });

test('scenario 1: a candidate on a 200-file cycle through two boundary edges reports and cites those 2 edges', () => {
  const { metrics, details } = measure(world(), ['c/a.ts', 'c/b.ts']);
  assert.equal(metrics['cycle.boundary_edges'], 2);
  assert.deepEqual(details.evidence['cycle.boundary_edges'], [id('c/a.ts', 'r/r0.ts'), id('r/r100.ts', 'c/b.ts')]);
});

test('scenario 2: two candidates joining one component through different edges cite disjoint evidence', () => {
  const g = world();
  const c = measure(g, ['c/a.ts', 'c/b.ts']).details.evidence['cycle.boundary_edges'];
  const d = measure(g, ['d/x.ts']).details.evidence['cycle.boundary_edges'];
  assert.deepEqual(d, [id('d/x.ts', 'r/r50.ts'), id('r/r150.ts', 'd/x.ts')]);
  assert.equal(c.filter((e) => d.includes(e)).length, 0);
});

test('scenario 3: growing the far side of the component changes no signal or evidence of a candidate it does not touch', () => {
  const before = measure(world(), ['c/a.ts', 'c/b.ts']);
  const far = Array.from({ length: 40 }, (_, i) => `z/z${i}.ts`);
  const after = measure(world([...far.map(mod), ...far.map((z, i) => imp(`r/r${i + 120}.ts`, z)), ...far.map((z, i) => imp(z, `r/r${i + 121}.ts`))]), ['c/a.ts', 'c/b.ts']);
  assert.ok(after.metrics['cycle.crossing_size'] > before.metrics['cycle.crossing_size'], 'the component itself grew');
  assert.equal(after.metrics['cycle.boundary_edges'], 2);
  assert.equal(before.metrics['cycle.boundary_edges'], 2);
  assert.deepEqual(after.details.evidence['cycle.boundary_edges'], before.details.evidence['cycle.boundary_edges']);
});

test('scenario 4: a candidate on no cycle through files outside it has a cycle signal of 0', () => {
  const { metrics } = measure(world(), ['e/solo.ts']);
  assert.equal(metrics['cycle.boundary_edges'], 0);
});

test('scenario 5: a cycle wholly inside the candidate is its internal cycle size, not a boundary signal', () => {
  const { metrics } = measure(world(), ['f/a.ts', 'f/b.ts']);
  assert.equal(metrics['cycle.boundary_edges'], 0);
  assert.equal(metrics['boundary.internal_cycle_size'], 2);
});

test('a candidate in two components counts each of its boundary edges on a cycle once', () => {
  const ring2 = ['s/s0.ts', 's/s1.ts'];
  const g = world([...ring2.map(mod), imp('s/s0.ts', 's/s1.ts'), imp('s/s1.ts', 's/s0.ts'), imp('d/x.ts', 's/s0.ts'), imp('s/s1.ts', 'd/x.ts'), imp('d/x.ts', 'r/r60.ts')]);
  const { metrics, details } = measure(g, ['d/x.ts']);
  assert.equal(metrics['cycle.boundary_edges'], 5);
  assert.equal(new Set(details.evidence['cycle.boundary_edges']).size, 5);
});

test('a path out and back in through different members is a cycle of the collapsed candidate', () => {
  const g = Graph.fromFacts([...['k/a.ts', 'k/b.ts', 'o/o.ts'].map(mod), imp('k/a.ts', 'o/o.ts'), imp('o/o.ts', 'k/b.ts')]);
  const { metrics } = measure(g, ['k/a.ts', 'k/b.ts']);
  assert.equal(metrics['cycle.boundary_edges'], 2);
});

test('FR-004: treatment selection reads the boundary-edge signal, never the size of the component', async () => {
  const { selectTreatment } = await import('../../../runtime/decompose/select.mjs');
  const base = {
    'tests.present': 3, 'boundary.robust': 1, 'boundary.shared_table_writers': 0, 'boundary.cross_joins': 0,
    'boundary.cross_transactions': 0, 'ownership.alignment': 0.95, 'module.co_change_leak': 0.05, 'boundary.outbound_dependencies': 0,
    'boundary.calls_per_request_p95': 1, 'requests.interceptable': 1, 'traces.available': 1, 'layer.violations': 0,
    'boundary.interface_count': 3, 'boundary.size': 8, 'owners.count': 1, 'contracts.present': 1, 'driver.any': 0,
  };
  const pick = (signals) => selectTreatment({ target: 'backend', signals: { ...base, ...signals }, drivers: [] });
  const huge = pick({ 'cycle.size': 1753, 'cycle.crossing_size': 1753, 'cycle.boundary_edges': 0 });
  const tangled = pick({ 'cycle.size': 0, 'cycle.crossing_size': 0, 'cycle.boundary_edges': 2 });
  assert.equal(huge.treatment, pick({ 'cycle.size': 0, 'cycle.crossing_size': 0, 'cycle.boundary_edges': 0 }).treatment);
  assert.equal(tangled.treatment, 'T1');
  assert.ok(tangled.favoring_signals.some((s) => s.signal === 'cycle.boundary_edges'), JSON.stringify(tangled.favoring_signals));
  assert.ok(!huge.favoring_signals.some((s) => /^cycle\./.test(s.signal)));
});
