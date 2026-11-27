// apply.allowed_kinds (#149): tighten-only, from organization policy and from an unaccepted edit
// alike, and container and deployment files are risky and protected with no configuration.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as K from '../../helpers/kernel.mjs';
import { stringifyYAML } from '../../../runtime/core/yaml.mjs';
import { matchAny } from '../../../runtime/core/glob.mjs';
import { CHANGE_KINDS, diffKinds, plannedKinds, refusedKinds } from '../../../runtime/policy/kinds.mjs';

after(() => K.cleanup());

const { applyOrgPolicy } = K.merge;

test('organization allowed_kinds only narrows: a repository list cannot widen it, and garbage accepts nothing', () => {
  const merged = (repo, org) => applyOrgPolicy(K.cfg(repo), org).config.apply?.allowed_kinds;
  assert.deepEqual(merged({ apply: { allowed_kinds: ['tests', 'deletion', 'refactor', 'infrastructure'] } }, { apply: { allowed_kinds: ['tests', 'deletion'] } }), ['tests', 'deletion'], 'the org list wins over a wider repository list');
  assert.deepEqual(merged({}, { apply: { allowed_kinds: ['tests', 'deletion'] } }), ['tests', 'deletion'], 'no repository list: the org list');
  assert.deepEqual(merged({ apply: { allowed_kinds: ['tests'] } }, { apply: { allowed_kinds: ['tests', 'deletion'] } }), ['tests'], 'a narrower repository list stays narrower');
  assert.deepEqual(merged({ apply: { allowed_kinds: ['refactor'] } }, { apply: { allowed_kinds: ['tests'] } }), [], 'disjoint lists accept nothing, never everything');
  assert.deepEqual(merged({}, { apply: { allowed_kinds: 'everything' } }), [], 'a non-list org value accepts nothing');
  assert.deepEqual(merged({}, { apply: { allowed_kinds: null } }), [], 'an org null is not "no limit"');
  assert.equal(merged({}, {}), undefined, 'no list anywhere: no limit');
  assert.equal(merged({}, { apply: {} }), undefined);
  // A second org bundle (user-level after managed) can only narrow further.
  const two = applyOrgPolicy(applyOrgPolicy(K.cfg(), { apply: { allowed_kinds: ['tests'] } }).config, { apply: { allowed_kinds: ['tests', 'refactor'] } }).config;
  assert.deepEqual(two.apply.allowed_kinds, ['tests']);
});

test('an unaccepted edit can narrow allowed_kinds at once but never widen or drop it', () => {
  const p = K.makeProject();
  const accepted = stringifyYAML({ version: 1, mode: 'assist', apply: { allowed_kinds: ['tests', 'deletion'] } });
  writeFileSync(p.ctx.paths.config, accepted);
  K.configMod.recordAcceptedConfig(p.ctx, accepted, 'human:test');
  const effective = (raw) => {
    writeFileSync(p.ctx.paths.config, stringifyYAML(raw));
    return K.configMod.loadConfig(p.ctx);
  };
  assert.deepEqual(K.configMod.loadConfig(p.ctx).config.apply.allowed_kinds, ['tests', 'deletion']);
  const wider = effective({ version: 1, mode: 'assist', apply: { allowed_kinds: ['tests', 'deletion', 'refactor', 'public-interface'] } });
  assert.equal(wider.acceptance, 'changed');
  assert.deepEqual(wider.config.apply.allowed_kinds, ['tests', 'deletion'], 'widening waits for acceptance');
  assert.deepEqual(effective({ version: 1, mode: 'assist' }).config.apply.allowed_kinds, ['tests', 'deletion'], 'removing the key waits for acceptance');
  assert.deepEqual(effective({ version: 1, mode: 'assist', apply: {} }).config.apply.allowed_kinds, ['tests', 'deletion']);
  const narrower = effective({ version: 1, mode: 'assist', apply: { allowed_kinds: ['tests'] } });
  assert.deepEqual(narrower.config.apply.allowed_kinds, ['tests'], 'narrowing applies at once');
  assert.ok(narrower.adjustments.some((a) => a.path === 'apply.allowed_kinds' && /unaccepted/.test(a.by)));
  // Never accepted at all: plan mode, so nothing is applied whatever the file says.
  const q = K.makeProject();
  writeFileSync(q.ctx.paths.config, stringifyYAML({ version: 1, mode: 'assist', apply: { allowed_kinds: [...CHANGE_KINDS] } }));
  assert.equal(K.configMod.loadConfig(q.ctx).config.mode, 'plan');
});

test('a user-level organization policy narrows the accepted repository list through loadConfig', () => {
  const p = K.makeProject();
  const text = stringifyYAML({ version: 1, mode: 'assist', apply: { allowed_kinds: ['tests', 'deletion', 'refactor'] } });
  writeFileSync(p.ctx.paths.config, text);
  K.configMod.recordAcceptedConfig(p.ctx, text, 'human:test');
  const file = join(process.env.UNKNOT_HOME, 'org-policy.yaml');
  try {
    writeFileSync(file, 'apply:\n  allowed_kinds: [tests]\n');
    const cfg = K.configMod.loadConfig(p.ctx);
    assert.deepEqual(cfg.config.apply.allowed_kinds, ['tests']);
    assert.ok(cfg.adjustments.some((a) => a.path === 'apply.allowed_kinds' && a.by === file));
  } finally {
    rmSync(file, { force: true });
  }
});

test('the config schema accepts exactly the change kinds, and rejects unknown ones', () => {
  const schema = JSON.parse(readFileSync(new URL('../../../schemas/config.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.properties.apply.properties.allowed_kinds.items.enum, CHANGE_KINDS);
  const p = K.makeProject();
  assert.throws(() => K.configMod.loadConfig(p.ctx, { overrideRaw: { version: 1, apply: { allowed_kinds: ['anything'] } } }), (e) => e.code === 'UK_CONFIG_INVALID');
  assert.deepEqual(K.configMod.loadConfig(p.ctx, { overrideRaw: { version: 1, apply: { allowed_kinds: ['tests'] } } }).config.apply.allowed_kinds, ['tests']);
});

test('without allowed_kinds nothing is refused', () => {
  for (const k of CHANGE_KINDS) assert.deepEqual(refusedKinds(K.cfg(), { reach: [k], shape: [k] }), []);
});

test('the kind comes from paths, the declared surface and the diff, not the slice label', () => {
  const only = (list) => K.cfg({ apply: { allowed_kinds: list } });
  const body = (over) => ({ kind: 'code', scope: { include: ['src/a.js'] }, changes: [{ path: 'src/a.js', operation: 'modify', description: 'x' }], ...over });
  assert.deepEqual(refusedKinds(only(['tests', 'deletion']), plannedKinds(null, body())), ['refactor']);
  assert.deepEqual(refusedKinds(only(['tests']), plannedKinds(null, body({ scope: { include: ['test/a.test.js'] }, changes: [{ path: 'test/a.test.js', operation: 'modify', description: 'x' }] }))), []);
  assert.deepEqual(refusedKinds(only(['deletion']), plannedKinds(null, body({ changes: [{ path: 'src/a.js', operation: 'delete', description: 'x' }] }))), []);
  // A refactor label does not hide a Dockerfile, a migration or a declared public API change.
  assert.deepEqual(refusedKinds(only(['refactor']), plannedKinds(null, body({ changes: [{ path: 'svc/Dockerfile', operation: 'modify', description: 'x' }] }))), ['infrastructure']);
  assert.deepEqual(refusedKinds(only(['refactor']), plannedKinds(null, body({ changes: [{ path: 'db/migrations/1.sql', operation: 'modify', description: 'x' }] }))), ['migration']);
  assert.deepEqual(refusedKinds(only(['refactor']), plannedKinds(null, body({ surfaces: { public_api: true } }))), ['public-interface']);
  assert.deepEqual(refusedKinds(only(['refactor']), plannedKinds(null, body({ treatment: 'T1' }))), ['extraction']);
  // The staged diff: deleting lines from a Dockerfile is still an infrastructure change.
  assert.deepEqual(refusedKinds(only(['deletion']), diffKinds(body(), { paths: ['Dockerfile'], added: 0 })), ['infrastructure']);
  assert.deepEqual(refusedKinds(only(['tests', 'deletion']), diffKinds(body(), { paths: ['src/a.js'], added: 3 })), ['refactor']);
  assert.deepEqual(refusedKinds(only(['tests', 'deletion']), diffKinds(body(), { paths: ['src/a.js'], added: 0 })), []);
  assert.deepEqual(refusedKinds(only(['refactor']), diffKinds(body(), { paths: ['src/a.js'], added: 3 }, { publicSurfaceRemoved: true })), ['public-interface']);
});

test('container and deployment files are at least medium risk and protected with no configuration', () => {
  const files = ['Dockerfile', 'svc/Dockerfile', 'svc/Dockerfile.prod', 'web.dockerfile', 'docker-compose.yml', 'ops/docker-compose.override.yaml', 'compose.yaml', 'deploy/Chart.yaml', 'deploy/charts/web/templates/deploy.yaml', 'deploy/charts/web/values.yaml', 'helm/web/values.yaml'];
  for (const f of files) {
    const c = K.risk.classifyRisk({ kind: 'code', scope: { include: [f] }, changes: [{ path: f, operation: 'modify', description: 'x' }] }, { config: K.cfg() });
    assert.ok(K.defaults.riskRank(c.risk) >= K.defaults.riskRank('medium'), `${f} is ${c.risk}`);
    assert.ok(matchAny(f, K.DEFAULT_CONFIG.protected_paths, { nocase: true }), `${f} is protected by default`);
  }
  assert.ok(!matchAny('src/components/charts/Bar.tsx', K.DEFAULT_CONFIG.protected_paths, { nocase: true }), 'a UI charts folder is not a Helm chart');
});
