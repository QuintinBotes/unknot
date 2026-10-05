// Golden repository (d): event-driven system (kafkajs + amqplib, AsyncAPI contract that
// documents two of three channels).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, assertKinds, assertWellFormed, ofKind } from './_harness.mjs';

const r = await analyse('event-driven');

test('event-driven: map is complete and detectors run cleanly', () => {
  assert.equal(r.mapped.status, 'complete');
  assert.deepEqual(r.errors, []);
});

test('event-driven: expected finding kinds', () => {
  assertKinds(r.findings, ['service.event-soup', 'service.missing-idempotency']);
});

test('event-driven: the undocumented channel is flagged, the documented ones are not', () => {
  const soup = ofKind(r.findings, 'service.event-soup');
  assert.ok(soup.some((f) => /inventory\.adjusted/.test(f.title) && /no contract/.test(f.title)), soup.map((f) => f.title).join(' | '));
  assert.ok(!soup.some((f) => /orders\.(created|cancelled)/.test(f.title)), 'contracted channels are not event soup');
  const f = soup.find((x) => /inventory\.adjusted/.test(x.title));
  assert.ok(f.scope.includes('services/audit'), 'the undocumented consumer is in scope');
  assert.ok(f.evidence.some((e) => /contract absent/.test(e.summary)));
  assert.ok(f.alternatives.some((a) => a.id === 'schema-and-owner'));
});

test('event-driven: expected non-findings', () => {
  const have = new Set(r.findings.map((f) => f.kind));
  for (const k of ['service.distributed-monolith', 'service.shared-database', 'database.multiple-writers', 'module.dependency-cycle', 'code.large-class']) assert.ok(!have.has(k), `unexpected ${k}`);
});

test('event-driven: evidence provenance, retain alternative and risk sanity', () => {
  assertWellFormed(r.findings);
  for (const f of r.findings) assert.notEqual(f.risk, 'critical');
  for (const f of ofKind(r.findings, 'service.event-soup')) assert.ok(f.uncertainties.length > 0, 'static discovery limits are stated');
});
