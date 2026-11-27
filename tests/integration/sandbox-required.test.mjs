// SC-001 of #148: with the sandbox probe stubbed to "absent", `verify` refuses in assist and
// works in plan. The slice is planned and applied with the real sandbox, then verified without it.

import '../helpers/git-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mkTmp } from '../helpers/tmp.mjs';

process.env.UNKNOT_HOME = mkTmp(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;

const { openProject } = await import('../../runtime/context.mjs');
const { loadConfig, recordAcceptedConfig } = await import('../../runtime/policy/config.mjs');
const { mapRepository } = await import('../../runtime/graph/builder.mjs');
const { createCampaign } = await import('../../runtime/plan/campaign.mjs');
const { generateApproverKey, loadApproverKey } = await import('../../runtime/core/keys.mjs');
const { recordApproval } = await import('../../runtime/policy/approvals.mjs');
const { currentBinding, finishApply, loadSlice, startApply } = await import('../../runtime/apply/apply.mjs');
const { startRun } = await import('../../runtime/state/runs.mjs');
const { stringifyYAML } = await import('../../runtime/core/yaml.mjs');
const { head } = await import('../../runtime/apply/git.mjs');
const { detectSandbox } = await import('../../runtime/broker/sandbox.mjs');

const bin = new URL('../../bin/unknot', import.meta.url).pathname;
const helper = new URL('../helpers/no-sandbox.mjs', import.meta.url).pathname;
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
const PASS = 'correct horse battery';
const PUB = generateApproverKey('alice', PASS);

test('verify refuses in assist and runs in plan when no OS sandbox is available', { skip: detectSandbox() === 'none' && 'apply needs a sandbox to set the slice up' }, async () => {
  const dir = mkTmp(join(tmpdir(), 'uk-nosandbox-proj-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/ledger.mjs'), 'export const total = (xs) => xs.reduce((a, b) => a + b, 0);\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
  g(dir, 'init', '-q');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  const ctx = openProject(dir, { create: true });
  // Whether a command ran is read from the ledger (exec.started), which the broker writes outside any sandbox.
  const config = { version: 1, mode: 'assist', protected_paths: [], commands: { test_unit: [process.execPath, '-e', 'process.exit(0)'] }, approvers: { alice: { roles: ['code-owner', 'affected-owner', 'security-owner', 'data-owner'], public_key: PUB } } };
  writeFileSync(join(dir, '.unknot/config.yaml'), stringifyYAML(config));
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'unknot config');
  recordAcceptedConfig(ctx, readFileSync(join(dir, '.unknot/config.yaml'), 'utf8'), 'human:test');
  const cfg = loadConfig(ctx);
  const [planned] = createCampaign(ctx, { config: cfg.config, actor: 'model:main', objective: 'Tidy the ledger code', proposal: { slices: [{ objective: 'Tidy', scope: { include: ['src/**'], exclude: [] }, changes: [{ path: 'src/ledger.mjs', operation: 'modify', description: 'edit' }], invariants: ['Behaviour is unchanged'] }] } }).slices;
  const s0 = loadSlice(ctx, planned.id);
  const key = loadApproverKey('alice', PASS);
  for (const role of s0.body.approvals) recordApproval(ctx, { config: cfg.config, slice: s0, binding: currentBinding(ctx, s0, 'plan', { cfg, commit: head(dir) }), role, approver: 'alice', privateKey: key });
  await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest });
  const run = startRun(ctx, { command: 'apply', actor: 'model:main', slice_id: planned.id, config: cfg.config, configDigest: cfg.digest });
  await startApply(ctx, { cfg, run, sliceId: planned.id, actor: 'model:main' });
  writeFileSync(join(loadSlice(ctx, planned.id).worktree, 'src/ledger.mjs'), 'export const total = (xs) => xs.reduce((a, b) => a + b, 0); // sum\n');
  finishApply(ctx, { cfg, run, sliceId: planned.id, actor: 'model:main' });
  const started = () => ctx.store.all("SELECT * FROM events WHERE type = 'exec.started'").length;
  const startedBefore = started();

  const verify = () => spawnSync(process.execPath, ['--import', helper, bin, 'verify', planned.id, '--json', '--cwd', dir], { encoding: 'utf8', env: { ...process.env, UNKNOT_TEST_HIDE_SANDBOX: '1' } });
  const commandEvidence = () => ctx.store.all('SELECT record FROM evidence WHERE slice_id = ? AND obligation_id IS NOT NULL', planned.id).map((e) => JSON.parse(e.record)).filter((r) => r.kind === 'command');

  const refused = verify();
  assert.equal(refused.status, 3, refused.stderr + refused.stdout);
  assert.equal(JSON.parse(refused.stdout).error.code, 'UK_SANDBOX_REQUIRED');
  assert.equal(started(), startedBefore, 'the unit tests did not run');
  assert.deepEqual(commandEvidence(), []);
  assert.equal(loadSlice(ctx, planned.id).state, 'VERIFYING');

  // Lowering the mode tightens policy, so it applies without a new acceptance.
  writeFileSync(join(dir, '.unknot/config.yaml'), stringifyYAML({ ...config, mode: 'plan' }));
  const ran = verify();
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
  assert.ok(started() > startedBefore, 'the unit tests ran');
  const evidence = commandEvidence();
  assert.ok(evidence.length > 0);
  for (const r of evidence) assert.equal(r.sandbox, 'none');
});
