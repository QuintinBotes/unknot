// Golden repository (e): polyglot monorepo — Go service, Python worker, TS frontend with
// routes and a store shared across features.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, assertKinds, assertWellFormed, ofKind } from './_harness.mjs';

const { decompose } = await import('../../runtime/decompose/index.mjs');
const { Graph } = await import('../../runtime/graph/graph.mjs');

const r = await analyse('polyglot-monorepo', { config: { detectors: { 'frontend.cross-feature-imports': { min_imports: 2 } } } });

test('polyglot monorepo: map is complete, all three languages are recognised', () => {
  assert.equal(r.mapped.status, 'complete');
  assert.deepEqual(r.errors, []);
  const g = Graph.fromStore(r.ctx.store);
  const langs = new Set(g.nodes('module').map((m) => m.attrs.language));
  for (const l of ['go', 'python']) assert.ok(langs.has(l), `language ${l} mapped; got ${[...langs].join(', ')}`);
  assert.ok([...langs].some((l) => l === 'typescript' || l === 'javascript'));
  assert.ok(g.nodes('route').length >= 3, 'frontend routes are recognised');
});

test('polyglot monorepo: expected finding kinds', () => {
  assertKinds(r.findings, ['frontend.cross-feature-imports']);
  const f = ofKind(r.findings, 'frontend.cross-feature-imports');
  assert.ok(f.some((x) => x.scope.some((p) => p.includes('features/user/'))));
});

test('polyglot monorepo: expected non-findings', () => {
  const have = new Set(r.findings.map((f) => f.kind));
  for (const k of ['service.distributed-monolith', 'database.multiple-writers', 'module.dependency-cycle', 'infrastructure.privileged-workloads', 'frontend.mfe-lockstep-release', 'frontend.mega-frontend']) assert.ok(!have.has(k), `unexpected ${k}`);
});

test('polyglot monorepo: evidence provenance, retain alternative and risk sanity', () => {
  assertWellFormed(r.findings);
  for (const f of r.findings) assert.equal(f.risk, 'low');
});

test('polyglot monorepo: no service extraction or micro-frontend without a driver', async () => {
  const d = await decompose(r.ctx, { config: r.config });
  assert.ok(d.targets.includes('frontend'));
  for (const rec of d.details) {
    assert.deepEqual(rec.driver, []);
    assert.ok(!['T3', 'T7'].includes(rec.treatment), `${rec.treatment} not offered without a driver`);
    assert.ok(rec.rejected_treatments.length > 0 && rec.rejected_treatments.every((x) => x.reason.length > 0));
  }
  const fe = d.details.find((x) => x.target === 'frontend');
  assert.ok(fe.rejected_treatments.some((x) => x.treatment === 'T7' && /driver/.test(x.reason)), 'T7 rejected for lack of a driver');
});

test('polyglot monorepo: with independent_deploy the frontend still needs evidence before T7 or T3', async () => {
  const d = await decompose(r.ctx, { config: r.config, drivers: ['independent_deploy'] });
  for (const rec of d.details) {
    assert.deepEqual(rec.driver, ['independent_deploy']);
    assert.ok(!['T3', 'T7'].includes(rec.treatment), `${rec.treatment} needs teams, navigation and pipeline evidence that is absent`);
    assert.ok(rec.evidence_gaps.length > 0);
  }
  const fe = d.details.find((x) => x.target === 'frontend');
  assert.ok(fe.rejected_treatments.some((x) => x.treatment === 'T7' && /evidence missing: /.test(x.reason)));
});
