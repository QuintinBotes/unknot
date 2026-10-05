// Lanes end to end: a person signs one lane for the low-risk slices of a campaign; the agent
// then applies and verifies a fitting slice without a per-slice plan approval; a patch that
// leaves the lane is refused; the change is still accepted only with a person's signature.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;

const { openProject } = await import('../../runtime/context.mjs');
const { loadConfig, recordAcceptedConfig } = await import('../../runtime/policy/config.mjs');
const { createCampaign } = await import('../../runtime/plan/campaign.mjs');
const { generateApproverKey, loadApproverKey } = await import('../../runtime/core/keys.mjs');
const { recordApproval } = await import('../../runtime/policy/approvals.mjs');
const { checkLaneDiff, draftLane, laneFor, laneSlices, laneValidity, recordLane, revokeLane } = await import('../../runtime/policy/lanes.mjs');
const { approvalStatus, currentBinding, finishApply, loadSlice, startApply } = await import('../../runtime/apply/apply.mjs');
const { verifySlice } = await import('../../runtime/verify/verify.mjs');
const { startRun, endRun } = await import('../../runtime/state/runs.mjs');
const { transitionSlice } = await import('../../runtime/state/machine.mjs');
const { stringifyYAML } = await import('../../runtime/core/yaml.mjs');

const UTIL = `export function total(items) {
  return items.reduce((sum, i) => sum + i.price, 0);
}

function legacyTotal(items) {
  let sum = 0;
  for (const i of items) sum += i.price;
  return sum;
}
`;
const TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/util.mjs';
test('total', () => assert.equal(total([{ price: 2 }, { price: 3 }]), 5));
`;
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

test('a signed lane lets the agent apply and verify a deletion-only slice; acceptance stays human', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uk-lane-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  mkdirSync(join(dir, 'db'));
  writeFileSync(join(dir, 'src/util.mjs'), UTIL);
  writeFileSync(join(dir, 'test/util.test.mjs'), TEST);
  writeFileSync(join(dir, 'db/schema.sql'), 'create table orders (id int);\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test test/' } }));
  g(dir, 'init', '-q');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');

  const pub = generateApproverKey('alice', 'correct horse battery');
  const ctx = openProject(dir, { create: true });
  writeFileSync(join(dir, '.unknot/config.yaml'), stringifyYAML({
    version: 1,
    mode: 'assist',
    protected_paths: ['db/**'],
    commands: { test_unit: ['node', '--test'] },
    approvers: { alice: { roles: ['code-owner'], public_key: pub } },
  }));
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'unknot config');
  recordAcceptedConfig(ctx, readFileSync(join(dir, '.unknot/config.yaml'), 'utf8'), 'human:test');
  const cfg = loadConfig(ctx);
  const { config } = cfg;

  const { campaign, slices } = createCampaign(ctx, {
    config,
    actor: 'model:main',
    objective: 'Remove unused code',
    proposal: {
      slices: [
        { objective: 'Remove the unused legacyTotal helper', kind: 'code', scope: { include: ['src/util.mjs'] } },
        { objective: 'Drop the unused orders table', kind: 'code', scope: { include: ['db/schema.sql'] } },
      ],
    },
  });
  const [inLane, outside] = slices.map((s) => s.id);
  assert.equal(loadSlice(ctx, inLane).risk, 'low');

  // The lane covers only the slice that fits; the protected one needs its own approval.
  const { lane, excluded } = draftLane(ctx, { cfg, campaignId: campaign.id, kinds: ['deletion'] });
  assert.deepEqual(Object.keys(lane.slices), [inLane]);
  assert.equal(excluded[0].id, outside);
  assert.equal(lane.role, 'code-owner');

  const run = startRun(ctx, { command: 'apply', actor: 'model:main', slice_id: inLane, config, configDigest: cfg.digest });
  await assert.rejects(startApply(ctx, { cfg, run, sliceId: inLane, actor: 'model:main' }), (e) => e.code === 'UK_APPROVAL_REQUIRED', 'no approval and no lane: no patching');

  const key = loadApproverKey('alice', 'correct horse battery');
  const row = recordLane(ctx, { config, lane, approver: 'alice', privateKey: key });
  assert.deepEqual(laneValidity({ ...row, body: lane }, cfg), []);

  // The agent applies the covered slice with no per-slice plan approval.
  await startApply(ctx, { cfg, run, sliceId: inLane, actor: 'model:main' });
  let slice = loadSlice(ctx, inLane);
  assert.equal(slice.state, 'PATCHING');
  assert.deepEqual(laneSlices(ctx, row.id).map((s) => s.id), [inLane]);

  // A patch that adds code leaves the lane and is refused at finish.
  writeFileSync(join(slice.worktree, 'src/util.mjs'), `${UTIL.split('\n\nfunction legacyTotal')[0]}\n\nexport const zero = 0;\n`);
  assert.throws(() => finishApply(ctx, { cfg, run, sliceId: inLane, actor: 'model:main' }), (e) => e.code === 'UK_POLICY_DENIED' && /leaves lane/.test(e.message) && /not deletion-only/.test(e.message));
  assert.equal(loadSlice(ctx, inLane).state, 'PATCHING');

  // Deleting only: inside the lane.
  writeFileSync(join(slice.worktree, 'src/util.mjs'), `${UTIL.split('\n\nfunction legacyTotal')[0]}\n`);
  finishApply(ctx, { cfg, run, sliceId: inLane, actor: 'model:main' });
  const v = await verifySlice(ctx, { cfg, run, sliceId: inLane, actor: 'model:main' });
  assert.equal(v.state, 'REVIEW_READY', JSON.stringify(v.results, null, 1));

  // Acceptance is unchanged: the change needs a person's signature over its diff.
  slice = loadSlice(ctx, inLane);
  const before = approvalStatus(ctx, slice, 'change', { cfg, commit: slice.baseline_commit, diffHash: slice.diff_hash });
  assert.equal(before.satisfied, false, 'a lane never approves a change');
  recordApproval(ctx, { config, slice, binding: currentBinding(ctx, slice, 'change', { cfg, commit: slice.baseline_commit, diffHash: slice.diff_hash }), role: 'code-owner', approver: 'alice', privateKey: key });
  assert.ok(approvalStatus(ctx, slice, 'change', { cfg, commit: slice.baseline_commit, diffHash: slice.diff_hash }).satisfied);
  transitionSlice(ctx, { slice, to: 'ACCEPTED', actor: 'human:alice', reason: 'test' });
  assert.equal(readFileSync(join(dir, 'src/util.mjs'), 'utf8'), UTIL, 'the main checkout was never touched');
  await assert.rejects(startApply(ctx, { cfg, run, sliceId: outside, actor: 'model:main' }), (e) => e.code === 'UK_APPROVAL_REQUIRED', 'the slice outside the lane still needs a person');
  endRun(ctx, run.id);

  // A lane is void after a config change, for a replanned slice, and once revoked.
  const fresh = { ...loadSlice(ctx, outside), campaign_id: campaign.id };
  const replanned = { ...loadSlice(ctx, inLane), state: 'AWAITING_APPROVAL', body: { ...loadSlice(ctx, inLane).body, objective: 'Remove legacyTotal and more' } };
  assert.match(laneFor(ctx, { cfg, slice: replanned }).reasons.join(' '), /changed since it was approved/);
  assert.match(laneFor(ctx, { cfg: { ...cfg, digest: 'sha256:other' }, slice: { ...replanned, body: loadSlice(ctx, inLane).body } }).reasons.join(' '), /configuration changed/);
  assert.match(laneFor(ctx, { cfg, slice: fresh }).reasons.join(' '), /not in it/);
  revokeLane(ctx, row.id, { reason: 'done', actor: 'human:alice' });
  assert.match(laneFor(ctx, { cfg, slice: { ...replanned, body: loadSlice(ctx, inLane).body } }).reasons.join(' '), /revoked/);
});

test('lane patch shapes: deletion-only, tests-only, caps', () => {
  const lane = { kinds: ['deletion', 'tests'], max_changed_files: 2, max_diff_lines: 20 };
  assert.ok(checkLaneDiff(lane, { files: 1, lines: 8, added: 0, paths: ['src/a.mjs'] }).ok);
  assert.ok(checkLaneDiff(lane, { files: 1, lines: 8, added: 8, paths: ['test/a.test.mjs'] }).ok);
  assert.ok(checkLaneDiff(lane, { files: 2, lines: 8, added: 3, paths: ['src/Orders/OrderServiceTests.cs', 'tests/x.py'] }).ok);
  const mixed = checkLaneDiff(lane, { files: 2, lines: 8, added: 3, paths: ['src/a.mjs', 'test/a.test.mjs'] });
  assert.equal(mixed.ok, false);
  assert.match(mixed.problems.join(' '), /not deletion-only.*non-test files \(src\/a\.mjs\)/);
  assert.match(checkLaneDiff(lane, { files: 3, lines: 30, added: 0, paths: ['a', 'b', 'c'] }).problems.join(' '), /3 files.*cap 2.*30 lines.*cap 20/);
  assert.equal(checkLaneDiff({ ...lane, kinds: ['deletion'] }, { files: 1, lines: 2, added: 2, paths: ['test/a.test.mjs'] }).ok, false, 'tests-only patches need the tests kind');
  assert.equal(checkLaneDiff(lane, { files: 1, lines: 4, added: 4, paths: ['api/spec/openapi.yaml'] }).ok, false, 'a spec document is not test code');
});
