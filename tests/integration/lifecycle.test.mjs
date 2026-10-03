// Scenario A (spec §32) end to end: a complex function is found, planned, approved,
// patched in a worktree, verified with executed evidence, bundled and accepted — and the
// main checkout is never touched.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;

const { openProject } = await import('../../runtime/context.mjs');
const { loadConfig, recordAcceptedConfig } = await import('../../runtime/policy/config.mjs');
const { mapRepository } = await import('../../runtime/graph/builder.mjs');
const { diagnose } = await import('../../runtime/diagnose/engine.mjs');
const { createCampaign } = await import('../../runtime/plan/campaign.mjs');
const { generateApproverKey, loadApproverKey } = await import('../../runtime/core/keys.mjs');
const { recordApproval } = await import('../../runtime/policy/approvals.mjs');
const { approvalStatus, currentBinding, finishApply, loadSlice, startApply } = await import('../../runtime/apply/apply.mjs');
const { verifySlice } = await import('../../runtime/verify/verify.mjs');
const { startRun, endRun } = await import('../../runtime/state/runs.mjs');
const { decide, toOperation } = await import('../../runtime/policy/pdp.mjs');
const { transitionSlice } = await import('../../runtime/state/machine.mjs');
const { stringifyYAML } = await import('../../runtime/core/yaml.mjs');
const { head } = await import('../../runtime/apply/git.mjs');

const BRANCHY = `export function classify(order) {
  let label = 'unknown';
  if (order) {
    if (order.total > 1000) {
      if (order.vip) {
        label = 'priority-vip';
      } else {
        label = 'priority';
      }
    } else if (order.total > 100) {
      if (order.vip) {
        label = 'standard-vip';
      } else {
        label = 'standard';
      }
    } else {
      if (order.vip) {
        label = 'small-vip';
      } else {
        label = 'small';
      }
    }
  }
  return label;
}
`;

const FLAT = `export function classify(order) {
  if (!order) return 'unknown';
  const tier = order.total > 1000 ? 'priority' : order.total > 100 ? 'standard' : 'small';
  return order.vip ? \`\${tier}-vip\` : tier;
}
`;

const TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.mjs';
test('classify', () => {
  assert.equal(classify(null), 'unknown');
  assert.equal(classify({ total: 5000, vip: true }), 'priority-vip');
  assert.equal(classify({ total: 5000 }), 'priority');
  assert.equal(classify({ total: 500, vip: true }), 'standard-vip');
  assert.equal(classify({ total: 50 }), 'small');
});
`;

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

test('Scenario A: find, plan, approve, patch, verify, accept', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uk-proj-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src/classify.mjs'), BRANCHY);
  writeFileSync(join(dir, 'test/classify.test.mjs'), TEST);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test test/' } }));
  g(dir, 'init', '-q');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');

  const pub = generateApproverKey('alice', 'correct horse battery');
  const ctx = openProject(dir, { create: true });
  writeFileSync(join(dir, '.unknot/config.yaml'), stringifyYAML({
    version: 1,
    mode: 'assist',
    protected_paths: [],
    commands: { test_unit: ['node', '--test'] },
    detectors: { 'local.complex-function': { cyclomatic: 5, cognitive: 5 }, 'local.deep-nesting': { max_nesting: 2 } },
    approvers: { alice: { roles: ['code-owner', 'affected-owner'], public_key: pub } },
  }));
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'unknot config');
  assert.equal(loadConfig(ctx).config.mode, 'plan', 'an unaccepted config never runs above plan');
  assert.deepEqual(loadConfig(ctx).config.approvers, {}, 'an unaccepted config registers no approvers');
  recordAcceptedConfig(ctx, readFileSync(join(dir, '.unknot/config.yaml'), 'utf8'), 'human:test');
  const cfg = loadConfig(ctx);
  assert.equal(cfg.config.mode, 'assist');
  const config = cfg.config;

  const mapped = await mapRepository(ctx, { config, configDigest: cfg.digest });
  assert.ok(mapped.nodes > 0);
  const diag = await diagnose(ctx, { config, only: ['local'] });
  assert.deepEqual(diag.errors.filter((e) => !/not installed/.test(e.error)), []);
  const finding = diag.findings.find((f) => f.scope.includes('src/classify.mjs'));
  assert.ok(finding, `expected a finding on classify; got ${diag.findings.map((f) => f.kind).join(', ')}`);
  assert.ok(finding.alternatives.some((a) => a.id === 'retain'), 'retain is always an alternative');

  const { slices } = createCampaign(ctx, { config, actor: 'model:main', objective: 'Flatten classify', findings: [finding.id] });
  const sliceId = slices[0].id;
  let slice = loadSlice(ctx, sliceId);
  assert.equal(slice.state, 'AWAITING_APPROVAL');

  const run = startRun(ctx, { command: 'apply', actor: 'model:main', slice_id: sliceId, config, configDigest: cfg.digest });
  await assert.rejects(startApply(ctx, { cfg, run, sliceId, actor: 'model:main' }), (e) => e.code === 'UK_APPROVAL_REQUIRED', 'no approval → no patching');

  const key = loadApproverKey('alice', 'correct horse battery');
  for (const role of slice.body.approvals) {
    recordApproval(ctx, { config, slice, binding: currentBinding(ctx, slice, 'plan', { cfg, commit: head(dir) }), role, approver: 'alice', privateKey: key });
  }
  const started = await startApply(ctx, { cfg, run, sliceId, actor: 'model:main' });
  assert.equal(started.baseline.verdict, 'pass', 'baseline tests pass before the change');
  slice = loadSlice(ctx, sliceId);
  assert.equal(slice.state, 'PATCHING');

  // The policy confines writes to the worktree and the slice scope.
  const write = (p) => decide({ ctx, config, run, slice, op: toOperation('Write', { file_path: p }, dir), pluginRoot: null }).decision;
  assert.equal(write(join(slice.worktree, 'src/classify.mjs')), 'allow');
  assert.equal(write(join(dir, 'src/classify.mjs')), 'deny', 'main checkout is not writable');
  assert.equal(write(join(slice.worktree, 'package.json')), 'deny', 'outside slice scope');

  writeFileSync(join(slice.worktree, 'src/classify.mjs'), FLAT);
  const fin = finishApply(ctx, { cfg, run, sliceId, actor: 'model:main' });
  assert.match(fin.diff_hash, /^sha256:/);

  const v = await verifySlice(ctx, { cfg, run, sliceId, actor: 'model:main' });
  assert.equal(v.state, 'REVIEW_READY', JSON.stringify(v.results, null, 1));
  assert.ok(v.results.every((r) => r.verdict === 'pass'));
  assert.ok(existsSync(join(dir, v.bundle, 'manifest.json')));
  const manifest = JSON.parse(readFileSync(join(dir, v.bundle, 'manifest.json'), 'utf8'));
  for (const f of ['diff.patch', 'slice.yaml', 'verification.json', 'recovery.md', 'command-log.jsonl']) assert.ok(manifest.files.some((x) => x.path === f), f);

  slice = loadSlice(ctx, sliceId);
  for (const role of slice.body.approvals) {
    recordApproval(ctx, { config, slice, binding: currentBinding(ctx, slice, 'change', { cfg, commit: slice.baseline_commit, diffHash: slice.diff_hash }), role, approver: 'alice', privateKey: key });
  }
  const status = approvalStatus(ctx, slice, 'change', { cfg, commit: slice.baseline_commit, diffHash: slice.diff_hash });
  assert.ok(status.satisfied);
  transitionSlice(ctx, { slice, to: 'ACCEPTED', actor: 'human:alice', reason: 'test' });
  assert.equal(loadSlice(ctx, sliceId).state, 'ACCEPTED');

  assert.equal(readFileSync(join(dir, 'src/classify.mjs'), 'utf8'), BRANCHY, 'the main checkout was never touched');
  endRun(ctx, run.id);
});
