// `unknot lane approve <CMP-id> --as <approver> [--kinds deletion,tests] [--max-files N] [--max-lines N] [--expires 72h]`
// `unknot lane status [LN-id|CMP-id]`, `unknot lane review <LN-id>`, `unknot lane revoke <LN-id> --reason "..."`
// A lane is one signed plan approval for the low-risk slices of a campaign (see policy/lanes.mjs).
// Approving and revoking are a person's, in a terminal; status and review are read-only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnknotError } from '../../core/errors.mjs';
import { loadApproverKey } from '../../core/keys.mjs';
import { LANE_DEFAULTS, draftLane, getLane, laneSlices, laneValidity, lanesFor, recordLane, revokeLane } from '../../policy/lanes.mjs';
import { humanCommand, output, prompt, requireHumanTTY, table } from '../util.mjs';
import { open } from './_shared.mjs';

const int = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new UnknotError('UK_CONFIG_INVALID', `--${name} needs a positive whole number`);
  return n;
};

async function approve(positional, flags) {
  requireHumanTTY('approving a lane');
  const campaignId = positional[1];
  const approver = flags.as;
  if (!campaignId || !approver) throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot lane approve <CMP-id> --as <approver> [--kinds deletion,tests] [--max-files N] [--max-lines N] [--expires 72h]');
  const { ctx, cfg } = open(flags);
  const { lane, excluded } = draftLane(ctx, {
    cfg,
    campaignId,
    kinds: flags.kinds ? String(flags.kinds).split(',').map((k) => k.trim()) : undefined,
    maxFiles: int(flags.max_files ?? flags['max-files'], 'max-files'),
    maxLines: int(flags.max_lines ?? flags['max-lines'], 'max-lines'),
    expiry: flags.expires ?? cfg.config.approvals.expiry ?? LANE_DEFAULTS.expiry,
  });
  const covered = Object.keys(lane.slices);
  const rows = covered.map((id) => ({ id, objective: JSON.parse(ctx.store.get('SELECT body FROM slices WHERE id = ?', id).body).objective }));
  output([
    `Lane for ${campaignId}, as ${approver} / ${lane.role ?? '—'}`,
    `The agent may apply and verify these slices without asking you per slice. Each patch must ${lane.kinds.map((k) => (k === 'deletion' ? 'only delete code' : 'only change tests')).join(' or ')}, within ${lane.max_changed_files} files and ${lane.max_diff_lines} lines; anything else is refused. You still approve every change before it is accepted.`,
    '',
    covered.length ? table(rows, ['id', 'objective']) : 'No slice fits a lane.',
    ...(excluded.length ? ['', 'Not in the lane (they need their own approval):', ...excluded.map((e) => `  ${e.id}: ${e.problems.join('; ')}`)] : []),
    '',
    `Policy digest: ${lane.policy_digest}`,
    `Expires: ${lane.expires_at}`,
  ].join('\n'));
  if (!covered.length) return 1;
  if (prompt(`Type ${campaignId} to approve this lane: `).trim() !== campaignId) throw new UnknotError('UK_POLICY_DENIED', 'confirmation did not match; nothing recorded');
  const key = loadApproverKey(approver, prompt(`Passphrase for ${approver}: `, { secret: true }));
  const row = recordLane(ctx, { config: cfg.config, lane, approver, privateKey: key, actor: `human:${approver}` });
  output([
    `Recorded ${row.id}. Ask Claude to work through the lane (/unknot:lane ${row.id}).`,
    `When slices are ready: review them with unknot lane review ${row.id}, then accept them with`,
    `  ${humanCommand(`approve --lane ${row.id} --as ${approver}`)}`,
  ].join('\n'));
}

function status(positional, flags) {
  const { ctx, cfg } = open(flags);
  const arg = positional[1];
  const lanes = arg?.startsWith('LN-') ? [getLane(ctx, arg)] : lanesFor(ctx, arg ?? null);
  const rows = lanes.map((l) => {
    const problems = laneValidity(l, cfg);
    const slices = Object.keys(l.body.slices).map((id) => `${id}:${ctx.store.get('SELECT state FROM slices WHERE id = ?', id)?.state ?? '?'}`);
    return { id: l.id, campaign: l.campaign_id, valid: problems.length ? `no (${problems.join('; ')})` : 'yes', kinds: l.body.kinds.join(','), caps: `${l.body.max_changed_files}f/${l.body.max_diff_lines}l`, expires: l.expires_at, slices: slices.join(' ') };
  });
  if (flags.json) return output(rows, { json: true });
  output(rows.length ? table(rows, ['id', 'campaign', 'valid', 'kinds', 'caps', 'expires', 'slices']) : 'No lanes.');
}

function review(positional, flags) {
  const { ctx } = open(flags);
  const lane = getLane(ctx, positional[1]);
  const ready = laneSlices(ctx, lane.id).filter((s) => s.state === 'REVIEW_READY');
  if (!ready.length) return output(`No slice of ${lane.id} is ready for review.`);
  const parts = [];
  for (const s of ready) {
    const ev = ctx.store.get("SELECT run_id FROM events WHERE type = 'apply.finished' AND slice_id = ? ORDER BY seq DESC LIMIT 1", s.id);
    let patch = '(patch not found; see the slice worktree)';
    try {
      patch = readFileSync(join(ctx.paths.runs, ev.run_id, 'diff.patch'), 'utf8');
    } catch {
      // the run directory was cleaned up; the worktree still has the change
    }
    parts.push(`=== ${s.id}: ${s.body.objective}\n    diff ${s.diff_hash}, worktree ${s.worktree}\n\n${patch}`);
  }
  output(parts.join('\n'));
}

export async function run({ positional, flags }) {
  const sub = positional[0] ?? 'status';
  if (sub === 'approve') return approve(positional, flags);
  if (sub === 'status') return status(positional, flags);
  if (sub === 'review') return review(positional, flags);
  if (sub === 'revoke') {
    requireHumanTTY('revoking a lane');
    const { ctx, actor } = open(flags);
    const lane = revokeLane(ctx, positional[1], { reason: flags.reason ?? null, actor });
    return output(`Revoked ${lane.id}. Slices already patched under it keep their state; new ones need their own approval.`);
  }
  throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot lane approve|status|review|revoke');
}
