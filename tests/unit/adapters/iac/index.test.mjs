import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import adapter from '../../../../adapters/infrastructure/iac/index.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';
import { FIXTURES, mapFixture } from './helpers.mjs';

const readText = async (p) => readFileSync(join(FIXTURES, p), 'utf8');

test('adapter contract', () => {
  assert.equal(adapter.id, 'iac');
  assert.equal(adapter.version, '0.1.0');
  assert.equal(adapter.kind, 'infrastructure');
  assert.deepEqual(adapter.capabilities.executes, []);
  assert.equal(adapter.capabilities.network, false);
  for (const g of ['**/*.tf', '**/*.tf.json', '**/*.hcl', '**/*.bicep', '**/*.template.{json,yaml,yml}', '**/cloudformation/**', '**/cdk.out/*.template.json', '**/Pulumi.yaml', '**/azuredeploy.json']) {
    assert.ok(adapter.capabilities.files.includes(g), g);
  }
  assert.equal(typeof adapter.extract, 'function');
  assert.equal(typeof adapter.link, 'function');
  assert.equal(typeof adapter.discover, 'function');
});

test('extract dispatches by file type and ignores the lock file', () => {
  assert.ok(adapter.extract({ path: 'a.tf' }, 'resource "aws_s3_bucket" "b" {}').length > 0);
  assert.ok(adapter.extract({ path: 'a.bicep' }, "resource s 'Microsoft.Storage/storageAccounts@1' = {\n}\n").length > 0);
  assert.deepEqual(adapter.extract({ path: '.terraform.lock.hcl' }, 'provider "x" {}'), []);
  assert.deepEqual(adapter.extract({ path: 'cloudformation/other.json' }, '{}'), []);
});

function ctx(extra = {}) {
  const m = mapFixture('terraform');
  return {
    root: FIXTURES, readText, exec: async () => { throw new Error('no exec'); },
    factsByFile: m.factsByFile,
    evidence: {
      infra_plans: ['plans/b-rds-replace.json', 'plans/c-iam-widened.json', 'plans/d-sg-rule-change.json'],
      infra_state: ['state/state-v4.json'],
      infra_inventory: ['state/inventory.json'],
    },
    options: { plans: [{ path: 'plans/b-rds-replace.json', workspace: 'prod', environment: 'production', state_serial: 42, dir: 'envs/prod' }] },
    ...extra,
  };
}

test('discover: plan_action nodes carry the normalised change and plan binding', async () => {
  const facts = await adapter.discover(ctx());
  facts.forEach(assertFact);
  const actions = facts.filter((f) => f.kind === 'node' && f.type === 'plan_action' && !f.id.endsWith('/(plan)'));
  const rds = actions.find((f) => f.attrs.address === 'aws_db_instance.main');
  assert.match(rds.id, /^plan_action:[0-9a-f]{64}\/aws_db_instance\.main$/);
  assert.equal(rds.attrs.action, 'replace');
  assert.equal(rds.attrs.workspace, 'prod');
  assert.equal(rds.attrs.environment, 'production');
  assert.equal(rds.attrs.state_serial, 42);
  assert.equal(rds.attrs.stateful, true);
  assert.equal(rds.provenance.source_type, 'catalog');
  const summary = facts.find((f) => f.id === `plan_action:${rds.attrs.plan_hash}/(plan)`);
  assert.equal(summary.attrs.summary.high_risk, true);
  assert.ok(!JSON.stringify(facts).includes('hunter2'));
});

test('discover: PROVISIONS to the declared resource and VIOLATES_POLICY where obvious', async () => {
  const facts = await adapter.discover(ctx());
  const edges = facts.filter((f) => f.kind === 'edge');
  const prov = edges.filter((e) => e.type === 'PROVISIONS' && e.from.endsWith('/aws_db_instance.main'));
  assert.equal(prov.length, 1);
  assert.equal(prov[0].to, 'resource:envs/prod/aws_db_instance.main');
  assert.equal(prov[0].attrs.ambiguous, false);
  const violations = edges.filter((e) => e.type === 'VIOLATES_POLICY');
  const kinds = new Set(violations.map((e) => e.to));
  assert.ok(kinds.has('policy:iac-baseline/stateful-destroy-review'));
  assert.ok(kinds.has('policy:iac-baseline/no-wildcard-iam'));
  assert.ok(kinds.has('policy:iac-baseline/no-public-ingress'));
  for (const v of kinds) assert.ok(facts.some((f) => f.kind === 'node' && f.id === v), `${v} node exists`);
  assert.ok(violations.every((e) => e.provenance.source_type === 'inference'));
});

test('discover: without a stack hint every matching declaration is a low-confidence candidate', async () => {
  const facts = await adapter.discover(ctx({ options: {} }));
  const prov = facts.filter((f) => f.kind === 'edge' && f.type === 'PROVISIONS' && f.from.endsWith('/aws_db_instance.main'));
  assert.deepEqual(prov.map((e) => e.to).sort(), ['resource:envs/dev/aws_db_instance.main', 'resource:envs/prod/aws_db_instance.main', 'resource:envs/staging/aws_db_instance.main']);
  assert.ok(prov.every((e) => e.attrs.ambiguous === true && e.provenance.confidence === 'low'));
});

test('discover: state summary node and drift facts, never secrets', async () => {
  const facts = await adapter.discover(ctx());
  const st = facts.find((f) => f.kind === 'node' && f.type === 'state_backend');
  assert.equal(st.attrs.serial, 42);
  assert.equal(st.attrs.recorded, true);
  const drift = facts.filter((f) => f.kind === 'node' && f.type === 'resource' && f.attrs.drift);
  const kinds = drift.map((f) => f.attrs.drift.kind);
  assert.ok(kinds.includes('unmanaged'));
  assert.ok(kinds.includes('orphaned_in_state'));
  assert.ok(kinds.includes('attribute_drift'));
  assert.ok(drift.every((f) => f.attrs.finding_input === true));
  const unmanaged = drift.find((f) => f.attrs.drift.kind === 'unmanaged');
  assert.equal(unmanaged.id, 'resource:drift/unmanaged/acme-shadow-bucket');
  const text = JSON.stringify(facts);
  for (const s of ['hunter2-SECRET-VALUE', 'tok-SECRET-9999', 'rand-SECRET-RESULT']) assert.ok(!text.includes(s));
});

test('discover: plan state serial falls back to the single recorded state', async () => {
  const facts = await adapter.discover(ctx({ options: {} }));
  const a = facts.find((f) => f.kind === 'node' && f.type === 'plan_action' && f.attrs.address === 'aws_iam_role_policy.app');
  assert.equal(a.attrs.state_serial, 42);
});

test('discover: prevent_destroy from declared facts flags a destructive plan', async () => {
  const facts = await adapter.discover(ctx());
  const rds = facts.find((f) => f.kind === 'node' && f.type === 'plan_action' && f.attrs.address === 'aws_db_instance.main');
  assert.equal(rds.attrs.prevent_destroy_overridden, true);
});

test('discover: invalid evidence becomes a finding, not a crash', async () => {
  const facts = await adapter.discover({ readText: async () => '{not json', evidence: { infra_plans: ['bad.json'] }, options: {}, factsByFile: new Map() });
  const f = facts.find((x) => x.kind === 'node' && x.type === 'finding');
  assert.ok(f);
  assert.equal(f.attrs.evidence, 'bad.json');
});

test('discover: no evidence yields no facts; plan entries may be objects', async () => {
  assert.deepEqual(await adapter.discover({ readText, evidence: {}, options: {}, factsByFile: new Map() }), []);
  const facts = await adapter.discover({
    readText, factsByFile: new Map(), options: {},
    evidence: { infra_plans: [{ path: 'plans/cfn-changeset.json', environment: 'e', workspace: 'w', state_serial: 3 }] },
  });
  const a = facts.find((f) => f.kind === 'node' && f.attrs.address === 'Database');
  assert.equal(a.attrs.tool, 'cloudformation');
  assert.equal(a.attrs.environment, 'e');
});

test('discover works from the census when no facts are provided', async () => {
  const facts = await adapter.discover({
    readText, census: [{ path: 'terraform/envs/prod/main.tf' }], options: {},
    evidence: { infra_plans: ['plans/b-rds-replace.json'] },
  });
  assert.ok(facts.some((f) => f.kind === 'edge' && f.type === 'PROVISIONS'));
});
