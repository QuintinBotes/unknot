// Golden repository (g): Terraform + Kubernetes estate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, assertKinds, assertWellFormed, ofKind } from './_harness.mjs';

const r = await analyse('terraform-k8s', { config: { evidence: { infra_plans: ['plans/rds-replace.json'] } } });

test('terraform+k8s: map is complete and detectors run cleanly', () => {
  assert.equal(r.mapped.status, 'complete');
  assert.deepEqual(r.errors, []);
});

test('terraform+k8s: expected finding kinds', () => {
  assertKinds(r.findings, [
    'infrastructure.copy-pasted-stacks',
    'infrastructure.iam-wildcards',
    'infrastructure.public-exposure',
    'infrastructure.privileged-workloads',
    'infrastructure.missing-probes',
    'infrastructure.destructive-plan-change',
    'infrastructure.mesh-sidecar-without-policy',
  ]);
});

test('terraform+k8s: the three environments are one copy-pasted group', () => {
  const f = ofKind(r.findings, 'infrastructure.copy-pasted-stacks')[0];
  for (const e of ['dev', 'staging', 'prod']) assert.ok(f.scope.some((p) => p.includes(`envs/${e}`)));
  assert.ok(f.alternatives.some((a) => a.id === 'extract-module'));
  assert.ok(f.risks.some((x) => /moved|destroy/i.test(x)), 'extraction risk of address moves is stated');
});

test('terraform+k8s: wildcard IAM and public SSH are found with their resource', () => {
  assert.ok(ofKind(r.findings, 'infrastructure.iam-wildcards').some((f) => f.scope.includes('terraform/envs/prod/main.tf')));
  const pub = ofKind(r.findings, 'infrastructure.public-exposure');
  assert.ok(pub.some((f) => f.scope.includes('terraform/envs/prod/main.tf') && ['high', 'critical'].includes(f.risk)));
});

test('terraform+k8s: the RDS replacement is destructive, high or critical, and needs more than a code owner', () => {
  const f = ofKind(r.findings, 'infrastructure.destructive-plan-change')[0];
  assert.match(f.title, /aws_db_instance\.main/);
  assert.ok(['high', 'critical'].includes(f.risk));
  assert.ok(f.measurements['plan.replaces'] >= 1);
  assert.ok(f.approvers.length >= 2);
  assert.ok(f.evidence.every((e) => e.label === 'observed'));
});

test('terraform+k8s: expected non-findings', () => {
  const have = new Set(r.findings.map((f) => f.kind));
  for (const k of ['module.dependency-cycle', 'code.complex-function', 'service.distributed-monolith', 'database.hazardous-migration']) assert.ok(!have.has(k), `unexpected ${k}`);
  // The NetworkPolicy allows only web -> api; it must never be reported as a defect to delete.
  assert.ok(!r.findings.some((f) => /NetworkPolicy/i.test(f.title) && /remove|delete/i.test(f.smallest_simplification)));
});

test('terraform+k8s: evidence provenance and retain alternative', () => {
  assertWellFormed(r.findings);
});
