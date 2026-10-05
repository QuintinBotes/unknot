// /unknot:status — campaigns, slices, approvals, blockers and stale evidence.

import { head } from '../../apply/git.mjs';
import { activeRun } from '../../state/runs.mjs';
import { humanCommand, output, table } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ flags }) {
  const { ctx, config, cfg } = open(flags);
  const now = new Date().toISOString();
  const run = activeRun(ctx.store);
  const mapped = ctx.store.meta('mapped_commit');
  const current = head(ctx.root);
  const slices = ctx.store.all('SELECT id, campaign_id, state, risk, updated_at FROM slices ORDER BY id');
  const campaigns = ctx.store.all('SELECT id, status, body FROM campaigns ORDER BY id').map((c) => ({ id: c.id, status: c.status, objective: JSON.parse(c.body).objective }));
  const findings = ctx.store.all('SELECT status, COUNT(*) AS n FROM findings GROUP BY status');
  const expired = ctx.store.get('SELECT COUNT(*) AS n FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?', now).n;
  const stale = ctx.store.all("SELECT slice_id, COUNT(*) AS n FROM approvals WHERE revoked_at IS NULL AND expires_at < ? GROUP BY slice_id", now);
  const open_obligations = ctx.store.all("SELECT slice_id, COUNT(*) AS n FROM proof_obligations WHERE status IN ('open','inconclusive','fail') GROUP BY slice_id");
  const status = {
    mode: config.mode,
    config_acceptance: cfg.acceptance,
    active_run: run ? { id: run.id, command: run.command, started_at: run.started_at, slice: run.slice_id } : null,
    graph: { generation: ctx.store.meta('generation'), mapped_commit: mapped || null, head: current, stale: Boolean(mapped && current && mapped !== current) },
    findings: Object.fromEntries(findings.map((f) => [f.status, f.n])),
    campaigns,
    slices,
    blockers: slices.filter((s) => s.state.startsWith('BLOCKED') || s.state === 'NEEDS_REPLAN' || s.state === 'VERIFICATION_FAILED'),
    awaiting_approval: slices.filter((s) => s.state === 'AWAITING_APPROVAL' || s.state === 'REVIEW_READY').map((s) => s.id),
    open_obligations,
    stale_evidence: { expired_runtime_facts: expired, expired_approvals: stale },
  };
  if (flags.json) return output(status, { json: true });
  const lines = [
    `Mode: ${status.mode}${run ? ` · active run ${run.id} (${run.command})` : ''}${cfg.notice ? `\nConfig: ${cfg.notice}` : ''}`,
    `Graph: generation ${status.graph.generation ?? '—'} at ${mapped?.slice(0, 12) || '—'}${status.graph.stale ? ` (STALE: HEAD is ${current?.slice(0, 12)}; run unknot map)` : ''}`,
    `Findings: ${Object.entries(status.findings).map(([k, v]) => `${v} ${k}`).join(', ') || 'none (run unknot diagnose)'}`,
    '',
    'Campaigns:',
    table(campaigns, ['id', 'status', 'objective']),
    '',
    'Slices:',
    table(slices, ['id', 'campaign_id', 'state', 'risk']),
  ];
  if (status.awaiting_approval.length) lines.push('', `Awaiting human approval: ${status.awaiting_approval.join(', ')} (in a separate terminal window: ${humanCommand('approve <slice> --role <role> --as <name>')})`);
  if (expired) lines.push(`Stale evidence: ${expired} runtime/plan facts past their TTL; re-import evidence.`);
  output(lines.join('\n'));
}
