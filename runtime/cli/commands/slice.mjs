// `unknot slice <id>` — a slice with its obligations, approvals and evidence.

import { UnknotError } from '../../core/errors.mjs';
import { output } from '../util.mjs';
import { open, sliceRow } from './_shared.mjs';

export async function run({ positional, flags }) {
  const { ctx } = open(flags);
  const s = sliceRow(ctx, positional[0]);
  if (!s) throw new UnknotError('UK_NOT_FOUND', `no slice ${positional[0]}`);
  const obligations = ctx.store.all('SELECT id, kind, status, requires_human, evidence_id, body FROM proof_obligations WHERE slice_id = ? ORDER BY CAST(substr(id, 4) AS INTEGER)', s.id).map((o) => ({ id: o.id, kind: o.kind, status: o.status, human: Boolean(o.requires_human), evidence: o.evidence_id, description: JSON.parse(o.body).description }));
  const approvals = ctx.store.all('SELECT id, stage, role, approver, expires_at, revoked_at, revoked_reason FROM approvals WHERE slice_id = ?', s.id);
  output({ id: s.id, state: s.state, risk: s.risk, worktree: s.worktree, baseline: s.baseline_commit, diff_hash: s.diff_hash, slice: s.body, obligations, approvals }, { json: true });
}
