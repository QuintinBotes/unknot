// Whether the findings a slice was planned from are still reported. A re-map and re-diagnose
// resolves a finding that is no longer detected; a slice built on it keeps its state and
// approvals, but what it was built on no longer holds, so reads say so. Computed on read.

import { guidanceDigests } from '../core/guidance.mjs';
import { conventionChanges } from '../policy/approvals.mjs';

const FINDING_ID = /^F-\d{4,}$/;

/**
 * The finding sources of a slice that are no longer reported.
 * @returns {{finding_id: string, status: string, message: string}[]}
 */
export function staleEvidence(ctx, body) {
  const out = [];
  for (const id of body?.sources ?? []) {
    if (!FINDING_ID.test(id)) continue;
    const row = ctx.store.get('SELECT status FROM findings WHERE id = ?', id);
    if (row && row.status !== 'resolved') continue;
    out.push({ finding_id: id, status: row?.status ?? 'missing', message: `evidence is stale: finding ${id} is no longer reported by the current map` });
  }
  return out;
}

/** Stale evidence per slice, for slices that have any: `{slice_id, findings: [...]}`. */
export function staleSlices(ctx) {
  const out = [];
  for (const row of ctx.store.all('SELECT id, body FROM slices ORDER BY id')) {
    const findings = staleEvidence(ctx, JSON.parse(row.body));
    if (findings.length) out.push({ slice_id: row.id, findings });
  }
  return out;
}

/**
 * Guidance files whose content changed since a live approval of the slice was signed: those
 * approvals no longer hold, and the slice needs re-approval. [] for a slice without a report.
 */
export function conventionDrift(ctx, row) {
  const body = typeof row.body === 'string' ? JSON.parse(row.body) : row.body;
  const current = guidanceDigests(ctx.root, body);
  if (!current) return [];
  // Only each signer's latest approval per stage and role counts: one given again after the change replaces the stale one.
  const latest = new Map();
  for (const a of ctx.store.all('SELECT stage, role, approver, binding FROM approvals WHERE slice_id = ? AND revoked_at IS NULL ORDER BY created_at, rowid', row.id)) latest.set(`${a.stage}|${a.role}|${a.approver}`, a);
  const files = new Set();
  for (const a of latest.values()) {
    for (const f of conventionChanges(JSON.parse(a.binding).guidance_digests, current)) files.add(f);
  }
  return [...files].sort();
}

/** Open slices that need re-approval because their conventions changed: `{slice_id, files, reason}`. */
export function reapprovalSlices(ctx) {
  const out = [];
  for (const row of ctx.store.all("SELECT id, body FROM slices WHERE state NOT IN ('ACCEPTED', 'ABANDONED', 'ROLLED_BACK') ORDER BY id")) {
    const files = conventionDrift(ctx, row);
    if (files.length) out.push({ slice_id: row.id, files, reason: files.map((f) => `conventions changed (${f})`).join(', ') });
  }
  return out;
}
