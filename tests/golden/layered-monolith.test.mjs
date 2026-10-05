// Golden repository (a): layered legacy monolith (spec §26.3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, assertKinds, assertWellFormed, ofKind } from './_harness.mjs';

const LAYERS = ['src/controllers/**', 'src/services/**', 'src/repositories/**'];
const r = await analyse('layered-monolith', { config: { detectors: { 'module.layer-bypass': { layers: LAYERS } } } });

test('layered monolith: map is complete and detectors run cleanly', () => {
  assert.equal(r.mapped.status, 'complete');
  assert.deepEqual(r.errors, []);
});

test('layered monolith: expected finding kinds are present', () => {
  assertKinds(r.findings, ['module.dependency-cycle', 'module.layer-bypass', 'code.duplicated-code', 'code.large-class', 'code.dead-code', 'code.complex-function']);
});

test('layered monolith: findings point at the right files', () => {
  const up = ofKind(r.findings, 'module.layer-bypass');
  assert.ok(up.some((f) => f.scope.includes('src/repositories/orderRepository.js')));
  const cycle = ofKind(r.findings, 'module.dependency-cycle')[0];
  assert.ok(cycle.scope.includes('src/controllers/orderController.js') && cycle.scope.includes('src/repositories/orderRepository.js'));
  const dup = ofKind(r.findings, 'code.duplicated-code')[0];
  assert.ok(dup.scope.includes('src/services/orderService.js') && dup.scope.includes('src/services/invoiceService.js'));
  assert.ok(ofKind(r.findings, 'code.large-class').some((f) => f.scope.includes('src/services/OrderManager.js')));
  assert.ok(ofKind(r.findings, 'code.dead-code').some((f) => f.scope.includes('src/legacy/oldExporter.js')));
});

test('layered monolith: expected non-findings', () => {
  assert.ok(!r.findings.some((f) => /^(database|infrastructure|service|decomposition)\./.test(f.kind)), 'no data, infra or service concerns are invented');
  assert.ok(!ofKind(r.findings, 'code.dead-code').some((f) => f.scope.includes('src/controllers/orderController.js')), 'a used controller is not dead');
});

test('layered monolith: evidence provenance, retain alternative and risk sanity', () => {
  assertWellFormed(r.findings);
  for (const f of r.findings) {
    assert.equal(f.risk, 'low', `${f.kind} touches only application code`);
    assert.ok(f.approvers.includes('code-owner'));
    assert.ok(f.priority.score > 0);
  }
});
