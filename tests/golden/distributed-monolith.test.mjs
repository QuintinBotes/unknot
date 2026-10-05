// Golden repository (c): distributed monolith — three services, one compose file, one shared
// table written by all, one pipeline deploying them together, a trace showing a call cycle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, assertKinds, assertWellFormed, ofKind } from './_harness.mjs';

const { decompose } = await import('../../runtime/decompose/index.mjs');

const r = await analyse('distributed-monolith', { config: { evidence: { traces: ['traces/otlp.json'] } } });

test('distributed monolith: map is complete and detectors run cleanly', () => {
  assert.equal(r.mapped.status, 'complete');
  assert.deepEqual(r.errors, []);
});

test('distributed monolith: expected finding kinds', () => {
  assertKinds(r.findings, ['service.distributed-monolith', 'service.shared-database', 'database.multiple-writers', 'delivery.lockstep-deployables']);
});

test('distributed monolith: the finding names all three services, the cycle and the shared table', () => {
  const f = ofKind(r.findings, 'service.distributed-monolith')[0];
  for (const s of ['orders', 'billing', 'shipping']) assert.ok(f.scope.some((p) => p.includes(s)), `scope covers ${s}`);
  const text = f.evidence.map((e) => e.summary).join('\n');
  assert.match(text, /call cycle/i);
  assert.match(text, /more than one/i);
  assert.ok(f.alternatives.some((a) => /merge/.test(a.id)) && f.alternatives.some((a) => /decouple/.test(a.id)));
});

test('distributed monolith: expected non-findings', () => {
  const have = new Set(r.findings.map((f) => f.kind));
  assert.ok(!have.has('module.dependency-cycle'), 'no import cycles inside the services');
  assert.ok(!have.has('code.large-class'));
  assert.ok(!have.has('service.nanoservice'), 'three services with traffic are not nanoservices');
});

test('distributed monolith: evidence provenance, retain alternative and risk sanity', () => {
  assertWellFormed(r.findings);
  const writers = ofKind(r.findings, 'database.multiple-writers')[0];
  assert.ok(['high', 'critical'].includes(writers.risk), `shared-table writers are ${writers.risk}`);
  assert.ok(writers.approvers.length >= 2);
});

test('distributed monolith: no service extraction or data split without a driver', async () => {
  const d = await decompose(r.ctx, { config: r.config });
  assert.ok(d.details.length >= 1);
  for (const rec of d.details) {
    assert.deepEqual(rec.driver, []);
    assert.ok(!['T3', 'T7', 'T6'].includes(rec.treatment), `${rec.treatment} must not be selected without a driver`);
    assert.ok(!rec.sequence.includes('T3'));
    const t3 = rec.rejected_treatments.find((x) => x.treatment === 'T3');
    assert.ok(t3 && t3.reason.length > 0, 'T3 is rejected with a reason');
    assert.ok(rec.heuristics_used.length > 0, 'thresholds are labelled as heuristics');
  }
});

test('distributed monolith: with independent_deploy and shared tables T3 is rejected, never selected', async () => {
  const d = await decompose(r.ctx, { config: r.config, drivers: ['independent_deploy'] });
  for (const rec of d.details) {
    assert.deepEqual(rec.driver, ['independent_deploy']);
    const t3 = rec.rejected_treatments.find((x) => x.treatment === 'T3');
    const t6First = rec.sequence.indexOf('T6') !== -1 && rec.sequence.indexOf('T6') < rec.sequence.indexOf('T3');
    assert.ok(t3 ? /shared|writes|table/i.test(t3.reason) : t6First, 'T3 rejected for shared-table writes, or T6 sequenced before T3');
    assert.notEqual(rec.treatment, 'T3');
    assert.ok(rec.rejected_treatments.every((x) => x.reason.length > 0));
  }
});
