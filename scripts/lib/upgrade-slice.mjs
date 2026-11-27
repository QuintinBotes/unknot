// Child of scripts/upgrade-test.mjs, run once with an earlier release's runtime and once with
// this checkout's, so each side uses its own code on the same project:
//
//   node upgrade-slice.mjs build <runtime dir> <project>   plan a campaign, approve its slice with
//     a test approver key, apply it (worktree, patch staged); prints {slice, campaign, events}
//   node upgrade-slice.mjs check <runtime dir> <project> <slice>   how this runtime judges the plan
//     approval the earlier release signed; prints {satisfied, stale, bound, state}. `bound` is the
//     verdict under the policy digest the approval was signed with: signature, approver, role,
//     commit, slice digest and expiry, all checked by this runtime. `satisfied` is the verdict
//     under today's digest, which a release that changes the effective config moves.
//   node upgrade-slice.mjs accept <runtime dir> <project>   what a person does once after an upgrade
//     from a release that did not sign config acceptances (#215): accept .unknot/config.yaml
//     again, through the runtime API (a terminal accept needs a TTY); prints {acceptance}
//
// UNKNOT_HOME comes from the caller, so both sides find the same approver key.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, runtime, project, sliceArg] = process.argv.slice(2);
const load = (p) => import(pathToFileURL(join(runtime, p)).href);
const git = (...a) => execFileSync('git', ['-c', 'user.email=upgrade-test@example.invalid', '-c', 'user.name=upgrade-test', ...a], { cwd: project, encoding: 'utf8' }).trim();
const PASS = 'upgrade test passphrase';
const SCOPE = 'web/orders/cart.ts';

const { openProject } = await load('context.mjs');
const { loadConfig, recordAcceptedConfig } = await load('policy/config.mjs');
const { loadSlice, currentBinding, approvalStatus, startApply, finishApply } = await load('apply/apply.mjs');

if (mode === 'build') {
  const { parseYAML, stringifyYAML } = await load('core/yaml.mjs');
  const { generateApproverKey, loadApproverKey } = await load('core/keys.mjs');
  const { createCampaign } = await load('plan/campaign.mjs');
  const { recordApproval } = await load('policy/approvals.mjs');
  const { startRun, endRun } = await load('state/runs.mjs');
  const ctx = openProject(project, { create: true });
  // Keep what init wrote, if anything; add a test approver and the mode that permits patching.
  const file = join(project, '.unknot/config.yaml');
  const raw = (existsSync(file) && parseYAML(readFileSync(file, 'utf8'), { filename: 'config.yaml' })) || { version: 1 };
  const pub = generateApproverKey('upgrade', PASS);
  const text = stringifyYAML({ ...raw, mode: 'assist', approvers: { upgrade: { roles: ['code-owner', 'affected-owner'], public_key: pub } } });
  writeFileSync(file, text);
  git('add', '-A');
  git('commit', '-qm', 'unknot config with a test approver');
  recordAcceptedConfig(ctx, text, 'human:upgrade');
  const cfg = loadConfig(ctx);
  const { campaign, slices } = createCampaign(ctx, {
    config: cfg.config, actor: 'human:upgrade', objective: 'Note the cart total rule',
    proposal: { rationale: 'upgrade test', slices: [{ objective: 'Document cart', kind: 'code', scope: { include: [SCOPE], exclude: [] }, invariants: ['Observable behaviour is unchanged'], sources: [], changes: [{ path: SCOPE, operation: 'modify', description: 'Add a comment' }] }] },
  });
  const slice = loadSlice(ctx, slices[0].id);
  const key = loadApproverKey('upgrade', PASS);
  const commit = git('rev-parse', 'HEAD');
  for (const role of slice.body.approvals) recordApproval(ctx, { config: cfg.config, slice, binding: currentBinding(ctx, slice, 'plan', { cfg, commit }), role, approver: 'upgrade', privateKey: key });
  const run = startRun(ctx, { command: 'apply', actor: 'model:upgrade', slice_id: slice.id, config: cfg.config, configDigest: cfg.digest });
  const started = await startApply(ctx, { cfg, run, sliceId: slice.id, actor: 'model:upgrade' });
  appendFileSync(join(started.slice.worktree, SCOPE), '// The total is the sum of the line totals.\n');
  await finishApply(ctx, { cfg, run, sliceId: slice.id, actor: 'model:upgrade' });
  endRun(ctx, run.id);
  const events = ctx.store.get('SELECT COUNT(*) AS n FROM events').n;
  process.stdout.write(`${JSON.stringify({ slice: slice.id, campaign: campaign?.id ?? slice.campaign_id, state: loadSlice(ctx, slice.id).state, events })}\n`);
} else if (mode === 'check') {
  const ctx = openProject(project, { readOnly: true });
  const cfg = loadConfig(ctx);
  const slice = loadSlice(ctx, sliceArg);
  const commit = git('rev-parse', 'HEAD');
  const signed = ctx.store.all("SELECT binding FROM approvals WHERE slice_id = ? AND stage = 'plan'", slice.id).map((r) => JSON.parse(r.binding).policy_digest);
  const now = approvalStatus(ctx, slice, 'plan', { cfg, commit });
  const then = approvalStatus(ctx, slice, 'plan', { cfg: { ...cfg, digest: signed[0] }, commit });
  process.stdout.write(`${JSON.stringify({ satisfied: now.satisfied, stale: now.stale, bound: then.satisfied, bound_stale: then.stale, approvals: signed.length, state: slice.state })}\n`);
} else if (mode === 'accept') {
  const ctx = openProject(project);
  recordAcceptedConfig(ctx, readFileSync(join(project, '.unknot/config.yaml'), 'utf8'), 'human:upgrade');
  process.stdout.write(`${JSON.stringify({ acceptance: loadConfig(ctx).acceptance })}\n`);
} else {
  process.stderr.write('usage: upgrade-slice.mjs build|check|accept <runtime dir> <project> [slice]\n');
  process.exit(2);
}
