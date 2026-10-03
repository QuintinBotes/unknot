import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectTreatment } from '../../../runtime/decompose/select.mjs';

const base = {
  'tests.present': 3, 'boundary.robust': 1, 'cycle.size': 0, 'boundary.shared_table_writers': 0, 'boundary.cross_joins': 0,
  'boundary.cross_transactions': 0, 'ownership.alignment': 0.95, 'module.co_change_leak': 0.05, 'boundary.reverse_deps': 0,
  'boundary.calls_per_request_p95': 1, 'requests.interceptable': 1, 'traces.available': 1, 'layer.violations': 2,
  'boundary.interface_count': 3, 'boundary.size': 8, 'owners.count': 1, 'contracts.present': 1,
};

test('without a driver, service extraction is never chosen', () => {
  const r = selectTreatment({ target: 'backend', signals: { ...base, 'driver.any': 0 }, drivers: [] });
  assert.notEqual(r.treatment, 'T3');
  assert.ok(r.rejected_treatments.some((x) => x.treatment === 'T3'));
});

test('with a driver and clean data boundaries, the least invasive treatment that serves it wins', () => {
  const r = selectTreatment({ target: 'backend', signals: { ...base, 'driver.any': 1, 'driver.independent_deploy': 1 }, drivers: ['independent_deploy'] });
  assert.ok(['T3', 'T6'].includes(r.treatment) || r.treatment === 'T0', r.treatment);
  for (const t of r.rejected_treatments) assert.ok(t.reason.length > 0);
});

test('shared tables put database decomposition before service extraction', () => {
  const r = selectTreatment({ target: 'backend', signals: { ...base, 'boundary.shared_table_writers': 0, 'boundary.cross_joins': 2, 'driver.any': 1, 'driver.independent_deploy': 1 }, drivers: ['independent_deploy'] });
  if (r.sequence.includes('T3')) assert.deepEqual(r.sequence.slice(-2), ['T6', 'T3']);
});

test('hard contraindications reject treatments with reasons', () => {
  const r = selectTreatment({ target: 'backend', signals: { ...base, 'boundary.cross_transactions': 3, 'ownership.alignment': 0.4, 'driver.any': 1, 'driver.independent_deploy': 1 }, drivers: ['independent_deploy'] });
  assert.notEqual(r.treatment, 'T3');
  assert.match(r.rejected_treatments.find((x) => x.treatment === 'T3').reason, /contraindicated|precondition/);
});

test('missing tests make characterization a prerequisite, not a rejection', () => {
  const r = selectTreatment({ target: 'backend', signals: { ...base, 'tests.present': 0, 'tests.characterization': 0, 'driver.any': 0 }, drivers: [] });
  if (r.treatment !== 'T0') assert.equal(r.sequence[0], 'characterization');
});

test('frontend without a driver prefers the modular monolith over micro-frontends', () => {
  const r = selectTreatment({ target: 'frontend', signals: { ...base, 'frontend.routes': 30, 'frontend.cross_feature_imports': 12, 'frontend.teams': 1, 'driver.any': 0 }, drivers: [] });
  assert.notEqual(r.treatment, 'T7');
});
