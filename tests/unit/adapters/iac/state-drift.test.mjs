import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, readJSON, mapFixture } from './helpers.mjs';
import { parseState, shortAddress, valueDigest } from '../../../../adapters/infrastructure/iac/state.mjs';
import { detectDrift } from '../../../../adapters/infrastructure/iac/drift.mjs';

const SECRETS = ['hunter2-SECRET-VALUE', 'tok-SECRET-9999', 'rand-SECRET-RESULT', 'SECRETHASH'];

test('state v4 summary: serial, lineage, versions, counts', () => {
  const s = parseState(read('state/state-v4.json'));
  assert.equal(s.version, 4);
  assert.equal(s.serial, 42);
  assert.equal(s.lineage, 'a1b2c3d4-0000-4000-8000-000000000001');
  assert.equal(s.terraform_version, '1.7.5');
  assert.equal(s.resource_count, 6);
  assert.equal(s.instance_count, 6);
  assert.deepEqual(s.outputs, [{ name: 'bucket', sensitive: false }, { name: 'db_url', sensitive: true }]);
  const vpc = s.resources.find((r) => r.type === 'aws_vpc');
  assert.equal(vpc.address, 'module.net.aws_vpc.main');
  assert.equal(vpc.short, 'aws_vpc.main');
});

test('no secret value from state ever appears in the output', () => {
  const s = parseState(read('state/state-v4.json'));
  const text = JSON.stringify(s);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), secret);
  const db = s.resources.find((r) => r.type === 'aws_db_instance').instances[0];
  assert.ok(!db.attribute_keys.includes('password'));
  assert.ok(!db.attribute_keys.includes('master_user_secret'));
  assert.ok(db.redacted_attributes >= 2);
  assert.ok(db.attribute_keys.includes('engine'));
  assert.equal(typeof db.attr_digests.engine, 'string');
  assert.notEqual(db.attr_digests.engine, 'postgres');
  // sensitive_attributes-marked key is dropped even if its name looks harmless
  const rp = s.resources.find((r) => r.type === 'random_password').instances[0];
  assert.ok(!rp.attribute_keys.includes('result'));
  assert.deepEqual(rp.identity, {});
});

test('nested secret-named keys are blanked before digesting', () => {
  const a = valueDigest({ host: 'h', password: 'one' });
  const b = valueDigest({ host: 'h', password: 'two' });
  assert.equal(a, b);
  assert.notEqual(a, valueDigest({ host: 'other', password: 'one' }));
});

test('garbage state does not throw', () => {
  for (const bad of ['', '{', 'null', '[]', '{"resources":[null,1,{"instances":[null]}]}']) {
    const s = parseState(bad);
    assert.equal(s.resource_count >= 0, true);
  }
  assert.equal(parseState({ serial: 'x' }).serial, null);
});

test('shortAddress strips module prefixes and instance index', () => {
  assert.equal(shortAddress('module.a["x"].module.b.aws_s3_bucket.c[0]'), 'aws_s3_bucket.c');
  assert.equal(shortAddress('aws_s3_bucket.c'), 'aws_s3_bucket.c');
});

const declared = mapFixture('terraform').all.filter((f) => f.kind === 'node' && f.id.startsWith('resource:envs/prod/'));

test('drift: unmanaged bucket in the actual inventory', () => {
  const items = detectDrift({ declared, recorded: read('state/state-v4.json'), actual: readJSON('state/inventory.json') });
  const unmanaged = items.filter((i) => i.kind === 'unmanaged');
  assert.deepEqual(unmanaged.map((i) => i.id), ['acme-shadow-bucket']);
  assert.deepEqual(unmanaged[0].evidence.tag_keys, ['Purpose']);
  assert.ok(items.every((i) => i.finding_input === true));
});

test('drift: missing, orphaned_in_state, attribute drift and manual change', () => {
  const items = detectDrift({ declared, recorded: parseState(read('state/state-v4.json')), actual: readJSON('state/inventory.json') });
  const byKind = (k) => items.filter((i) => i.kind === k);
  assert.ok(byKind('missing').some((i) => i.address === 'aws_kms_key.main'));
  assert.ok(!byKind('missing').some((i) => i.address === 'aws_s3_bucket.assets'));
  assert.deepEqual(byKind('orphaned_in_state').map((i) => i.address), ['aws_sns_topic.legacy', 'module.net.aws_vpc.main', 'random_password.db']);
  const attr = byKind('attribute_drift');
  assert.equal(attr.length, 1);
  assert.equal(attr[0].address, 'aws_s3_bucket.assets');
  assert.deepEqual(attr[0].evidence.attributes, ['tags']);
  assert.notEqual(attr[0].evidence.recorded_digests.tags, attr[0].evidence.actual_digests.tags);
  const manual = byKind('manual_change');
  assert.equal(manual.length, 1);
  assert.equal(manual[0].address, 'aws_db_instance.main');
});

test('drift evidence never contains state secrets or tag values', () => {
  const items = detectDrift({ declared, recorded: read('state/state-v4.json'), actual: readJSON('state/inventory.json') });
  const text = JSON.stringify(items);
  for (const secret of SECRETS) assert.ok(!text.includes(secret));
  assert.ok(!text.includes('alice'));
});

test('drift is advisory: items describe, they carry no instruction fields', () => {
  const items = detectDrift({ declared, recorded: read('state/state-v4.json'), actual: readJSON('state/inventory.json') });
  for (const i of items) {
    assert.deepEqual(Object.keys(i).filter((k) => /action|fix|apply|remediat|command/i.test(k)), []);
  }
});

test('drift with no inputs or partial inputs', () => {
  assert.deepEqual(detectDrift(), []);
  assert.deepEqual(detectDrift({ actual: { resources: [] } }), []);
  const onlyActual = detectDrift({ actual: { provider: 'aws', resources: [{ type: 'aws_s3_bucket', id: 'x', name: 'x' }] } });
  assert.equal(onlyActual[0].kind, 'unmanaged');
  const attrDrift = detectDrift({
    recorded: parseState({ version: 4, serial: 1, resources: [{ mode: 'managed', type: 'aws_instance', name: 'w', instances: [{ attributes: { id: 'i-1', instance_type: 't3.small' } }] }] }),
    actual: { resources: [{ type: 'aws_instance', id: 'i-1', attributes: { instance_type: 't3.large' } }] },
  });
  assert.equal(attrDrift[0].kind, 'attribute_drift');
  assert.deepEqual(attrDrift[0].evidence.attributes, ['instance_type']);
});
