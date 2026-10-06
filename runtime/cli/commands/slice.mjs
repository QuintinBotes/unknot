// `unknot slice <id>` — a slice with its obligations, approvals and evidence.
// `unknot slice <id> diff` — the slice's patch (staged, else working changes) in its worktree:
// the read-only way to look at it, since shell commands into .unknot/ are denied.

import { UnknotError } from '../../core/errors.mjs';
import { git } from '../../apply/git.mjs';
import { redact } from '../../core/redact.mjs';
import { staleEvidence } from '../../plan/staleness.mjs';
import { output } from '../util.mjs';
import { open, sliceRow } from './_shared.mjs';

export async function run({ positional, flags }) {
  const { ctx, config } = open(flags);
  const s = sliceRow(ctx, positional[0]);
  if (!s) throw new UnknotError('UK_NOT_FOUND', `no slice ${positional[0]}`);
  if (positional[1] === 'diff') {
    if (!s.worktree) throw new UnknotError('UK_STATE_CONFLICT', `slice ${s.id} has no worktree yet (state ${s.state})`);
    const args = s.diff_hash ? ['diff', '--cached', '--no-ext-diff', '--no-textconv'] : ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'];
    const stat = git(s.worktree, [...args, '--stat'], { check: false }).stdout;
    const patch = git(s.worktree, args, { check: false }).stdout;
    const max = Number(flags.max ?? 400);
    const lines = patch.split('\n');
    const body = lines.length > max ? `${lines.slice(0, max).join('\n')}\n… ${lines.length - max} more lines (--max N)` : patch;
    return output(redact(`${stat}\n${body}`).text);
  }
  const obligations = ctx.store.all('SELECT id, kind, status, requires_human, evidence_id, body FROM proof_obligations WHERE slice_id = ? ORDER BY CAST(substr(id, 4) AS INTEGER)', s.id).map((o) => ({ id: o.id, kind: o.kind, status: o.status, human: Boolean(o.requires_human), evidence: o.evidence_id, description: JSON.parse(o.body).description }));
  const approvals = ctx.store.all('SELECT id, stage, role, approver, expires_at, revoked_at, revoked_reason FROM approvals WHERE slice_id = ?', s.id);
  const { sliceStanding } = await import('../../policy/lanes.mjs');
  const st = sliceStanding(s, config);
  const stale = staleEvidence(ctx, s.body);
  output({ id: s.id, state: s.state, risk: s.risk, risk_reasons: st.risk_reasons, required_approvals: st.approvals, lane: st.lane, ...(stale.length && { stale_evidence: stale }), worktree: s.worktree, baseline: s.baseline_commit, diff_hash: s.diff_hash, slice: s.body, obligations, approvals }, { json: true });
}
