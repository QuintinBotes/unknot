import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJSON } from './helpers.mjs';
import { normalizePlan, planSummary, detectTool, HIGH_RISK_REQUIREMENTS } from '../../../../adapters/infrastructure/iac/plan.mjs';

const load = (name, opts) => normalizePlan(readJSON(`plans/${name}.json`), opts);
const change = (plan, address) => plan.changes.find((c) => c.address === address);

test('(a) create-only plan: counts, no destruction, low risk', () => {
  const p = load('a-create-only', { workspace: 'default', environment: 'prod', state_serial: 7 });
  assert.equal(p.tool, 'terraform');
  assert.deepEqual(p.actions, { create: 2, update: 0, replace: 0, delete: 0, forget: 0, read: 0, noop: 1, unknown: 0 });
  assert.equal(p.workspace, 'default');
  assert.equal(p.environment, 'prod');
  assert.equal(p.state_serial, 7);
  assert.equal(p.blast_radius.resources, 2);
  assert.equal(p.blast_radius.destructive, 0);
  assert.deepEqual(p.blast_radius.high_risk_reasons, []);
  assert.equal(p.blast_radius.high_risk, false);
  assert.equal(change(p, 'aws_instance.web').cost_hint, 'increase');
  assert.equal(change(p, 'aws_instance.old').action, 'noop');
  assert.deepEqual(p.output_changes, [{ name: 'bucket_name', action: 'create', sensitive: false, unknown: false }]);
});

test('state serial: options win, else prior_state, else null', () => {
  assert.equal(load('a-create-only').state_serial, null);
  const raw = readJSON('plans/a-create-only.json');
  raw.prior_state = { serial: 12, values: {} };
  assert.equal(normalizePlan(raw).state_serial, 12);
  assert.equal(normalizePlan(raw, { state_serial: 99 }).state_serial, 99);
});

test('(b) RDS delete+create is one replace with its reason, stateful and high risk', () => {
  const p = load('b-rds-replace');
  assert.equal(p.actions.replace, 1);
  assert.equal(p.actions.delete + p.actions.create, 0);
  const c = change(p, 'aws_db_instance.main');
  assert.equal(c.action, 'replace');
  assert.equal(c.replace_reason, 'replace_because_cannot_update');
  assert.deepEqual(c.replace_paths, ['engine']);
  assert.equal(c.destructive, true);
  assert.equal(c.stateful, true);
  assert.equal(c.recovery_delta.direction, 'reduced');
  assert.ok(c.recovery_delta.attrs.includes('backup_retention_period'));
  assert.ok(c.recovery_delta.attrs.includes('deletion_protection'));
  assert.equal(p.blast_radius.stateful_resources, 1);
  assert.equal(p.blast_radius.destructive, 1);
  for (const r of ['destroy_or_replace', 'stateful_replacement', 'stateful_destruction', 'recovery_reduced']) assert.ok(p.blast_radius.high_risk_reasons.includes(r), r);
});

test('create,delete ordering (create-before-destroy) is also a replace', () => {
  const raw = readJSON('plans/b-rds-replace.json');
  raw.resource_changes[0].change.actions = ['create', 'delete'];
  assert.equal(normalizePlan(raw).changes[0].action, 'replace');
});

test('sensitive changes report paths only, never values', () => {
  const p = load('b-rds-replace');
  assert.deepEqual(change(p, 'aws_db_instance.main').sensitive_changes, ['password']);
  const text = JSON.stringify(p) + JSON.stringify(planSummary(p));
  assert.ok(!text.includes('hunter2'));
  assert.ok(!text.includes('hunter3'));
  assert.ok(!text.includes('SECRET'));
});

test('(c) IAM widened vs narrowed', () => {
  const p = load('c-iam-widened');
  const widened = change(p, 'aws_iam_role_policy.app');
  assert.equal(widened.privilege_delta, 'widened');
  assert.equal(widened.wildcard_privilege_added, true);
  assert.equal(change(p, 'aws_iam_role_policy.narrow').privilege_delta, 'narrowed');
  assert.ok(p.blast_radius.high_risk_reasons.includes('privilege_widened'));
  assert.ok(p.blast_radius.high_risk_reasons.includes('iam_change'));
  assert.deepEqual(p.blast_radius.reasons_detail.privilege_widened, ['aws_iam_role_policy.app']);
});

test('(d) security group rule change: public ingress added, ports reported', () => {
  const p = load('d-sg-rule-change');
  const rule = change(p, 'aws_security_group_rule.ssh');
  assert.equal(rule.network_delta.category, 'firewall');
  assert.equal(rule.network_delta.change, 'modified');
  assert.equal(rule.network_delta.public_ingress_added, true);
  assert.deepEqual(rule.network_delta.ports_added, []);
  assert.deepEqual(rule.network_delta.public_ports_added, ['22']);
  const sg = change(p, 'aws_security_group.web');
  assert.equal(sg.network_delta.public_ingress_added, true);
  assert.equal(sg.network_delta.wildcard_ports_added, true);
  assert.ok(p.blast_radius.high_risk_reasons.includes('public_ingress_added'));
  assert.ok(p.blast_radius.high_risk_reasons.includes('network_change'));
});

test('(e) unknown values are listed and mark security verdicts unresolved', () => {
  const p = load('e-unknown-values');
  assert.equal(change(p, 'aws_iam_role_policy.app').privilege_delta, 'unknown');
  assert.equal(change(p, 'aws_security_group.web').network_delta.unresolved, true);
  assert.equal(change(p, 'aws_instance.web').unknown_values, 2);
  const unk = p.unknowns.find((u) => u.address === 'aws_iam_role_policy.app');
  assert.deepEqual(unk.paths, ['policy']);
  assert.equal(unk.kind, 'unknown_values');
  assert.ok(p.blast_radius.high_risk_reasons.includes('unresolved_security_value'));
});

test('delete, forget, read, unknown actions and import/move flags', () => {
  const raw = {
    format_version: '1.2',
    resource_changes: [
      { address: 'aws_s3_bucket.a', type: 'aws_s3_bucket', change: { actions: ['delete'], before: { bucket: 'a' }, after: null } },
      { address: 'aws_s3_bucket.b', type: 'aws_s3_bucket', change: { actions: ['forget'], before: {}, after: null } },
      { address: 'data.aws_ami.x', type: 'aws_ami', mode: 'data', change: { actions: ['read'], before: null, after: {} } },
      { address: 'aws_vpc.c', type: 'aws_vpc', change: { actions: ['mystery'], before: {}, after: {} } },
      { address: 'aws_s3_bucket.d', type: 'aws_s3_bucket', previous_address: 'aws_s3_bucket.old', change: { actions: ['update'], before: { bucket: 'd' }, after: { bucket: 'd' }, importing: { id: 'd' } } },
    ],
  };
  const p = normalizePlan(raw);
  assert.deepEqual(p.actions, { create: 0, update: 1, replace: 0, delete: 1, forget: 1, read: 1, noop: 0, unknown: 1 });
  assert.ok(p.blast_radius.high_risk_reasons.includes('state_removal'));
  assert.ok(p.blast_radius.high_risk_reasons.includes('import_or_move'));
  assert.ok(p.blast_radius.high_risk_reasons.includes('stateful_destruction'));
  assert.equal(change(p, 'aws_s3_bucket.d').importing, true);
  assert.equal(change(p, 'aws_s3_bucket.d').moved_from, 'aws_s3_bucket.old');
  assert.ok(p.unknowns.some((u) => u.kind === 'unknown_action'));
});

test('cluster removal, key changes and prevent_destroy overrides are high risk', () => {
  const raw = {
    format_version: '1.2',
    resource_changes: [
      { address: 'aws_eks_cluster.main', type: 'aws_eks_cluster', change: { actions: ['delete'], before: {}, after: null } },
      { address: 'aws_kms_key.k', type: 'aws_kms_key', change: { actions: ['update'], before: { enable_key_rotation: true }, after: { enable_key_rotation: false } } },
      { address: 'aws_db_instance.main', type: 'aws_db_instance', change: { actions: ['delete'], before: {}, after: null } },
    ],
  };
  const p = normalizePlan(raw, { prevent_destroy: ['aws_db_instance.main'] });
  for (const r of ['cluster_or_account_removal', 'rekey', 'prevent_destroy_overridden', 'recovery_reduced']) assert.ok(p.blast_radius.high_risk_reasons.includes(r), r);
});

test('plan_hash is stable under key order and changes with content', () => {
  const raw = readJSON('plans/d-sg-rule-change.json');
  const reorder = (v) => {
    if (Array.isArray(v)) return v.map(reorder);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reorder(v[k])]));
    return v;
  };
  const a = normalizePlan(raw);
  const b = normalizePlan(reorder(raw));
  assert.equal(a.plan_hash, b.plan_hash);
  assert.match(a.plan_hash, /^[0-9a-f]{64}$/);
  const shuffled = structuredClone(raw);
  shuffled.resource_changes.reverse();
  assert.equal(normalizePlan(shuffled).plan_hash, a.plan_hash);
  const changed = structuredClone(raw);
  changed.resource_changes[0].change.after.cidr_blocks = ['192.168.0.0/16'];
  assert.notEqual(normalizePlan(changed).plan_hash, a.plan_hash);
  // workspace/environment/state_serial do not alter the content hash; they are binding fields
  assert.equal(normalizePlan(raw, { workspace: 'x', environment: 'y', state_serial: 3 }).plan_hash, a.plan_hash);
});

test('CloudFormation change set: Replacement True is a replace, Conditional is conservative', () => {
  const p = load('cfn-changeset');
  assert.equal(p.tool, 'cloudformation');
  const db = change(p, 'Database');
  assert.equal(db.action, 'replace');
  assert.equal(db.replace_reason, 'requires_recreation:DBInstanceIdentifier');
  assert.equal(db.stateful, true);
  assert.equal(db.type, 'AWS::RDS::DBInstance');
  assert.equal(db.recovery_delta.direction, 'changed');
  assert.equal(change(p, 'Cache').action, 'replace');
  assert.equal(change(p, 'Cache').conditional_replacement, true);
  assert.ok(p.unknowns.some((u) => u.kind === 'conditional_replacement'));
  assert.equal(change(p, 'LogBucket').action, 'create');
  assert.equal(change(p, 'AppRole').action, 'delete');
  assert.equal(change(p, 'AppRole').privilege_delta, 'narrowed');
  assert.equal(change(p, 'WebSG').network_delta.change, 'modified');
  assert.deepEqual(p.actions, { create: 1, update: 1, replace: 2, delete: 1, forget: 0, read: 0, noop: 0, unknown: 0 });
});

test('Pulumi preview: replace steps fold into one change; secrets are not copied', () => {
  const p = load('pulumi-preview');
  assert.equal(p.tool, 'pulumi');
  assert.deepEqual(p.actions, { create: 1, update: 1, replace: 1, delete: 0, forget: 0, read: 0, noop: 1, unknown: 0 });
  const db = p.changes.find((c) => c.type === 'aws:rds/instance:Instance');
  assert.equal(db.action, 'replace');
  assert.equal(db.stateful, true);
  assert.equal(db.recovery_delta.direction, 'reduced');
  assert.deepEqual(db.sensitive_changes, ['password']);
  assert.match(db.replace_reason, /engine/);
  const sg = p.changes.find((c) => c.type === 'aws:ec2/securityGroup:SecurityGroup');
  assert.equal(sg.network_delta.public_ingress_added, true);
  const text = JSON.stringify(p);
  assert.ok(!text.includes('CIPHER') && !text.includes('1b47061264138c4ac30d75fd1eb44270'));
});

test('Azure what-if: Create/Delete/Modify/NoChange and role assignment widening', () => {
  const p = load('azure-whatif');
  assert.equal(p.tool, 'azure');
  assert.deepEqual(p.actions, { create: 2, update: 1, replace: 0, delete: 1, forget: 0, read: 0, noop: 1, unknown: 0 });
  const nsg = p.changes.find((c) => c.type === 'Microsoft.Network/networkSecurityGroups/securityRules');
  assert.equal(nsg.network_delta.public_ingress_added, true);
  const sql = p.changes.find((c) => c.type === 'Microsoft.Sql/servers/databases');
  assert.equal(sql.action, 'delete');
  assert.equal(sql.stateful, true);
  const role = p.changes.find((c) => c.type === 'Microsoft.Authorization/roleAssignments');
  assert.equal(role.privilege_delta, 'widened');
  assert.ok(p.blast_radius.high_risk_reasons.includes('iam_change'));
});

test('detectTool and unsupported input', () => {
  assert.equal(detectTool(readJSON('plans/a-create-only.json')), 'terraform');
  assert.equal(detectTool(readJSON('plans/cfn-changeset.json')), 'cloudformation');
  assert.equal(detectTool(readJSON('plans/pulumi-preview.json')), 'pulumi');
  assert.equal(detectTool(readJSON('plans/azure-whatif.json')), 'azure');
  assert.equal(detectTool({}), 'unknown');
  const p = normalizePlan({ nothing: true });
  assert.equal(p.changes.length, 0);
  assert.equal(p.unknowns[0].kind, 'unsupported_tool');
  assert.equal(normalizePlan({ format_version: '2.0', resource_changes: [] }, { tool: 'terraform' }).unknowns[0].kind, 'format_version');
});

test('planSummary: compact, bound to workspace/environment/serial, requirements only when high risk', () => {
  const safe = planSummary(load('a-create-only', { workspace: 'w', environment: 'prod', state_serial: 1 }));
  assert.equal(safe.schema, 'unknot.infrastructure-plan-summary/1');
  assert.equal(safe.high_risk, false);
  assert.deepEqual(safe.requirements, []);
  assert.equal(safe.binding_complete, true);
  assert.equal(safe.changes.length, 2);
  const risky = planSummary(load('b-rds-replace'));
  assert.equal(risky.high_risk, true);
  assert.deepEqual(risky.requirements, [...HIGH_RISK_REQUIREMENTS]);
  assert.equal(risky.binding_complete, false);
  assert.equal(risky.changes[0].replace_reason, 'replace_because_cannot_update');
  assert.deepEqual(Object.keys(risky.blast_radius).sort(), ['destructive', 'high_risk_reasons', 'resources', 'stateful_resources']);
  assert.ok(risky.requirements.includes('two_person_approval_including_resource_owner'));
});

test('normalisation is deterministic', () => {
  assert.deepEqual(load('e-unknown-values'), load('e-unknown-values'));
});
