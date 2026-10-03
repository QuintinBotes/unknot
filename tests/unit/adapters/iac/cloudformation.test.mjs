import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './helpers.mjs';
import { extractCloudFormation, bicepProps } from '../../../../adapters/infrastructure/iac/cloudformation.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';

const run = (path, text) => {
  const facts = extractCloudFormation({ path }, text);
  facts.forEach(assertFact);
  const nodes = new Map();
  for (const f of facts) if (f.kind === 'node') nodes.set(f.id, f);
  return { facts, node: (id) => nodes.get(id), edges: (t, a, b) => facts.filter((f) => f.kind === 'edge' && (!t || f.type === t) && (!a || f.from === a) && (!b || f.to === b)) };
};

const cfn = run('template.yaml', read('cfn/template.yaml'));

test('CFN YAML with !Ref/!GetAtt/!Sub: resources keyed cfn.<LogicalId> with typed nodes', () => {
  for (const id of ['Bucket', 'AppRole', 'WebSG', 'Database', 'Fn']) assert.ok(cfn.node(`resource:cfn.${id}`), id);
  assert.ok(cfn.node('bucket:cfn.Bucket'));
  assert.ok(cfn.node('role:cfn.AppRole'));
  assert.ok(cfn.node('firewall_rule:cfn.WebSG'));
  assert.ok(cfn.node('database:cfn.Database'));
  assert.ok(cfn.node('cloud_function:cfn.Fn'));
  const bucket = cfn.node('resource:cfn.Bucket').attrs;
  assert.equal(bucket.type, 'AWS::S3::Bucket');
  assert.equal(bucket.deletion_policy, 'Retain');
  assert.equal(bucket.tags, true);
  assert.equal(bucket.stateful, true);
  assert.match(cfn.node('resource:cfn.Bucket').provenance.source_ref, /^template\.yaml:\d+$/);
});

test('CFN references: Ref, GetAtt, Sub, DependsOn become DEPENDS_ON', () => {
  assert.equal(cfn.edges('DEPENDS_ON', 'resource:cfn.Database', 'resource:cfn.WebSG').length, 1);
  assert.equal(cfn.edges('DEPENDS_ON', 'resource:cfn.Database', 'resource:cfn.Bucket').length, 1);
  assert.equal(cfn.edges('DEPENDS_ON', 'resource:cfn.Fn', 'resource:cfn.AppRole').length, 1);
  // Ref to a parameter is not a resource edge
  assert.equal(cfn.edges('DEPENDS_ON', 'resource:cfn.Bucket').length, 0);
});

test('CFN IAM analysis: wildcard service action, GRANTS role -> bucket', () => {
  const role = cfn.node('resource:cfn.AppRole').attrs;
  assert.deepEqual(role.wildcard_actions, ['s3:*']);
  assert.equal(role.wildcard_resources, false);
  assert.equal(role.admin, false);
  assert.deepEqual(role.principals, ['Service:ec2.amazonaws.com']);
  assert.equal(cfn.edges('GRANTS', 'role:cfn.AppRole', 'resource:cfn.Bucket').length, 1);
});

test('CFN security group ingress: public 22', () => {
  const sg = cfn.node('resource:cfn.WebSG').attrs;
  assert.equal(sg.public_ingress, true);
  assert.deepEqual(sg.ports, ['22']);
  assert.equal(cfn.edges('ALLOWS_INGRESS_FROM', 'firewall_rule:cfn.WebSG', 'net_endpoint:0.0.0.0/0').length, 1);
  const standalone = run('t.json', JSON.stringify({
    Resources: { In: { Type: 'AWS::EC2::SecurityGroupIngress', Properties: { GroupId: 'sg-1', IpProtocol: '-1', CidrIp: '0.0.0.0/0' } } },
  }));
  assert.equal(standalone.node('resource:cfn.In').attrs.wildcard_ports, true);
});

test('CFN never records secret properties', () => {
  const text = JSON.stringify(cfn.facts);
  assert.ok(!text.includes('MasterUserPassword'));
  const leaked = run('s.json', JSON.stringify({
    Resources: { Db: { Type: 'AWS::RDS::DBInstance', Properties: { MasterUserPassword: 'hunter2-SECRET', Engine: 'postgres' } } },
  }));
  assert.ok(!JSON.stringify(leaked.facts).includes('hunter2-SECRET'));
  assert.equal(leaked.node('resource:cfn.Db').attrs.engine, 'postgres');
});

test('CFN file summary and non-templates', () => {
  const file = cfn.node('file:template.yaml').attrs.iac_template;
  assert.equal(file.kind, 'cloudformation');
  assert.equal(file.resources, 5);
  assert.equal(file.parameters, 1);
  assert.equal(file.outputs, 1);
  assert.deepEqual(extractCloudFormation({ path: 'cloudformation/config.json' }, '{"a":1}'), []);
  assert.deepEqual(extractCloudFormation({ path: 'x.yaml' }, ': : :\n  - ['), []);
  assert.deepEqual(extractCloudFormation({ path: 'x.yaml' }, ''), []);
});

test('CDK synth output is detected by Resources+Type and qualified by path', () => {
  const synth = run('cdk.out/Stack.template.json', JSON.stringify({
    Resources: { Queue: { Type: 'AWS::SQS::Queue', Properties: {}, Metadata: { 'aws:cdk:path': 'Stack/Queue/Resource' } } },
  }));
  const q = synth.node('resource:cfn.cdk.out/Stack.Queue');
  assert.ok(q);
  assert.equal(q.attrs.cdk, true);
  assert.equal(q.attrs.stateful, true);
  assert.ok(synth.node('queue:cfn.cdk.out/Stack.Queue'));
});

test('Bicep: lexical resources, nsg ingress, role assignment admin, modules', () => {
  const b = run('main.bicep', read('bicep/main.bicep'));
  const storage = b.node('resource:bicep.storage').attrs;
  assert.equal(storage.type, 'Microsoft.Storage/storageAccounts');
  assert.equal(storage.api_version, '2023-01-01');
  assert.equal(storage.allow_blob_public_access, true);
  assert.equal(storage.minimum_tls_version, 'TLS1_0');
  assert.ok(b.node('bucket:bicep.storage'));
  const nsg = b.node('resource:bicep.nsg').attrs;
  assert.equal(nsg.public_ingress, true);
  assert.deepEqual(nsg.ports, ['22']);
  assert.ok(b.node('firewall_rule:bicep.nsg'));
  assert.equal(b.node('resource:bicep.assign').attrs.admin, true);
  assert.equal(b.edges('DEPENDS_ON', 'resource:bicep.assign', 'resource:bicep.storage').length, 1);
  assert.equal(b.edges('DEPENDS_ON', 'iac_module:.', 'iac_module:modules/net.bicep').length, 1);
  assert.equal(b.node('resource:bicep.storage').provenance.confidence, 'medium');
  const summary = b.node('file:main.bicep').attrs.iac_template;
  assert.deepEqual([summary.resources, summary.parameters, summary.outputs, summary.modules], [3, 2, 1, 1]);
});

test('Bicep: comments are ignored, existing resources are data', () => {
  const b = run('x.bicep', "// resource fake 'Microsoft.Storage/storageAccounts@1' = {\n/* resource fake2 'A/b@1' = { */\nresource real 'Microsoft.KeyVault/vaults@2023-02-01' existing = {\n  name: 'kv'\n}\n");
  assert.equal(b.node('resource:bicep.fake'), undefined);
  assert.equal(b.node('resource:bicep.fake2'), undefined);
  assert.equal(b.node('resource:bicep.real').attrs.existing, true);
  assert.deepEqual(bicepProps("a: 'x'\nb: {\n  c: true\n  d: 3\n}\n"), { a: 'x', b: { c: true, d: 3 } });
});

test('ARM JSON template', () => {
  const arm = run('azuredeploy.json', read('arm/azuredeploy.json'));
  assert.ok(arm.node('resource:arm.Microsoft.Storage/storageAccounts/acmestore'));
  const nsg = arm.node('resource:arm.Microsoft.Network/networkSecurityGroups/web').attrs;
  assert.equal(nsg.public_ingress, true);
  assert.deepEqual(nsg.ports, ['22']);
  assert.equal(arm.node('file:azuredeploy.json').attrs.iac_template.kind, 'arm');
});

test('Pulumi YAML', () => {
  const p = run('Pulumi.yaml', read('pulumi/Pulumi.yaml'));
  assert.ok(p.node('bucket:pulumi.logs'));
  assert.ok(p.node('role:pulumi.role'));
  assert.ok(p.node('database:pulumi.db'));
  assert.equal(p.node('resource:pulumi.db').attrs.lifecycle.prevent_destroy, true);
  assert.equal(p.node('resource:pulumi.rolePolicy').attrs.wildcard_resources, true);
  assert.equal(p.node('resource:pulumi.rolePolicy').attrs.admin, false);
  assert.equal(p.edges('DEPENDS_ON', 'resource:pulumi.rolePolicy', 'resource:pulumi.role').length, 1);
  assert.equal(p.edges('DEPENDS_ON', 'resource:pulumi.rolePolicy', 'resource:pulumi.logs').length, 1);
  assert.deepEqual(extractCloudFormation({ path: 'Pulumi.yaml' }, 'name: x\nruntime: yaml\n'), []);
});
