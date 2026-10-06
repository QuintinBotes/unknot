// Whether the findings a slice was planned from are still reported. A re-map and re-diagnose
// resolves a finding that is no longer detected; a slice built on it keeps its state and
// approvals, but what it was built on no longer holds, so reads say so. Computed on read.

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
