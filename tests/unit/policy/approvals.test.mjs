import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import * as K from '../../helpers/kernel.mjs';

const { bindingFor, recordApproval, evaluateApprovals, invalidateApprovals, sliceDigest } = K.approvals;
const { classifyRisk, requiredApprovals } = K.risk;

after(() => K.cleanup());

const code = (c) => (e) => e?.code === c;
const PASS = 'correct horse battery';

// Approver identities are created once; key files live under the shared UNKNOT_HOME.
const pubs = {};
for (const n of ['alice', 'bob', 'carol', 'mallory']) pubs[n] = K.keys.generateApproverKey(`kt-${n}`, PASS);
const priv = (n) => K.keys.loadApproverKey(`kt-${n}`, PASS);

function registry(extra = {}) {
  return {
    'kt-alice': { roles: ['code-owner', 'affected-owner', 'security-owner'], public_key: pubs.alice },
    'kt-bob': { roles: ['security-owner', 'platform-owner'], public_key: pubs.bob },
    'kt-carol': { roles: ['code-owner'], public_key: pubs.carol },
    ...extra,
  };
}

function setup({ risk = 'low', body = {}, approvers = registry() } = {}) {
  const p = K.makeProject();
  const config = K.cfg({ approvers });
  const slice = K.insertSlice(p.ctx, { state: 'AWAITING_APPROVAL', risk, body });
  const binding = bindingFor({ slice, stage: 'change', commit: p.commit, policyDigest: 'sha256:pol', diffHash: 'sha256:diff', stateSerial: null, environment: 'local' });
  return { p, config, slice, binding, ctx: p.ctx };
}
const approve = (s, who, role, over = {}) =>
  recordApproval(s.ctx, { config: s.config, slice: s.slice, binding: s.binding, role, approver: `kt-${who}`, privateKey: priv(who), ...over });
const evaluate = (s, needed, current = s.binding, config = s.config) => evaluateApprovals(s.ctx, { config, slice: s.slice, current, needed });
const NEED1 = { roles: ['code-owner'], min_approvers: 1 };

describe('approver keys', () => {
  test('passphrase must be at least 8 characters; names are validated', () => {
    assert.throws(() => K.keys.generateApproverKey('kt-short', '1234567'), code('UK_CONFIG_INVALID'));
    assert.throws(() => K.keys.generateApproverKey('kt-short', undefined), code('UK_CONFIG_INVALID'));
    for (const bad of ['', '../x', 'a b', 'a/b', 'x'.repeat(65)]) assert.throws(() => K.keys.generateApproverKey(bad, PASS), code('UK_CONFIG_INVALID'), bad);
    assert.doesNotThrow(() => K.keys.generateApproverKey('kt-eight', '12345678'));
  });

  test('keys are 0600 files, encrypted, and unlock only with the passphrase', () => {
    const file = join(K.keys.approverDir(), 'kt-alice.pem');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(() => K.keys.loadApproverKey('kt-alice', 'wrong passphrase'), code('UK_POLICY_DENIED'));
    assert.throws(() => K.keys.loadApproverKey('kt-alice', ''), code('UK_POLICY_DENIED'));
    assert.throws(() => K.keys.loadApproverKey('kt-nobody', PASS), code('UK_NOT_FOUND'));
    assert.equal(K.keys.publicKeyOf(priv('alice')), pubs.alice);
  });

  test('regenerating an existing name never overwrites it', () => {
    assert.throws(() => K.keys.generateApproverKey('kt-alice', PASS), /EEXIST/);
    assert.equal(K.keys.publicKeyOf(priv('alice')), pubs.alice);
  });
});

describe('bindingFor', () => {
  test('rejects unknown stage; change/rollback need a diff hash; plan does not', () => {
    const p = K.makeProject();
    const slice = K.insertSlice(p.ctx);
    const base = { slice, commit: 'c', policyDigest: 'p' };
    assert.throws(() => bindingFor({ ...base, stage: 'deploy' }), code('UK_SCHEMA_INVALID'));
    assert.throws(() => bindingFor({ ...base, stage: 'change' }), code('UK_APPROVAL_REQUIRED'));
    assert.throws(() => bindingFor({ ...base, stage: 'rollback' }), code('UK_APPROVAL_REQUIRED'));
    assert.equal(bindingFor({ ...base, stage: 'plan' }).diff_hash, null);
  });

  test('captures every bound field and an expiry from the configured duration', () => {
    const p = K.makeProject();
    const slice = K.insertSlice(p.ctx);
    K.clock.setClock(() => new Date('2030-01-01T00:00:00Z'));
    const b = bindingFor({ slice, stage: 'change', commit: 'c1', policyDigest: 'p1', diffHash: 'd1', planHash: 'pl', stateSerial: 7, environment: 'prod', expiry: '2h' });
    assert.deepEqual(
      [b.commit, b.slice_id, b.slice_version, b.diff_hash, b.plan_hash, b.state_serial, b.policy_digest, b.environment, b.stage, b.expires_at],
      ['c1', slice.id, 1, 'd1', 'pl', 7, 'p1', 'prod', 'change', '2030-01-01T02:00:00.000Z'],
    );
    assert.equal(b.slice_digest, sliceDigest(slice.body));
  });

  test('sliceDigest ignores lifecycle fields only', () => {
    const body = { id: 'UK-1', objective: 'o', scope: { include: ['a'] } };
    assert.equal(sliceDigest({ ...body, status: 'x', state: 'y', approvals_recorded: 3, updated_at: 'now' }), sliceDigest(body));
    assert.notEqual(sliceDigest({ ...body, objective: 'o2' }), sliceDigest(body));
    assert.notEqual(sliceDigest({ ...body, scope: { include: ['a', 'b'] } }), sliceDigest(body));
  });
});

describe('recordApproval', () => {
  test('stores a signed row, binding hash and ledger event', () => {
    const s = setup();
    const row = approve(s, 'alice', 'code-owner');
    assert.equal(row.approver, 'kt-alice');
    assert.equal(row.binding_hash, K.canonical.digest(s.binding));
    assert.equal(row.key_fingerprint, K.keys.keyFingerprint(pubs.alice));
    const ev = K.ledger.readEvents(s.ctx.store, { type: 'approval.recorded' });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].actor, 'human:kt-alice');
    assert.equal(ev[0].payload.binding_hash, row.binding_hash);
    assert.equal(K.ledger.verifyLedger(s.ctx.store, s.ctx.store.meta('audit_public_key')).ok, true);
  });

  test('unregistered approver, missing role, and wrong key are all refused and record nothing', () => {
    const s = setup();
    const n = () => s.ctx.store.get('SELECT COUNT(*) AS n FROM approvals').n;
    assert.throws(() => approve(s, 'alice', 'code-owner', { approver: 'kt-ghost' }), code('UK_POLICY_DENIED'));
    assert.throws(() => approve(s, 'carol', 'security-owner'), (e) => e.code === 'UK_POLICY_DENIED' && /role/.test(e.message));
    assert.throws(() => approve(s, 'alice', 'code-owner', { privateKey: priv('mallory') }), (e) => e.code === 'UK_POLICY_DENIED' && /registered key/.test(e.message));
    assert.throws(() => approve(s, 'mallory', 'code-owner', { approver: 'kt-alice' }), code('UK_POLICY_DENIED'));
    assert.equal(n(), 0);
    assert.equal(s.ctx.store.get("SELECT COUNT(*) AS n FROM events WHERE type = 'approval.recorded'").n, 0);
  });

  test('the proposer cannot approve their own high or critical slice, but can approve low/medium', () => {
    for (const [risk, blocked] of [['low', false], ['medium', false], ['high', true], ['critical', true]]) {
      const s = setup({ risk, body: { proposed_by: 'human:kt-alice' } });
      if (blocked) assert.throws(() => approve(s, 'alice', 'code-owner'), (e) => e.code === 'UK_POLICY_DENIED' && /proposed/.test(e.message), risk);
      else assert.doesNotThrow(() => approve(s, 'alice', 'code-owner'), risk);
    }
    const s = setup({ risk: 'high', body: { proposed_by: 'human:kt-alice' } });
    assert.doesNotThrow(() => approve(s, 'carol', 'code-owner'), 'someone else may approve');
  });
});

describe('evaluateApprovals', () => {
  test('satisfied with the required role; not satisfied with none', () => {
    const s = setup();
    assert.equal(evaluate(s, NEED1).satisfied, false);
    assert.deepEqual(evaluate(s, NEED1).missing_roles, ['code-owner']);
    approve(s, 'carol', 'code-owner');
    const r = evaluate(s, NEED1);
    assert.equal(r.satisfied, true);
    assert.equal(r.approvers, 1);
    assert.deepEqual(r.stale, []);
  });

  test('every required role must be covered', () => {
    const s = setup();
    const needed = { roles: ['code-owner', 'security-owner', 'platform-owner'], min_approvers: 1 };
    approve(s, 'carol', 'code-owner');
    assert.deepEqual(evaluate(s, needed).missing_roles, ['security-owner', 'platform-owner']);
    approve(s, 'alice', 'security-owner');
    assert.deepEqual(evaluate(s, needed).missing_roles, ['platform-owner']);
    approve(s, 'bob', 'platform-owner');
    assert.equal(evaluate(s, needed).satisfied, true);
  });

  test('critical needs enough distinct people, not just distinct roles', () => {
    const s = setup({ risk: 'critical' });
    const needed = { roles: ['code-owner', 'security-owner'], min_approvers: 2 };
    approve(s, 'alice', 'code-owner');
    approve(s, 'alice', 'security-owner');
    const one = evaluate(s, needed);
    assert.deepEqual(one.missing_roles, []);
    assert.equal(one.approvers, 1);
    assert.equal(one.satisfied, false, 'one person holding two roles is not two approvers');
    approve(s, 'bob', 'security-owner');
    assert.equal(evaluate(s, needed).satisfied, true);
  });

  test('the same approver approving twice still counts once', () => {
    const s = setup();
    approve(s, 'alice', 'code-owner');
    approve(s, 'alice', 'code-owner');
    assert.equal(evaluate(s, { roles: ['code-owner'], min_approvers: 2 }).satisfied, false);
  });

  test('approvals for another stage or another slice do not count', () => {
    const s = setup();
    const plan = bindingFor({ slice: s.slice, stage: 'plan', commit: s.p.commit, policyDigest: 'sha256:pol' });
    recordApproval(s.ctx, { config: s.config, slice: s.slice, binding: plan, role: 'code-owner', approver: 'kt-carol', privateKey: priv('carol') });
    assert.equal(evaluate(s, NEED1).satisfied, false, 'plan approval is not a change approval');
    assert.equal(evaluate(s, NEED1, plan).satisfied, true);
    const other = K.insertSlice(s.ctx, { state: 'AWAITING_APPROVAL' });
    assert.equal(evaluateApprovals(s.ctx, { config: s.config, slice: other, current: { ...s.binding, slice_id: other.id }, needed: NEED1 }).satisfied, false);
  });

  const FIELDS = {
    commit: 'deadbeef', slice_version: 2, slice_digest: 'sha256:other', diff_hash: 'sha256:newdiff', plan_hash: 'sha256:plan',
    state_serial: 99, policy_digest: 'sha256:newpolicy', environment: 'prod',
  };
  for (const [field, value] of Object.entries(FIELDS)) {
    test(`stale when ${field} changes`, () => {
      const s = setup();
      approve(s, 'carol', 'code-owner');
      const r = evaluate(s, NEED1, { ...s.binding, [field]: value });
      assert.equal(r.satisfied, false);
      assert.equal(r.valid.length, 0);
      assert.deepEqual(r.stale[0].reasons, [`${field} changed`]);
    });
  }

  test('stale when the slice body changes (new digest via bindingFor)', () => {
    const s = setup();
    approve(s, 'carol', 'code-owner');
    const changed = { ...s.slice.body, objective: 'something else entirely', scope: { include: ['**'], exclude: [] } };
    s.ctx.store.update('slices', s.slice.id, s.slice.version, { body: changed });
    const slice2 = K.loadSlice(s.ctx, s.slice.id);
    const current = bindingFor({ slice: slice2, stage: 'change', commit: s.p.commit, policyDigest: 'sha256:pol', diffHash: 'sha256:diff', environment: 'local' });
    const r = evaluateApprovals(s.ctx, { config: s.config, slice: slice2, current, needed: NEED1 });
    assert.equal(r.satisfied, false);
    assert.ok(r.stale[0].reasons.includes('slice_digest changed'));
  });

  test('unchanged lifecycle fields do not make an approval stale', () => {
    const s = setup();
    approve(s, 'carol', 'code-owner');
    const body = { ...s.slice.body, status: 'ready', state: 'PATCHING', updated_at: 'later', approvals_recorded: 1 };
    s.ctx.store.update('slices', s.slice.id, s.slice.version, { body });
    const slice2 = K.loadSlice(s.ctx, s.slice.id);
    const current = { ...s.binding, slice_digest: sliceDigest(slice2.body) };
    assert.equal(evaluateApprovals(s.ctx, { config: s.config, slice: slice2, current, needed: NEED1 }).satisfied, true);
  });

  test('stale when expired; fresh just before expiry', () => {
    const s = setup();
    approve(s, 'carol', 'code-owner');
    const exp = new Date(s.binding.expires_at).getTime();
    K.clock.setClock(() => new Date(exp - 1000));
    assert.equal(evaluate(s, NEED1).satisfied, true);
    K.clock.setClock(() => new Date(exp));
    const r = evaluate(s, NEED1);
    assert.equal(r.satisfied, false);
    assert.deepEqual(r.stale[0].reasons, ['expired']);
    K.clock.resetClock();
  });

  test('stale when the approver is removed or loses the role', () => {
    const s = setup();
    approve(s, 'carol', 'code-owner');
    const removed = { ...s.config, approvers: Object.fromEntries(Object.entries(s.config.approvers).filter(([k]) => k !== 'kt-carol')) };
    const r1 = evaluate(s, NEED1, s.binding, removed);
    assert.equal(r1.satisfied, false);
    assert.match(r1.stale[0].reasons[0], /no longer registered/);
    const demoted = { ...s.config, approvers: { ...s.config.approvers, 'kt-carol': { roles: [], public_key: pubs.carol } } };
    assert.match(evaluate(s, NEED1, s.binding, demoted).stale[0].reasons[0], /no longer holds the role/);
  });

  test('stale when the registered key was rotated (old signature no longer verifies)', () => {
    const s = setup();
    approve(s, 'carol', 'code-owner');
    const rotated = { ...s.config, approvers: { ...s.config.approvers, 'kt-carol': { roles: ['code-owner'], public_key: pubs.mallory } } };
    const r = evaluate(s, NEED1, s.binding, rotated);
    assert.equal(r.satisfied, false);
    assert.match(r.stale[0].reasons[0], /signature/);
  });

  test('a signature made over a different statement is rejected', () => {
    const s = setup();
    const row = approve(s, 'carol', 'code-owner');
    const other = approve(s, 'alice', 'code-owner');
    s.ctx.store.run('UPDATE approvals SET signature = ? WHERE id = ?', other.signature, row.id);
    const r = evaluate(s, NEED1);
    assert.ok(r.stale.some((x) => x.id === row.id && /signature/.test(x.reasons.join())));
    assert.equal(r.valid.length, 1, 'only the untouched alice approval remains valid');
  });

  test('tampering with stored fields invalidates the signature', () => {
    const tamper = [
      ['expires_at extension in binding', (s, row) => s.ctx.store.run('UPDATE approvals SET binding = ? WHERE id = ?', JSON.stringify({ ...s.binding, expires_at: '2999-01-01T00:00:00.000Z' }), row.id)],
      ['approver swapped to a registered key-holder', (s, row) => s.ctx.store.run("UPDATE approvals SET approver = 'kt-alice' WHERE id = ?", row.id)],
      ['role swapped', (s, row) => s.ctx.store.run("UPDATE approvals SET role = 'security-owner' WHERE id = ?", row.id)],
    ];
    for (const [name, fn] of tamper) {
      const s = setup();
      const row = approve(s, 'carol', 'code-owner');
      fn(s, row);
      const r = evaluate(s, { roles: [], min_approvers: 0 });
      assert.equal(r.valid.length, 0, name);
      assert.equal(r.stale.length, 1, name);
    }
  });

  test('re-pointing an approval at a different slice makes it stale (slice_id is bound)', () => {
    const s = setup();
    const row = approve(s, 'carol', 'code-owner');
    const other = K.insertSlice(s.ctx, { state: 'AWAITING_APPROVAL' });
    s.ctx.store.run('UPDATE approvals SET slice_id = ? WHERE id = ?', other.id, row.id);
    const r = evaluateApprovals(s.ctx, { config: s.config, slice: other, current: { ...s.binding, slice_id: other.id, slice_digest: sliceDigest(other.body) }, needed: NEED1 });
    assert.equal(r.satisfied, false);
    assert.ok(r.stale[0].reasons.includes('slice_id changed'));
  });
});

describe('invalidateApprovals', () => {
  test('revokes every live approval, logs once, and later evaluations exclude them', () => {
    const s = setup();
    approve(s, 'carol', 'code-owner');
    approve(s, 'alice', 'security-owner');
    assert.equal(evaluate(s, NEED1).satisfied, true);
    assert.equal(invalidateApprovals(s.ctx, s.slice, 'scope changed'), 2);
    const r = evaluate(s, NEED1);
    assert.equal(r.satisfied, false);
    assert.equal(r.valid.length + r.stale.length, 0);
    const ev = K.ledger.readEvents(s.ctx.store, { type: 'approval.invalidated' });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.reason, 'scope changed');
    assert.equal(invalidateApprovals(s.ctx, s.slice, 'again'), 0);
    assert.equal(s.ctx.store.all('SELECT revoked_reason FROM approvals')[0].revoked_reason, 'scope changed');
  });

  test('revokes across stages, but not other slices', () => {
    const s = setup();
    approve(s, 'carol', 'code-owner');
    const plan = bindingFor({ slice: s.slice, stage: 'plan', commit: s.p.commit, policyDigest: 'p' });
    recordApproval(s.ctx, { config: s.config, slice: s.slice, binding: plan, role: 'code-owner', approver: 'kt-carol', privateKey: priv('carol') });
    const other = K.insertSlice(s.ctx);
    const ob = bindingFor({ slice: other, stage: 'plan', commit: s.p.commit, policyDigest: 'p' });
    recordApproval(s.ctx, { config: s.config, slice: other, binding: ob, role: 'code-owner', approver: 'kt-carol', privateKey: priv('carol') });
    assert.equal(invalidateApprovals(s.ctx, s.slice, 'x'), 2);
    assert.equal(s.ctx.store.get('SELECT COUNT(*) AS n FROM approvals WHERE revoked_at IS NULL').n, 1);
  });
});

describe('classifyRisk (spec 20)', () => {
  const cfg = K.cfg();
  const classify = (slice, surfaces) => classifyRisk(slice, { config: cfg, surfaces });
  const ch = (...paths) => ({ changes: paths.map((path) => ({ path })) });

  test('plain source changes are low risk', () => {
    const r = classify(ch('src/util/strings.js'));
    assert.equal(r.risk, 'low');
    assert.deepEqual(r.specialists, []);
  });

  test('medium: boundary treatments, module boundary, dependency manifests', () => {
    for (const t of ['T1', 'T2', 'T4', 'T5', 'T8']) assert.equal(classify({ ...ch('src/a.js'), treatment: t }).risk, 'medium', t);
    assert.equal(classify(ch('src/a.js'), { module_boundary: true }).risk, 'medium');
    assert.equal(classify(ch('src/a.js'), { internal_contract: true }).risk, 'medium');
    for (const f of ['package.json', 'svc/pnpm-lock.yaml', 'requirements-dev.txt', 'go.mod', 'Cargo.lock', 'pom.xml', 'src/Orders/Orders.csproj', 'Lib/Lib.fsproj', 'a/Directory.Packages.props', 'src/packages.config']) assert.equal(classify(ch(f)).risk, 'medium', f);
    assert.equal(classify(ch('src/a.js'), { dependency_change: true }).risk, 'medium');
  });

  test('high: authentication, crypto, permissions and public API', () => {
    for (const f of ['src/auth/login.js', 'src/Auth/Login.js', 'lib/crypto/aes.js', 'a/rbac/roles.js', 'a/security/x.js', 'src/session/store.js', 'svc/authz/policy.js', 'src/oauth.js']) {
      const r = classify(ch(f));
      assert.equal(r.risk, 'high', f);
      assert.ok(r.specialists.includes('security-owner'), f);
    }
    assert.equal(classify(ch('src/a.js'), { public_api: true }).risk, 'high');
    assert.equal(classify(ch('src/a.js'), { destructive_infra: true }).risk, 'high');
  });

  test('high: migrations and database slices need a data owner', () => {
    for (const f of ['db/migrations/001.sql', 'x/schema.prisma', 'a/alembic/versions/1.py', 'queries/report.sql']) {
      const r = classify(ch(f));
      assert.equal(r.risk, 'high', f);
      assert.ok(r.specialists.includes('data-owner'), f);
    }
    assert.equal(classify({ kind: 'database', changes: [] }).risk, 'high');
  });

  test('infrastructure is medium, and high when it touches IAM, networking or gateways', () => {
    const base = classify(ch('infra/main.tf'));
    assert.equal(base.risk, 'medium');
    assert.deepEqual(base.specialists, ['platform-owner']);
    const iam = classify({ changes: [{ path: 'infra/main.tf', note: 'aws_iam_role_policy attachment' }] });
    assert.equal(iam.risk, 'high');
    assert.ok(iam.specialists.includes('security-owner'));
    for (const hint of ['security_group ingress 0.0.0.0/0', 'dns record change', 'load_balancer listener', 'vpc subnet route']) {
      assert.equal(classify({ changes: [{ path: 'k8s/app.yaml', note: hint }] }).risk, 'high', hint);
    }
    assert.equal(classify({ kind: 'infrastructure', changes: [] }).risk, 'medium');
    assert.equal(classify({ objective: 'grant iam permission', kind: 'infrastructure', changes: [] }).risk, 'high');
  });

  test('critical: data movement, recovery posture, tenant boundary, irreversible steps', () => {
    assert.equal(classify(ch('src/a.js'), { data_movement: true }).risk, 'critical');
    assert.equal(classify({ kind: 'database', objective: 'backfill orders', changes: [] }).risk, 'critical');
    assert.equal(classify({ kind: 'database', objective: 'switch_writes to new table', changes: [] }).risk, 'critical');
    assert.equal(classify({ kind: 'database', objective: 'reduce backup retention', changes: [] }).risk, 'critical');
    assert.equal(classify({ kind: 'infrastructure', objective: 'disable replica failover', changes: [] }).risk, 'critical');
    assert.equal(classify(ch('src/a.js'), { tenant_boundary: true }).risk, 'critical');
    assert.equal(classify({ ...ch('src/a.js'), irreversible: true }).risk, 'critical');
  });

  test('a non-database slice mentioning "backup" is not critical on its own', () => {
    assert.notEqual(classify({ objective: 'rename backup helper', changes: [{ path: 'src/a.js' }] }).risk, 'critical');
  });

  test('protected paths from config raise to high', () => {
    assert.equal(classifyRisk(ch('.github/workflows/ci.yml'), { config: cfg }).risk, 'high');
    assert.equal(classifyRisk(ch('src/a.js'), { config: K.cfg({ protected_paths: ['src/a.js'] }) }).risk, 'high');
  });

  test('scope.include globs also count as touched paths', () => {
    assert.equal(classify({ scope: { include: ['src/auth/**'] }, changes: [] }).risk, 'high');
  });

  test('a slice cannot lower its own risk; declared risk only raises', () => {
    assert.equal(classify({ ...ch('src/auth/x.js'), declared_risk: 'low' }).risk, 'high');
    assert.equal(classify({ ...ch('src/a.js'), declared_risk: 'critical' }).risk, 'critical');
    assert.equal(classify({ ...ch('src/auth/x.js'), declared_risk: 'medium', risk: 'low' }).risk, 'high');
  });

  test('the highest signal wins and every reason is recorded', () => {
    const r = classify({ ...ch('src/auth/x.js', 'package.json'), irreversible: true });
    assert.equal(r.risk, 'critical');
    assert.ok(r.reasons.length >= 3);
  });
});

describe('requiredApprovals', () => {
  const need = (slice, surfaces, config = K.cfg()) => requiredApprovals(classifyRisk(slice, { config, surfaces }), config);
  const ch = (...paths) => ({ changes: paths.map((path) => ({ path })) });

  test('low: code-owner, one approver', () => {
    assert.deepEqual(need(ch('src/a.js')), { roles: ['code-owner'], min_approvers: 1 });
  });

  test('medium: code-owner + affected-owner', () => {
    assert.deepEqual(need(ch('package.json')), { roles: ['affected-owner', 'code-owner'], min_approvers: 1 });
  });

  test('high: code-owner + the matching specialists', () => {
    assert.deepEqual(need(ch('src/auth/x.js')), { roles: ['code-owner', 'security-owner'], min_approvers: 1 });
    assert.deepEqual(need(ch('db/migrations/1.sql')), { roles: ['code-owner', 'data-owner'], min_approvers: 1 });
  });

  test('high with no identifiable specialist falls back to security-owner', () => {
    assert.deepEqual(need(ch('src/a.js'), { public_api: true }), { roles: ['code-owner', 'security-owner'], min_approvers: 1 });
  });

  test('critical: roles plus two distinct approvers (or the configured minimum)', () => {
    const r = need({ ...ch('db/migrations/1.sql'), irreversible: true });
    assert.deepEqual(r, { roles: ['code-owner', 'data-owner'], min_approvers: 2 });
    assert.equal(need(ch('src/a.js'), { tenant_boundary: true }).min_approvers, 2);
    const strict = K.cfg({ approvals: { critical_min_approvers: 4 } });
    assert.equal(need({ ...ch('src/a.js'), irreversible: true }, {}, strict).min_approvers, 4);
    const lax = K.cfg({ approvals: { critical_min_approvers: 1 } });
    assert.equal(need({ ...ch('src/a.js'), irreversible: true }, {}, lax).min_approvers, 2, 'never below two for critical');
  });

  test('only critical needs more than one approver', () => {
    for (const s of [ch('src/a.js'), ch('package.json'), ch('src/auth/x.js')]) assert.equal(need(s).min_approvers, 1);
  });

  test('configured role lists are honoured', () => {
    const config = K.cfg({ approvals: { low: ['qa'] } });
    assert.deepEqual(need(ch('src/a.js'), {}, config).roles, ['qa']);
  });

  test('end to end: critical slice needs two people and every specialist role', () => {
    const s = setup({ risk: 'critical' });
    const needed = need({ ...ch('db/migrations/1.sql'), irreversible: true });
    const reg = { ...registry(), 'kt-dave': { roles: ['data-owner'], public_key: pubs.mallory } };
    s.config = K.cfg({ approvers: reg });
    approve(s, 'carol', 'code-owner');
    assert.equal(evaluate(s, needed).satisfied, false);
    recordApproval(s.ctx, { config: s.config, slice: s.slice, binding: s.binding, role: 'data-owner', approver: 'kt-dave', privateKey: priv('mallory') });
    assert.equal(evaluate(s, needed).satisfied, true);
  });
});
