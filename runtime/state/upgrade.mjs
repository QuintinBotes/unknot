// Saved artifacts written by an older release, brought to today's shape when they are read.
// Pure and in memory: nothing is written back (a rerun rewrites its own record), and a slice's
// stored body is never touched, because approvals bind to its digest. Each step names the
// release that introduced the field; add one per change to a stored shape (docs/operations.md).

const clone = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => (Array.isArray(v) ? v : []);

/** Decomposition record (.unknot/decompositions/DEC-*.json). */
export function upgradeDecomposition(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const r = clone(rec);
  r.candidate = r.candidate && typeof r.candidate === 'object' ? r.candidate : {};
  const c = r.candidate;
  c.modules = arr(c.modules);
  c.name ??= '';
  // 0.1.11: top files.
  c.top_files = arr(c.top_files);
  c.metrics = c.metrics && typeof c.metrics === 'object' ? c.metrics : {};
  // 0.1.13: `cycle.size` was renamed `cycle.crossing_size` (what it always measured).
  if (c.metrics['cycle.size'] !== undefined && c.metrics['cycle.crossing_size'] === undefined) c.metrics['cycle.crossing_size'] = c.metrics['cycle.size'];
  r.driver = arr(r.driver);
  // 0.1.11: a fingerprint, so a rerun reuses the id. Not derived for an older record: it stays
  // `null` (listed as superseded, prunable) and a rerun's new record names it in `supersedes`.
  r.fingerprint ??= null;
  // 0.1.13: drivers_not_served and the run that wrote the record.
  r.drivers_not_served = arr(r.drivers_not_served);
  r.run_id ??= null;
  // 0.1.14: the record a boundary with changed members replaces.
  r.supersedes ??= null;
  r.rejected_treatments = arr(r.rejected_treatments);
  r.evidence_gaps = arr(r.evidence_gaps);
  return r;
}

/** Slice body, for display and tools (never for the digest). */
export function upgradeSlice(body) {
  if (!body || typeof body !== 'object') return body;
  const s = clone(body);
  for (const k of ['sources', 'patterns', 'owners', 'approvals', 'changes', 'preconditions', 'proof_obligations']) s[k] = arr(s[k]);
  s.scope = { include: arr(s.scope?.include), exclude: arr(s.scope?.exclude) };
  return s;
}

/** Campaign body. */
export function upgradeCampaign(body) {
  if (!body || typeof body !== 'object') return body;
  const c = clone(body);
  for (const k of ['slices', 'alternatives']) c[k] = arr(c[k]);
  return c;
}
