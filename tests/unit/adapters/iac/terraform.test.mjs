import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFixture } from './helpers.mjs';
import { extractTerraform, classifyConstraint, multisetJaccard } from '../../../../adapters/infrastructure/iac/terraform.mjs';
import { classifyResource, ingressSummary, analyzePolicyDocument } from '../../../../adapters/infrastructure/iac/analysis.mjs';

const m = mapFixture('terraform');
const attrs = (id) => m.node(id)?.attrs;

test('resources: module-qualified under modules/<x>, path-qualified for stacks', () => {
  assert.ok(m.node('resource:module.network.aws_vpc.main'));
  assert.ok(m.node('resource:module.network.aws_subnet.a'));
  assert.ok(m.node('resource:envs/prod/aws_db_instance.main'));
  const root = extractTerraform({ path: 'main.tf' }, 'resource "aws_s3_bucket" "b" {}\n');
  assert.ok(root.some((f) => f.id === 'resource:aws_s3_bucket.b'));
});

test('resource attrs: provider, type, file, line, lifecycle, tags, count/for_each', () => {
  const db = attrs('resource:envs/prod/aws_db_instance.main');
  assert.equal(db.provider, 'aws');
  assert.equal(db.type, 'aws_db_instance');
  assert.equal(db.file, 'envs/prod/main.tf');
  assert.ok(db.line > 1);
  assert.deepEqual(db.lifecycle, { prevent_destroy: true, create_before_destroy: false, ignore_changes: [] });
  assert.equal(db.deletion_protection, true);
  assert.equal(db.stateful, true);
  assert.equal(attrs('resource:envs/prod/aws_s3_bucket.assets').tags, true);
  assert.equal(db.count, false);
  const counted = extractTerraform({ path: 'a.tf' }, 'resource "aws_instance" "w" {\n  count = 2\n  lifecycle { ignore_changes = [ami, tags] }\n}\n');
  const a = counted.find((f) => f.id === 'resource:aws_instance.w').attrs;
  assert.equal(a.count, true);
  assert.deepEqual(a.lifecycle.ignore_changes, ['ami', 'tags']);
});

test('secret-looking attributes are never recorded', () => {
  const text = 'resource "aws_db_instance" "d" {\n  password = "hunter2-SECRET"\n  engine = "postgres"\n}\nresource "aws_secretsmanager_secret_version" "v" {\n  secret_string = "TOP-SECRET-STRING"\n}\n';
  const out = JSON.stringify(extractTerraform({ path: 'x.tf' }, text));
  assert.ok(!out.includes('hunter2-SECRET'));
  assert.ok(!out.includes('TOP-SECRET-STRING'));
  assert.ok(out.includes('postgres'));
});

test('node-type classification adds typed nodes beside resource nodes', () => {
  assert.ok(m.node('database:envs/prod/aws_db_instance.main'));
  assert.ok(m.node('bucket:envs/prod/aws_s3_bucket.assets'));
  assert.ok(m.node('firewall_rule:envs/prod/aws_security_group.web'));
  assert.ok(m.node('role:envs/prod/aws_iam_role.app'));
  assert.ok(m.node('policy:envs/prod/aws_iam_role_policy.app'));
  assert.ok(m.node('key:envs/prod/aws_kms_key.main'));
  assert.equal(m.edges('PROVISIONS', 'resource:envs/prod/aws_db_instance.main', 'database:envs/prod/aws_db_instance.main').length, 1);
  const table = {
    aws_lb: 'load_balancer', google_compute_forwarding_rule: 'load_balancer', google_compute_global_forwarding_rule: 'load_balancer',
    aws_route53_zone: 'dns_zone', google_dns_managed_zone: 'dns_zone', aws_eks_cluster: 'cluster', google_container_cluster: 'cluster',
    azurerm_kubernetes_cluster: 'cluster', aws_lambda_function: 'cloud_function', google_cloudfunctions_function: 'cloud_function',
    aws_backup_plan: 'backup_policy', aws_backup_vault: 'backup_vault', aws_secretsmanager_secret: 'secret_ref', azurerm_key_vault_secret: 'secret_ref',
    google_secret_manager_secret: 'secret_ref', aws_dynamodb_table: 'database', google_sql_database_instance: 'database', azurerm_mssql_database: 'database',
    azurerm_storage_account: 'bucket', google_storage_bucket: 'bucket', google_compute_firewall: 'firewall_rule', azurerm_network_security_rule: 'firewall_rule',
    aws_security_group_rule: 'firewall_rule', google_project_iam_member: 'policy', azurerm_role_definition: 'role', azurerm_role_assignment: 'policy',
    aws_iam_policy: 'policy', aws_rds_cluster: 'database', aws_ebs_volume: 'volume', aws_s3_bucket_versioning: null, aws_db_parameter_group: null,
  };
  for (const [type, node] of Object.entries(table)) assert.equal(classifyResource(type).node, node, type);
  assert.equal(classifyResource('azurerm_mssql_firewall_rule').node, 'firewall_rule');
  assert.equal(classifyResource('aws_dynamodb_table').stateful, true);
  assert.equal(classifyResource('aws_route53_record').stateful, false);
});

test('IAM: wildcard action/resource, admin, principals, heredoc and data documents', () => {
  const prod = attrs('resource:envs/prod/aws_iam_role_policy.app');
  assert.deepEqual(prod.wildcard_actions, ['*']);
  assert.equal(prod.wildcard_resources, true);
  assert.equal(prod.admin, true);
  const dev = attrs('resource:envs/dev/aws_iam_role_policy.app');
  assert.deepEqual(dev.wildcard_actions, ['s3:*']);
  assert.equal(dev.wildcard_resources, false);
  assert.equal(dev.admin, false);
  assert.equal(dev.policy_literal, true);
  assert.deepEqual(attrs('resource:envs/dev/aws_iam_role.app').principals, ['Service:ec2.amazonaws.com']);
  // aws_iam_policy_document data block resolved through `.json`
  assert.deepEqual(attrs('resource:envs/staging/aws_iam_role.app').principals, ['Service:ec2.amazonaws.com']);
  assert.ok(m.node('resource:envs/staging/data.aws_iam_policy_document.assume'));
  const pub = analyzePolicyDocument({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: '*' }] });
  assert.equal(pub.public_principal, true);
  const deny = analyzePolicyDocument({ Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }] });
  assert.equal(deny.admin, false);
});

test('GRANTS edges run role -> the resources its policy names', () => {
  assert.equal(m.edges('GRANTS', 'role:envs/prod/aws_iam_role.app', 'resource:envs/prod/aws_s3_bucket.assets').length, 1);
  // The heredoc policy resolves its ${...} hole too.
  assert.equal(m.edges('GRANTS', 'role:envs/dev/aws_iam_role.app', 'resource:envs/dev/aws_s3_bucket.assets').length, 1);
});

test('ingress: public 0.0.0.0/0 on 22, ports, wildcard ports and ALLOWS_INGRESS_FROM', () => {
  const prod = attrs('resource:envs/prod/aws_security_group.web');
  assert.equal(prod.public_ingress, true);
  assert.deepEqual(prod.ports, ['22']);
  assert.equal(prod.wildcard_ports, false);
  const dev = attrs('resource:envs/dev/aws_security_group.web');
  assert.equal(dev.public_ingress, false);
  assert.equal(m.edges('ALLOWS_INGRESS_FROM', 'firewall_rule:envs/prod/aws_security_group.web', 'net_endpoint:0.0.0.0/0').length, 1);
  assert.equal(m.node('net_endpoint:0.0.0.0/0').attrs.public, true);
  const all = ingressSummary('aws_security_group_rule', { type: 'ingress', protocol: '-1', from_port: 0, to_port: 0, cidr_blocks: ['::/0'] });
  assert.equal(all.public_ingress, true);
  assert.equal(all.wildcard_ports, true);
  const gcp = ingressSummary('google_compute_firewall', { source_ranges: ['0.0.0.0/0'], allow: [{ protocol: 'tcp', ports: ['80', '8000-9000'] }] });
  assert.deepEqual(gcp.ports, ['80', '8000-9000']);
  const gcpAll = ingressSummary('google_compute_firewall', { source_ranges: ['0.0.0.0/0'], allow: [{ protocol: 'all' }] });
  assert.equal(gcpAll.wildcard_ports, true);
  const az = ingressSummary('azurerm_network_security_rule', { direction: 'Inbound', access: 'Allow', source_address_prefix: 'Internet', destination_port_range: '*' });
  assert.equal(az.public_ingress, true);
  assert.equal(az.wildcard_ports, true);
  const azDeny = ingressSummary('azurerm_network_security_rule', { direction: 'Inbound', access: 'Deny', source_address_prefix: '*', destination_port_range: '22' });
  assert.equal(azDeny.public_ingress, false);
});

test('state backends: local unencrypted in dev, implicit local in staging, S3 with locking in prod', () => {
  assert.deepEqual([attrs('state_backend:envs/dev').type, attrs('state_backend:envs/dev').remote, attrs('state_backend:envs/dev').encrypt, attrs('state_backend:envs/dev').locking], ['local', false, false, false]);
  const prod = attrs('state_backend:envs/prod');
  assert.equal(prod.type, 's3');
  assert.equal(prod.remote, true);
  assert.equal(prod.encrypt, true);
  assert.equal(prod.locking, true);
  assert.equal(prod.lock_mechanism, 'dynamodb');
  const staging = attrs('state_backend:envs/staging');
  assert.equal(staging.implicit, true);
  assert.equal(staging.remote, false);
  assert.equal(m.edges('MANAGES_STATE_FOR', 'state_backend:envs/prod', 'iac_module:envs/prod').length, 1);
  const s3nolock = extractTerraform({ path: 'b.tf' }, 'terraform { backend "s3" { bucket = "b" } }\n').find((f) => f.type === 'state_backend');
  assert.equal(s3nolock.attrs.locking, false);
  assert.equal(s3nolock.attrs.encrypt, false);
  const lockfile = extractTerraform({ path: 'b.tf' }, 'terraform {\n  backend "s3" {\n    use_lockfile = true\n    encrypt = true\n  }\n}\n').find((f) => f.type === 'state_backend');
  assert.equal(lockfile.attrs.locking, true);
  assert.equal(lockfile.attrs.lock_mechanism, 's3_lockfile');
});

test('provider pinning: exact, ~>, unpinned, implicit', () => {
  assert.equal(attrs('dependency:envs/prod#provider.aws').pinned, '~>');
  assert.equal(attrs('dependency:envs/dev#provider.aws').pinned, 'unpinned');
  assert.equal(attrs('dependency:envs/staging#provider.aws').pinned, 'unpinned');
  assert.equal(attrs('dependency:envs/staging#provider.aws').implicit, true);
  assert.equal(classifyConstraint('1.2.3'), 'exact');
  assert.equal(classifyConstraint('= 1.2.3'), 'exact');
  assert.equal(classifyConstraint('~> 5.0'), '~>');
  assert.equal(classifyConstraint('>= 4.0, < 6.0'), 'range');
  assert.equal(classifyConstraint('>= 4.0'), 'unpinned');
  assert.equal(classifyConstraint(undefined), 'unpinned');
});

test('modules: local resolves to a path, remote keeps source; version pinned flags; wrapper and one-use', () => {
  const edge = m.edges('DEPENDS_ON', 'iac_module:envs/prod', 'iac_module:modules/wrapper')[0];
  assert.equal(edge.attrs.call, 'net');
  assert.equal(edge.attrs.pinned, 'local');
  const reg = m.edges('DEPENDS_ON', 'iac_module:envs/prod', 'iac_module:terraform-aws-modules/s3-bucket/aws')[0];
  assert.equal(reg.attrs.pinned, 'exact');
  assert.equal(reg.attrs.version, '4.1.2');
  assert.equal(attrs('iac_module:terraform-aws-modules/s3-bucket/aws').remote, true);
  const wrapper = attrs('iac_module:modules/wrapper');
  assert.equal(wrapper.wrapper, true);
  assert.equal(wrapper.one_use, true);
  assert.equal(attrs('iac_module:modules/network').wrapper, false);
  assert.equal(attrs('iac_module:modules/network').one_use, true);
  assert.equal(m.edges('DEPENDS_ON', 'iac_module:modules/wrapper', 'iac_module:modules/network').length, 1);
  const git = extractTerraform({ path: 'a.tf' }, 'module "m" { source = "git::https://example.com/x.git" }\nmodule "n" { source = "git::https://example.com/x.git?ref=v1.2.0" }\n');
  const pins = git.filter((f) => f.kind === 'edge').map((f) => f.attrs.pinned);
  assert.deepEqual(pins, ['unpinned', 'ref']);
});

test('references become DEPENDS_ON edges inside a stack', () => {
  assert.equal(m.edges('DEPENDS_ON', 'resource:envs/prod/aws_db_instance.main', 'resource:envs/prod/aws_kms_key.main').length, 1);
  assert.equal(m.edges('DEPENDS_ON', 'resource:module.network.aws_subnet.a', 'resource:module.network.aws_vpc.main').length, 1);
  // never across stacks
  assert.equal(m.edges('DEPENDS_ON', 'resource:envs/dev/aws_iam_role_policy.app', 'resource:envs/prod/aws_iam_role.app').length, 0);
});

test('near-duplicate env stacks are flagged with duplicate_of', () => {
  const prod = attrs('iac_module:envs/prod');
  assert.deepEqual(prod.duplicate_of, ['iac_module:envs/dev', 'iac_module:envs/staging']);
  assert.ok(prod.duplicate_similarity >= 0.8 && prod.duplicate_similarity < 1);
  assert.equal(attrs('iac_module:envs/dev').duplicate_similarity, 1);
  assert.equal(attrs('iac_module:modules/network').duplicate_of, undefined);
  assert.equal(multisetJaccard(new Map([['a', 2]]), new Map([['a', 1]])), 0.5);
});

test('moved/import blocks, variables and outputs are counted on the stack', () => {
  const staging = attrs('iac_module:envs/staging');
  assert.equal(staging.moved_blocks, 1);
  assert.equal(staging.import_blocks, 1);
  assert.equal(staging.moved[0].from, 'aws_s3_bucket.old_assets');
  assert.equal(staging.data_sources, 1);
  const net = attrs('iac_module:modules/network');
  assert.equal(net.variables, 1);
  assert.equal(net.outputs, 1);
});

test('stateful classification and data sources', () => {
  assert.equal(attrs('resource:envs/staging/data.aws_iam_policy_document.assume').data, true);
  assert.equal(attrs('resource:envs/prod/aws_s3_bucket.assets').stateful, true);
});

test('facts carry config provenance with path:line and the adapter extractor', () => {
  const f = m.node('resource:envs/prod/aws_db_instance.main');
  assert.equal(f.provenance.source_type, 'config');
  assert.match(f.provenance.source_ref, /^envs\/prod\/main\.tf:\d+$/);
  assert.equal(f.provenance.extractor, 'iac@0.1.0');
  const implicit = m.all.find((x) => x.id === 'state_backend:envs/staging');
  assert.equal(implicit.provenance.source_type, 'inference');
  assert.equal(implicit.provenance.confidence, 'medium');
});

test('extraction is deterministic', () => {
  const again = mapFixture('terraform');
  assert.deepEqual(again.all, m.all);
});

test('.tf.json is understood', () => {
  const json = JSON.stringify({
    resource: { aws_s3_bucket: { b: { bucket: 'x', tags: { a: 'b' } } }, aws_security_group: { sg: { ingress: [{ from_port: 22, to_port: 22, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] }] } } },
    terraform: { backend: { s3: { bucket: 'b', encrypt: true, dynamodb_table: 't' } } },
  });
  const facts = extractTerraform({ path: 'x.tf.json' }, json);
  assert.ok(facts.find((f) => f.id === 'resource:aws_s3_bucket.b'));
  assert.equal(facts.find((f) => f.id === 'resource:aws_security_group.sg').attrs.public_ingress, true);
  assert.equal(facts.find((f) => f.type === 'state_backend').attrs.locking, true);
  const bad = extractTerraform({ path: 'y.tf.json' }, '{nope');
  assert.equal(bad.at(-1).attrs.parse_errors.length, 1);
});
