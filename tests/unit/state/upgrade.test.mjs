// One test per stored field that changed shape between releases (CHANGELOG.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeCampaign, upgradeDecomposition, upgradeSlice } from '../../../runtime/state/upgrade.mjs';

// A record as 0.1.10 wrote it: no top files, fingerprint, run id or supersedes.
const v10 = () => ({
  schema_version: '1.0',
  id: 'DEC-0001',
  target: 'backend',
  driver: ['team-autonomy'],
  candidate: { id: 'C-1', modules: ['module:a.cs', 'module:b.cs'], robust: true, metrics: { 'cycle.size': 3 } },
  treatment: 'T3',
  confidence: 'medium',
});

test('no fingerprint (before 0.1.11): null, so it is listed as superseded and a rerun links to it', () => {
  assert.equal(upgradeDecomposition(v10()).fingerprint, null);
  assert.equal(upgradeDecomposition({ ...v10(), fingerprint: 'abc' }).fingerprint, 'abc');
});

test('no top_files or name (before 0.1.11)', () => {
  const r = upgradeDecomposition(v10());
  assert.deepEqual(r.candidate.top_files, []);
  assert.equal(r.candidate.name, '');
});

test('no cycle.crossing_size (before 0.1.13): taken from cycle.size, which measured it', () => {
  assert.equal(upgradeDecomposition(v10()).candidate.metrics['cycle.crossing_size'], 3);
  const kept = v10();
  kept.candidate.metrics['cycle.crossing_size'] = 2;
  assert.equal(upgradeDecomposition(kept).candidate.metrics['cycle.crossing_size'], 2);
});

test('no run_id or drivers_not_served (before 0.1.13)', () => {
  const r = upgradeDecomposition(v10());
  assert.equal(r.run_id, null);
  assert.deepEqual(r.drivers_not_served, []);
  assert.equal(upgradeDecomposition({ ...v10(), run_id: 'run-9' }).run_id, 'run-9');
});

test('no supersedes (before 0.1.14): null; an existing link is kept', () => {
  assert.equal(upgradeDecomposition(v10()).supersedes, null);
  const r = upgradeDecomposition({ ...v10(), supersedes: 'DEC-0000', supersedes_overlap: 0.8 });
  assert.deepEqual([r.supersedes, r.supersedes_overlap], ['DEC-0000', 0.8]);
});

test('upgrading is pure and idempotent', () => {
  const input = v10();
  const once = upgradeDecomposition(input);
  assert.deepEqual(input, v10());
  assert.deepEqual(upgradeDecomposition(once), once);
  assert.equal(upgradeDecomposition(null), null);
});

test('slice and campaign bodies missing list fields get empty lists, without touching what is stored', () => {
  const stored = { id: 'UK-0001', objective: 'x', scope: { include: ['a/**'] } };
  const s = upgradeSlice(stored);
  assert.deepEqual([s.sources, s.patterns, s.owners, s.scope.exclude], [[], [], [], []]);
  assert.deepEqual(stored, { id: 'UK-0001', objective: 'x', scope: { include: ['a/**'] } });
  assert.deepEqual(upgradeCampaign({ id: 'C-1' }).alternatives, []);
});
