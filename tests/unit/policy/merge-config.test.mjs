import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as K from '../../helpers/kernel.mjs';

const { applyOrgPolicy, overlay } = K.merge;
const { loadPolicyBundle, loadConfig } = K.policyConfig;
const { modeRank, riskRank, LADDERS, MODES } = K.defaults;

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  K.cleanup();
});

const merged = (repo, org) => applyOrgPolicy(repo, org).config;
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'uk-pol-'));
  dirs.push(d);
  return d;
};

describe('applyOrgPolicy: tighten-only', () => {
  test('no org policy is the identity', () => {
    const repo = K.cfg();
    const r = applyOrgPolicy(repo, null);
    assert.equal(r.config, repo);
    assert.deepEqual(r.adjustments, []);
  });

  test('the repo config object is never mutated', () => {
    const repo = K.cfg({ mode: 'campaign' });
    const snapshot = structuredClone(repo);
    applyOrgPolicy(repo, { max_mode: 'plan', limits: { max_diff_lines: 1 }, protected_paths: ['x/**'] });
    assert.deepEqual(repo, snapshot);
  });

  test('max_mode clamps a higher repo mode, never raises a lower one', () => {
    for (const repoMode of MODES) {
      for (const max of MODES) {
        const out = merged(K.cfg({ mode: repoMode }), { max_mode: max });
        assert.equal(modeRank(out.mode), Math.min(modeRank(repoMode), modeRank(max)), `${repoMode} under ${max}`);
      }
    }
  });

  test('org `mode` also clamps, and an unknown max_mode is ignored', () => {
    assert.equal(merged(K.cfg({ mode: 'campaign' }), { mode: 'assist' }).mode, 'assist');
    assert.equal(merged(K.cfg({ mode: 'campaign' }), { max_mode: 'turbo' }).mode, 'campaign');
  });

  test('limits take the minimum; null repo limits take the org value; non-numeric org values ignored', () => {
    const out = merged(K.cfg({ limits: { max_diff_lines: 100, max_changed_files: 5, max_turns: null } }), {
      limits: { max_diff_lines: 400, max_changed_files: 2, max_turns: 20, max_commands: 'lots' },
    });
    assert.equal(out.limits.max_diff_lines, 100);
    assert.equal(out.limits.max_changed_files, 2);
    assert.equal(out.limits.max_turns, 20);
    assert.equal(out.limits.max_commands, 200);
  });

  test('limits: the result is <= both inputs for every numeric limit', () => {
    for (const [k, def] of Object.entries(K.DEFAULT_CONFIG.limits)) {
      if (typeof def !== 'number') continue;
      for (const [r, o] of [[def, def * 2 + 1], [def * 2 + 1, def], [0, 5], [5, 0]]) {
        const out = merged(K.cfg({ limits: { [k]: r } }), { limits: { [k]: o } }).limits[k];
        assert.equal(out, Math.min(r, o), `${k}: ${r} vs ${o}`);
      }
    }
  });

  test('ladders: result is at least as strict as both sides, for every ladder and value pair', () => {
    const get = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
    for (const [path, ladder] of Object.entries(LADDERS)) {
      for (const repoV of ladder) {
        for (const orgV of ladder) {
          const repo = K.cfg();
          const keys = path.split('.');
          repo[keys[0]][keys[1]] = repoV;
          const org = { [keys[0]]: { [keys[1]]: orgV } };
          const out = get(merged(repo, org), path);
          const rank = (v) => ladder.indexOf(v);
          assert.ok(rank(out) >= rank(repoV) && rank(out) >= rank(orgV), `${path}: repo ${repoV}, org ${orgV} -> ${out}`);
        }
      }
    }
  });

  test('ladder specifics: repo cannot loosen secrets_scan / sast / dependency_changes', () => {
    const repo = K.cfg({ security: { secrets_scan: 'off', sast: 'off', dependency_changes: 'allowed' } });
    const out = merged(repo, { security: { secrets_scan: 'required', sast: 'required_for_high_risk', dependency_changes: 'forbidden' } });
    assert.equal(out.security.secrets_scan, 'required');
    assert.equal(out.security.sast, 'required_for_high_risk');
    assert.equal(out.security.dependency_changes, 'forbidden');
    const stricterRepo = K.cfg({ security: { sast: 'required' } });
    assert.equal(merged(stricterRepo, { security: { sast: 'optional' } }).security.sast, 'required');
  });

  test('database.live_access stays disabled when the repo says disabled and org allows metadata', () => {
    const repo = K.cfg({ database: { live_access: 'disabled' } });
    assert.equal(merged(repo, { database: { live_access: 'read_only_metadata' } }).database.live_access, 'disabled');
    const loose = K.cfg({ database: { live_access: 'read_only_metadata' } });
    assert.equal(merged(loose, { database: { live_access: 'disabled' } }).database.live_access, 'disabled');
  });

  test('protected_paths, generated_paths, scope.exclude and redact_patterns are unions', () => {
    const repo = K.cfg({ protected_paths: ['a/**'], generated_paths: ['g/**'], scope: { exclude: ['e/**'] }, security: { redact_patterns: ['r1'] } });
    const out = merged(repo, { protected_paths: ['b/**', 'a/**'], generated_paths: ['h/**'], scope: { exclude: ['f/**'] }, security: { redact_patterns: ['r2'] } });
    assert.deepEqual(out.protected_paths, ['a/**', 'b/**']);
    assert.deepEqual(out.generated_paths, ['g/**', 'h/**']);
    assert.deepEqual(out.scope.exclude, ['e/**', 'f/**']);
    assert.deepEqual(out.security.redact_patterns, ['r1', 'r2']);
  });

  test('a repo cannot drop an org-protected path by listing nothing', () => {
    const out = merged(K.cfg({ protected_paths: [] }), { protected_paths: ['infra/prod/**'] });
    assert.ok(out.protected_paths.includes('infra/prod/**'));
  });

  test('approvals: role lists are unions, min approvers max, expiry min', () => {
    const repo = K.cfg({ approvals: { high: ['code-owner'], critical_min_approvers: 2, expiry: '48h' } });
    const out = merged(repo, { approvals: { high: ['security-owner'], critical: ['cto'], critical_min_approvers: 3, expiry: '24h' } });
    assert.deepEqual(out.approvals.high.sort(), ['code-owner', 'security-owner']);
    assert.ok(out.approvals.critical.includes('cto') && out.approvals.critical.includes('code-owner'));
    assert.equal(out.approvals.critical_min_approvers, 3);
    assert.equal(out.approvals.expiry, '24h');
    assert.equal(merged(K.cfg({ approvals: { expiry: '1h' } }), { approvals: { expiry: '24h' } }).approvals.expiry, '1h');
    assert.equal(merged(K.cfg({ approvals: { expiry: '90m' } }), { approvals: { expiry: '1h' } }).approvals.expiry, '1h');
    assert.equal(merged(K.cfg({ approvals: { critical_min_approvers: 5 } }), { approvals: { critical_min_approvers: 3 } }).approvals.critical_min_approvers, 5);
  });

  test('approvers: org entries override same-named repo entries; locked replaces the repo set', () => {
    const repo = K.cfg({ approvers: { alice: { roles: ['code-owner'], public_key: 'REPO' }, mallory: { roles: ['security-owner'], public_key: 'M' } } });
    const open = merged(repo, { approvers: { alice: { roles: ['code-owner'], public_key: 'ORG' } } });
    assert.equal(open.approvers.alice.public_key, 'ORG');
    assert.ok(open.approvers.mallory);
    const locked = merged(repo, { approvers: { alice: { roles: ['code-owner'], public_key: 'ORG' } }, approvers_locked: true });
    assert.deepEqual(Object.keys(locked.approvers), ['alice']);
    assert.equal(locked.approvers.alice.public_key, 'ORG');
  });

  test('telemetry: org enabled:false forces off; org true does not force on', () => {
    assert.equal(merged(K.cfg({ telemetry: { enabled: true } }), { telemetry: { enabled: false } }).telemetry.enabled, false);
    assert.equal(merged(K.cfg({ telemetry: { enabled: false } }), { telemetry: { enabled: true } }).telemetry.enabled, false);
  });

  test('network.allowed_domains is an intersection', () => {
    const out = merged(K.cfg({ network: { allowed_domains: ['a.com', 'b.com'] } }), { network: { allowed_domains: ['b.com', 'c.com'] } });
    assert.deepEqual(out.network.allowed_domains, ['b.com']);
    assert.deepEqual(merged(K.cfg({ network: { allowed_domains: ['a.com'] } }), { network: { allowed_domains: ['z.com'] } }).network.allowed_domains, []);
  });

  test('network: a repo with no allowed domains gains none from the org list', () => {
    assert.deepEqual(merged(K.cfg(), { network: { allowed_domains: ['a.com'] } }).network.allowed_domains, []);
  });

  test('mcp.allowed_servers is an intersection', () => {
    const out = merged(K.cfg({ mcp: { allowed_servers: ['x', 'y'] } }), { mcp: { allowed_servers: ['y', 'z'] } });
    assert.deepEqual(out.mcp.allowed_servers, ['y']);
    assert.deepEqual(merged(K.cfg({ mcp: { allowed_servers: ['x'] } }), { mcp: { allowed_servers: ['z'] } }).mcp.allowed_servers, []);
  });

  test('mcp: a repo that allows no servers gains none from the org list',
    {},
    () => {
      assert.deepEqual(merged(K.cfg(), { mcp: { allowed_servers: ['github'] } }).mcp.allowed_servers, []);
    });

  test('scope.include: an org include restricts a repo that had none', () => {
    assert.deepEqual(merged(K.cfg(), { scope: { include: ['services/**'] } }).scope.include, ['services/**']);
    assert.deepEqual(merged(K.cfg({ scope: { include: ['a/**', 'b/**'] } }), { scope: { include: ['b/**'] } }).scope.include, ['b/**']);
  });

  test('scope.include: disjoint repo/org includes must not collapse to "everything"',
    {},
    () => {
      const out = merged(K.cfg({ scope: { include: ['src/**'] } }), { scope: { include: ['lib/**'] } });
      assert.ok(out.scope.include.length > 0 || out.scope.exclude.includes('**'), `include=${JSON.stringify(out.scope.include)}`);
    });

  test('boolean hardening flags and complexity', () => {
    const repo = K.cfg({ quality: { forbid_new_cycles: false, max_complexity_increase: 10 }, security: { require_os_sandbox: false }, infrastructure: { require_saved_plan: false } });
    const out = merged(repo, { quality: { forbid_new_cycles: true, max_complexity_increase: 2 }, security: { require_os_sandbox: true }, infrastructure: { require_saved_plan: true } });
    assert.equal(out.quality.forbid_new_cycles, true);
    assert.equal(out.quality.max_complexity_increase, 2);
    assert.equal(out.security.require_os_sandbox, true);
    assert.equal(out.infrastructure.require_saved_plan, true);
    assert.equal(merged(K.cfg({ quality: { max_complexity_increase: 1 } }), { quality: { max_complexity_increase: 5 } }).quality.max_complexity_increase, 1);
  });

  test('retention takes the shorter duration; forbid_executables unions', () => {
    const out = merged(K.cfg({ retention: { runs: '30d', cache: '2d' } }), { retention: { runs: '7d', cache: '10d' }, forbid_executables: ['curl'] });
    assert.deepEqual([out.retention.runs, out.retention.cache], ['7d', '2d']);
    assert.deepEqual(out.forbid_executables, ['curl']);
    assert.deepEqual(merged({ ...K.cfg(), forbid_executables: ['wget'] }, { forbid_executables: ['curl'] }).forbid_executables, ['wget', 'curl']);
  });

  test('adjustments record only values the org actually changed', () => {
    const r = applyOrgPolicy(K.cfg({ mode: 'campaign' }), { max_mode: 'plan', limits: { max_diff_lines: 9999 } });
    const paths = r.adjustments.map((a) => a.path);
    assert.ok(paths.includes('mode'));
    assert.ok(!paths.includes('limits.max_diff_lines'), 'unchanged limit is not an adjustment');
    assert.deepEqual(r.adjustments.find((a) => a.path === 'mode'), { path: 'mode', from: 'campaign', to: 'plan' });
  });

  test('stacked policies (managed then user) keep tightening', () => {
    let c = K.cfg({ mode: 'campaign', limits: { max_diff_lines: 500 } });
    c = merged(c, { max_mode: 'governed', limits: { max_diff_lines: 300 } });
    c = merged(c, { max_mode: 'assist', limits: { max_diff_lines: 400 } });
    assert.equal(c.mode, 'assist');
    assert.equal(c.limits.max_diff_lines, 300);
  });

  test('risk-ranked approval ladders never shrink', () => {
    const repo = K.cfg();
    const out = merged(repo, { approvals: { low: ['a'], medium: ['b'], high: ['c'], critical: ['d'] } });
    for (const r of ['low', 'medium', 'high', 'critical']) {
      for (const role of repo.approvals[r]) assert.ok(out.approvals[r].includes(role), `${r} keeps ${role}`);
    }
    assert.ok(riskRank('critical') > riskRank('low'));
  });
});

describe('overlay', () => {
  test('deep-merges objects, replaces arrays and scalars', () => {
    assert.deepEqual(overlay({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { b: 9 }, l: [3] }), { a: { b: 9, c: 2 }, l: [3] });
    assert.equal(overlay({ a: 1 }, undefined).a, 1);
  });
});

describe('policy bundles', () => {
  const POLICY = 'max_mode: plan\nlimits:\n  max_diff_lines: 100\n';

  function bundle(text = POLICY) {
    const dir = tmp();
    writeFileSync(join(dir, 'org-policy.yaml'), text);
    return dir;
  }

  async function signedBundle(text = POLICY) {
    const { generateKeyPairSync } = await import('node:crypto');
    const kp = generateKeyPairSync('ed25519');
    const dir = tmp();
    mkdirSync(join(dir, 'trusted-keys'));
    writeFileSync(join(dir, 'trusted-keys', 'org.pem'), kp.publicKey.export({ type: 'spki', format: 'pem' }));
    writeFileSync(join(dir, 'org-policy.yaml'), text);
    writeFileSync(join(dir, 'org-policy.yaml.sig'), `${K.keys.signText(kp.privateKey, text)}\n`);
    return { dir, kp };
  }

  test('missing policy file is null', () => {
    assert.equal(loadPolicyBundle(tmp()), null);
  });

  test('no trusted keys: unsigned policy loads with signed=false', () => {
    const b = loadPolicyBundle(bundle());
    assert.equal(b.signed, false);
    assert.equal(b.policy.max_mode, 'plan');
    assert.match(b.digest, /^sha256:[0-9a-f]{64}$/);
  });

  test('valid ed25519 signature is accepted', async () => {
    const { dir } = await signedBundle();
    const b = loadPolicyBundle(dir);
    assert.equal(b.signed, true);
    assert.equal(b.policy.limits.max_diff_lines, 100);
  });

  test('tampered policy text is UK_INTEGRITY', async () => {
    const { dir } = await signedBundle();
    writeFileSync(join(dir, 'org-policy.yaml'), POLICY.replace('plan', 'campaign'));
    assert.throws(() => loadPolicyBundle(dir), (e) => e.code === 'UK_INTEGRITY');
  });

  test('a single trailing byte changes the verdict', async () => {
    const { dir } = await signedBundle();
    writeFileSync(join(dir, 'org-policy.yaml'), `${POLICY}\n`);
    assert.throws(() => loadPolicyBundle(dir), (e) => e.code === 'UK_INTEGRITY');
  });

  test('unsigned policy is UK_INTEGRITY when trusted keys are present', async () => {
    const { dir } = await signedBundle();
    rmSync(join(dir, 'org-policy.yaml.sig'));
    assert.throws(() => loadPolicyBundle(dir), (e) => e.code === 'UK_INTEGRITY');
  });

  test('empty, garbage and wrong-key signatures are rejected', async () => {
    const { dir } = await signedBundle();
    const sigFile = join(dir, 'org-policy.yaml.sig');
    for (const sig of ['', '   \n', 'not-base64!!', 'AAAA']) {
      writeFileSync(sigFile, sig);
      assert.throws(() => loadPolicyBundle(dir), (e) => e.code === 'UK_INTEGRITY', JSON.stringify(sig));
    }
    const { generateKeyPairSync } = await import('node:crypto');
    const other = generateKeyPairSync('ed25519');
    writeFileSync(sigFile, K.keys.signText(other.privateKey, POLICY));
    assert.throws(() => loadPolicyBundle(dir), (e) => e.code === 'UK_INTEGRITY');
  });

  test('any one of several trusted keys suffices; non-.pem files are ignored', async () => {
    const { dir } = await signedBundle();
    const { generateKeyPairSync } = await import('node:crypto');
    writeFileSync(join(dir, 'trusted-keys', 'a-other.pem'), generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
    writeFileSync(join(dir, 'trusted-keys', 'README.txt'), 'not a key');
    assert.equal(loadPolicyBundle(dir).signed, true);
  });

  test('a corrupt trusted key file fails closed', async () => {
    const { dir } = await signedBundle();
    writeFileSync(join(dir, 'trusted-keys', 'org.pem'), 'garbage');
    assert.throws(() => loadPolicyBundle(dir), (e) => e.code === 'UK_INTEGRITY');
  });

  test('a trusted-keys dir holding only non-.pem files leaves the bundle unsigned but loadable (documented behaviour)', () => {
    const dir = bundle();
    mkdirSync(join(dir, 'trusted-keys'));
    writeFileSync(join(dir, 'trusted-keys', 'k.pub'), 'x');
    assert.equal(loadPolicyBundle(dir).signed, false);
  });

  test('loadConfig applies a user-level org policy on top of the repo config and digests it', () => {
    const p = K.makeProject();
    const home = process.env.UNKNOT_HOME;
    const file = join(home, 'org-policy.yaml');
    try {
      const base = loadConfig(p.ctx, { overrideRaw: { version: 1, mode: 'governed', limits: { max_diff_lines: 900 } } });
      assert.equal(base.config.mode, 'governed');
      writeFileSync(file, POLICY);
      const tight = loadConfig(p.ctx, { overrideRaw: { version: 1, mode: 'governed', limits: { max_diff_lines: 900 } } });
      assert.equal(tight.config.mode, 'plan');
      assert.equal(tight.config.limits.max_diff_lines, 100);
      assert.notEqual(tight.digest, base.digest, 'config digest covers org policy');
      assert.ok(tight.adjustments.some((a) => a.path === 'mode' && a.by === file));
      assert.ok(Object.isFrozen(tight.config));
      writeFileSync(file, 'max_mode: observe\n');
      assert.equal(loadConfig(p.ctx, { overrideRaw: { version: 1, mode: 'campaign' } }).config.mode, 'observe');
    } finally {
      rmSync(file, { force: true });
    }
  });

  test('loadConfig rejects an invalid repo config', () => {
    const p = K.makeProject();
    assert.throws(() => loadConfig(p.ctx, { overrideRaw: { version: 1, mode: 'ludicrous' } }), (e) => e.code === 'UK_CONFIG_INVALID');
  });

  test('a tampered user-level signed policy makes loadConfig fail closed', async () => {
    const p = K.makeProject();
    const { dir } = await signedBundle();
    const home = process.env.UNKNOT_HOME;
    mkdirSync(join(home, 'trusted-keys'), { recursive: true });
    writeFileSync(join(home, 'trusted-keys', 'x.pem'), (await import('node:fs')).readFileSync(join(dir, 'trusted-keys', 'org.pem')));
    writeFileSync(join(home, 'org-policy.yaml'), 'max_mode: campaign\n');
    try {
      assert.throws(() => loadConfig(p.ctx, { overrideRaw: { version: 1 } }), (e) => e.code === 'UK_INTEGRITY');
    } finally {
      rmSync(join(home, 'trusted-keys'), { recursive: true, force: true });
      rmSync(join(home, 'org-policy.yaml'), { force: true });
    }
  });
});

test('org keys without a merge rule replace the repository value; an unaccepted repository edit cannot use that path', () => {
  const repo = structuredClone(K.DEFAULT_CONFIG);
  repo.daemon = { bind: '127.0.0.1' };
  const org = applyOrgPolicy(repo, { daemon: { bind: '10.0.0.1' }, decomposition: { weights: { structural: 1 } } });
  assert.equal(org.config.daemon.bind, '10.0.0.1');
  assert.deepEqual(org.config.decomposition, { weights: { structural: 1 } });
  const edit = applyOrgPolicy(repo, { daemon: { bind: '0.0.0.0' }, limits: { max_changed_files: 3 } }, { unruledKeys: 'ignore' });
  assert.equal(edit.config.daemon.bind, '127.0.0.1', 'an unaccepted edit to a key without a tighten rule waits for acceptance');
  assert.equal(edit.config.limits.max_changed_files, 3, 'tightening still applies at once');
});
