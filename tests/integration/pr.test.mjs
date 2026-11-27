// `unknot pr <slice>` (#151) end to end with a fake gh on PATH that records its argv and a bare
// repository as the remote: a verified slice is pushed and opened as a draft, a re-patched one is
// pushed again without force and its body marked stale, and gh is never asked to merge or approve.

import '../helpers/git-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mkTmp } from '../helpers/tmp.mjs';

process.env.UNKNOT_HOME = mkTmp(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;

const { openProject } = await import('../../runtime/context.mjs');
const { loadConfig, recordAcceptedConfig } = await import('../../runtime/policy/config.mjs');
const { mapRepository } = await import('../../runtime/graph/builder.mjs');
const { diagnose } = await import('../../runtime/diagnose/engine.mjs');
const { createCampaign } = await import('../../runtime/plan/campaign.mjs');
const { generateApproverKey, loadApproverKey } = await import('../../runtime/core/keys.mjs');
const { recordApproval } = await import('../../runtime/policy/approvals.mjs');
const { currentBinding, finishApply, loadSlice, startApply } = await import('../../runtime/apply/apply.mjs');
const { verifySlice } = await import('../../runtime/verify/verify.mjs');
const { startRun, endRun } = await import('../../runtime/state/runs.mjs');
const { transitionSlice } = await import('../../runtime/state/machine.mjs');
const { stringifyYAML } = await import('../../runtime/core/yaml.mjs');
const { head } = await import('../../runtime/apply/git.mjs');
const { alwaysOn } = await import('../../runtime/policy/pdp.mjs');
const pr = await import('../../runtime/cli/commands/pr.mjs');

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
  assert.equal(classify({ total: 50 }), 'small');
});
`;

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

/** Run `unknot pr` in-process as a person at a terminal; returns what it printed. */
async function runPr(dir, sliceId, { env = {}, tty = true } = {}) {
  const saved = { cwd: process.cwd(), env: { ...process.env }, in: process.stdin.isTTY, out: process.stdout.isTTY, write: process.stdout.write };
  let out = '';
  process.chdir(dir);
  Object.assign(process.env, env);
  process.stdin.isTTY = tty;
  process.stdout.isTTY = tty;
  process.stdout.write = (s) => { out += s; return true; };
  try {
    await pr.run({ positional: [sliceId], flags: {} });
    return out;
  } finally {
    process.stdout.write = saved.write;
    process.chdir(saved.cwd);
    process.env = saved.env;
    process.stdin.isTTY = saved.in;
    process.stdout.isTTY = saved.out;
  }
}

test('unknot pr: draft pull request for a verified slice, updated without force after a re-patch', { timeout: 120_000 }, async () => {
  const dir = mkTmp(join(tmpdir(), 'uk-proj-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src/classify.mjs'), BRANCHY);
  writeFileSync(join(dir, 'test/classify.test.mjs'), TEST);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test test/' } }));
  g(dir, 'init', '-q');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');

  // Fake gh: records each argv as one line and prints a URL for `pr create`.
  const bin = mkTmp(join(tmpdir(), 'uk-gh-'));
  const log = join(bin, 'gh.log');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncase "$2" in create) echo https://github.com/o/r/pull/7 ;; esac\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const PATH = `${bin}:${process.env.PATH}`;

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
  recordAcceptedConfig(ctx, readFileSync(join(dir, '.unknot/config.yaml'), 'utf8'), 'human:test');
  const cfg = loadConfig(ctx);
  const config = cfg.config;
  await mapRepository(ctx, { config, configDigest: cfg.digest });
  const finding = (await diagnose(ctx, { config, only: ['local'] })).findings.find((f) => f.scope.includes('src/classify.mjs'));
  const sliceId = createCampaign(ctx, { config, actor: 'model:main', objective: 'Flatten classify', findings: [finding.id] }).slices[0].id;
  let slice = loadSlice(ctx, sliceId);
  const run = startRun(ctx, { command: 'apply', actor: 'model:main', slice_id: sliceId, config, configDigest: cfg.digest });
  const key = loadApproverKey('alice', 'correct horse battery');
  for (const role of slice.body.approvals) recordApproval(ctx, { config, slice, binding: currentBinding(ctx, slice, 'plan', { cfg, commit: head(dir) }), role, approver: 'alice', privateKey: key });

  await startApply(ctx, { cfg, run, sliceId, actor: 'model:main' });
  slice = loadSlice(ctx, sliceId);
  await assert.rejects(runPr(dir, sliceId, { env: { PATH } }), (e) => e.code === 'UK_STATE_CONFLICT', 'a slice that is not verified gets no pull request');
  writeFileSync(join(slice.worktree, 'src/classify.mjs'), FLAT);
  await finishApply(ctx, { cfg, run, sliceId, actor: 'model:main' });
  const v = await verifySlice(ctx, { cfg, run, sliceId, actor: 'model:main' });
  assert.equal(v.state, 'REVIEW_READY', JSON.stringify(v.results));
  endRun(ctx, run.id);

  // Scenario 5: an agent session is refused, by the command and by the shell rule.
  await assert.rejects(runPr(dir, sliceId, { env: { PATH, CLAUDECODE: '1' } }), (e) => e.details?.policy === 'approval.human_only');
  const shellRule = (command) => alwaysOn(ctx, { op: 'exec', command, cwd: dir }, {})?.policy_ids?.includes('approval.human_only') ?? false;
  assert.equal(shellRule(`unknot pr ${sliceId}`), true);
  assert.equal(shellRule(`npx unknot pr ${sliceId}`), true);
  assert.equal(shellRule('unknot plan "fix the pr template"'), false, 'the word pr in an argument is data');
  assert.deepEqual(calls(), []);

  // Scenario 6: no remote. The body is written and the manual steps printed; nothing is pushed.
  let out = await runPr(dir, sliceId, { env: { PATH } });
  assert.match(out, /no git remote; nothing was pushed/);
  assert.match(out, new RegExp(`gh pr create --draft --head unknot/${sliceId}`));
  assert.ok(existsSync(join(dir, v.bundle, 'pr.md')));
  assert.deepEqual(calls(), [], 'gh is not called without a remote');

  // Scenario 1: push the slice branch and open a draft.
  const remote = mkTmp(join(tmpdir(), 'uk-remote-'));
  g(remote, 'init', '-q', '--bare');
  g(dir, 'remote', 'add', 'origin', remote);
  out = await runPr(dir, sliceId, { env: { PATH } });
  assert.match(out, /Opened draft pull request https:\/\/github.com\/o\/r\/pull\/7/);
  const body = join(realpathSync(dir), v.bundle, 'pr.md');
  assert.deepEqual(calls(), [`pr create --draft --head unknot/${sliceId} --title ${sliceId}: ${slice.body.objective} --body-file ${body}`]);
  const first = g(remote, 'rev-parse', `refs/heads/unknot/${sliceId}`);
  assert.equal(g(remote, 'rev-parse', `${first}^`), slice.baseline_commit, 'one commit on the approved baseline');
  assert.equal(g(remote, 'show', `${first}:src/classify.mjs`) + '\n', FLAT);
  assert.match(readFileSync(body, 'utf8'), /## Ran and passed/);
  assert.doesNotMatch(readFileSync(body, 'utf8'), /stale/);

  // Scenario 4: re-patched after the PR exists: a new commit on top, no force, body marked stale.
  transitionSlice(ctx, { slice: loadSlice(ctx, sliceId), to: 'PATCHING', actor: 'model:main', reason: 'test: re-patch' });
  writeFileSync(join(slice.worktree, 'src/classify.mjs'), `${FLAT}// re-patched\n`);
  out = await runPr(dir, sliceId, { env: { PATH } });
  assert.match(out, /Updated pull request https:\/\/github.com\/o\/r\/pull\/7/);
  assert.match(out, /verification is stale/);
  const second = g(remote, 'rev-parse', `refs/heads/unknot/${sliceId}`);
  assert.equal(g(remote, 'rev-parse', `${second}^`), first, 'fast-forward: the earlier commit is kept');
  assert.match(readFileSync(body, 'utf8'), /stale until `unknot verify/);
  assert.equal(calls()[1], `pr edit unknot/${sliceId} --body-file ${body}`);

  // SC-002: gh only ever creates a draft or edits.
  for (const c of calls()) assert.match(c, /^pr (create --draft|edit) /);
  assert.equal(readFileSync(join(dir, 'src/classify.mjs'), 'utf8'), BRANCHY, 'the main checkout was never touched');
});
