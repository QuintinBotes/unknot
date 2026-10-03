import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'uk-home-'));
process.env.UNKNOT_HOME = home;
delete process.env.CLAUDECODE;

const { generatePolicyKey, loadPolicyKey, signPolicyFile, trustKey, verifyPolicyDir, validateOrgPolicy, effectivePolicy } = await import('../../../runtime/enterprise/policy-bundle.mjs');
const { openProject } = await import('../../../runtime/context.mjs');

const POLICY = `max_mode: plan
approvers_locked: true
forbid_executables: [curl, wget]
protected_paths: ["**/secrets/**"]
limits:
  max_changed_files: 5
retention:
  runs: 7d
`;

function bundle(text = POLICY, name = 'org') {
  const dir = mkdtempSync(join(tmpdir(), 'uk-pol-'));
  const file = join(dir, 'org-policy.yaml');
  writeFileSync(file, text);
  generatePolicyKey(name, 'correct horse battery');
  return { dir, file };
}

test('sign, trust and verify round-trip', () => {
  const { dir, file } = bundle(POLICY, 'rt');
  const key = loadPolicyKey('rt', 'correct horse battery');
  const r = signPolicyFile(file, key);
  assert.match(r.key_fingerprint, /^sha256:/);
  trustKey(dir, 'rt');
  const v = verifyPolicyDir(dir);
  assert.equal(v.signed, true);
  assert.equal(v.valid, true);
  assert.equal(v.trusted_keys, 1);
});

test('a wrong passphrase cannot unlock the key', () => {
  generatePolicyKey('pw', 'correct horse battery');
  assert.throws(() => loadPolicyKey('pw', 'wrong passphrase!!'), (e) => e.code === 'UK_POLICY_DENIED');
  assert.throws(() => generatePolicyKey('short', 'short'), (e) => e.code === 'UK_CONFIG_INVALID');
});

test('tampering with a signed policy is rejected', () => {
  const { dir, file } = bundle(POLICY, 'tamper');
  signPolicyFile(file, loadPolicyKey('tamper', 'correct horse battery'));
  trustKey(dir, 'tamper');
  writeFileSync(file, readFileSync(file, 'utf8').replace('max_mode: plan', 'max_mode: campaign'));
  assert.throws(() => verifyPolicyDir(dir), (e) => e.code === 'UK_INTEGRITY');
});

test('a policy signed by an untrusted key is rejected, and a missing signature too', () => {
  const { dir, file } = bundle(POLICY, 'a');
  generatePolicyKey('b', 'correct horse battery');
  trustKey(dir, 'a');
  signPolicyFile(file, loadPolicyKey('b', 'correct horse battery'));
  assert.throws(() => verifyPolicyDir(dir), (e) => e.code === 'UK_INTEGRITY');
  rmSync(`${file}.sig`);
  assert.throws(() => verifyPolicyDir(dir), (e) => e.code === 'UK_INTEGRITY');
});

test('validation rejects unknown keys and bad organization-only fields', () => {
  assert.equal(validateOrgPolicy({ max_mode: 'plan', limits: { max_changed_files: 3 } }).valid, true);
  const typo = validateOrgPolicy({ max_mod: 'plan' });
  assert.equal(typo.valid, false);
  assert.match(typo.errors[0].message, /unknown top-level key/);
  assert.equal(validateOrgPolicy({ max_mode: 'turbo' }).valid, false);
  assert.equal(validateOrgPolicy({ approvers_locked: 'yes' }).valid, false);
  assert.equal(validateOrgPolicy({ forbid_executables: ['/bin/curl'] }).valid, false);
  assert.equal(validateOrgPolicy({ limits: { max_changed_files: 'many' } }).valid, false);
  const { file } = bundle('max_mod: plan\n', 'inv');
  assert.throws(() => signPolicyFile(file, loadPolicyKey('inv', 'correct horse battery')), (e) => e.code === 'UK_CONFIG_INVALID');
});

test('effective policy: organization policy tightens the repository config', () => {
  const project = mkdtempSync(join(tmpdir(), 'uk-proj-'));
  mkdirSync(join(project, '.unknot'));
  writeFileSync(join(project, '.unknot/config.yaml'), 'version: 1\nmode: governed\nlimits:\n  max_changed_files: 50\nretention:\n  runs: 90d\n');
  const ctx = openProject(project, { create: true });

  const before = effectivePolicy(ctx);
  assert.equal(before.config.mode, 'governed');
  assert.deepEqual(before.adjustments, []);

  // Install a signed policy where the runtime looks for the user-level bundle.
  const file = join(home, 'org-policy.yaml');
  writeFileSync(file, POLICY);
  generatePolicyKey('eff', 'correct horse battery');
  signPolicyFile(file, loadPolicyKey('eff', 'correct horse battery'));
  trustKey(home, 'eff');
  try {
    const after = effectivePolicy(ctx);
    assert.equal(after.config.mode, 'plan', 'max_mode caps the mode');
    assert.equal(after.config.limits.max_changed_files, 5, 'limits take the minimum');
    assert.equal(after.config.retention.runs, '7d', 'retention takes the shorter');
    assert.deepEqual(after.config.forbid_executables, ['curl', 'wget']);
    assert.ok(after.config.protected_paths.includes('**/secrets/**'), 'protected paths are unioned');
    assert.ok(after.config.protected_paths.includes('**/auth/**'), 'repository protections are kept');
    const paths = after.adjustments.map((a) => a.path);
    for (const p of ['mode', 'limits.max_changed_files', 'retention.runs']) assert.ok(paths.includes(p), p);
    assert.notEqual(after.digest, before.digest, 'the config digest changes, so approvals bound to it go stale');
    assert.equal(after.org[0].signed, true);
  } finally {
    rmSync(file);
    rmSync(`${file}.sig`);
    rmSync(join(home, 'trusted-keys'), { recursive: true });
  }
});
