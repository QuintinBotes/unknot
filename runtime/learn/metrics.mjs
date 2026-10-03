// Product and outcome metrics (spec §21.1, §21.2), computed from Unknot's own records:
// the ledger, decisions, findings, slices, evidence and policy results. Counts, rates and
// durations only — never content (spec §21.3: no individual developer metrics).

const rate = (n, d) => (d ? +(n / d).toFixed(3) : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function productMetrics(ctx) {
  const st = ctx.store;
  const decisions = st.all('SELECT decision FROM decisions');
  const accepted = decisions.filter((d) => d.decision === 'accept').length;
  const rejected = decisions.length - accepted;
  const transitions = st.all("SELECT slice_id, payload, at FROM events WHERE type = 'state.transition' AND slice_id IS NOT NULL ORDER BY seq").map((e) => ({ slice: e.slice_id, at: e.at, ...JSON.parse(e.payload) }));
  const reached = (state) => new Set(transitions.filter((t) => t.to === state).map((t) => t.slice));
  const slices = st.all('SELECT id, body, created_at FROM slices').map((s) => ({ id: s.id, created_at: s.created_at, body: JSON.parse(s.body) }));
  // Time from a finding to a review-ready slice built from it.
  const findingCreated = new Map(st.all('SELECT id, created_at FROM findings').map((f) => [f.id, f.created_at]));
  const toReview = [];
  for (const s of slices) {
    const rr = transitions.find((t) => t.slice === s.id && t.to === 'REVIEW_READY');
    const src = (s.body.sources ?? []).find((x) => findingCreated.has(x));
    if (rr && src) toReview.push((new Date(rr.at) - new Date(findingCreated.get(src))) / 3.6e6);
  }
  const evidence = st.all("SELECT verdict, record FROM evidence WHERE obligation_id IS NOT NULL");
  const executed = evidence.filter((e) => !JSON.parse(e.record).kind?.startsWith('human'));
  const policy = st.all('SELECT decision FROM policy_results');
  const accepted_slices = reached('ACCEPTED');
  const escaped = [...reached('ROLLED_BACK')].filter((id) => accepted_slices.has(id) && transitions.findIndex((t) => t.slice === id && t.to === 'ROLLED_BACK') > transitions.findIndex((t) => t.slice === id && t.to === 'ACCEPTED'));
  const reviewChanges = transitions.filter((t) => t.from === 'REVIEW_READY' && t.to === 'PATCHING').length;
  return {
    findings: {
      decided: decisions.length,
      acceptance_rate: rate(accepted, decisions.length),
      rejection_rate: rate(rejected, decisions.length),
      false_positive_rate: rate(rejected, decisions.length),
    },
    delivery: {
      median_hours_finding_to_review_ready: median(toReview),
      slices: slices.length,
      proof_success_rate: rate(executed.filter((e) => e.verdict === 'pass').length, executed.length),
      replan_rate: rate(reached('NEEDS_REPLAN').size, slices.length),
      rollback_rate: rate(reached('ROLLED_BACK').size, slices.length),
      review_change_requests: reviewChanges,
      escaped_regression_rate: rate(escaped.length, accepted_slices.size),
    },
    governance: {
      policy_decisions: policy.length,
      policy_block_rate: rate(policy.filter((p) => p.decision === 'deny').length, policy.length),
    },
  };
}

/** Complexity outcomes for the current graph generation (spec §21.2), snapshotted over time. */
export function outcomeSnapshot(ctx, graph, { stronglyConnected }) {
  const imports = stronglyConnected(graph, { edgeTypes: ['IMPORTS'] });
  const snap = {
    generation: Number(ctx.store.meta('generation') ?? 0),
    commit: ctx.store.meta('mapped_commit') || null,
    dependency_cycles: imports.length,
    modules_in_cycles: imports.reduce((n, c) => n + c.length, 0),
    public_endpoints: graph.nodes('endpoint').length,
    privileged_roles: graph.nodes('role').filter((r) => r.attrs.wildcard_verbs || r.attrs.cluster_admin || (r.attrs.wildcard_actions ?? []).length).length,
    open_findings: ctx.store.get("SELECT COUNT(*) AS n FROM findings WHERE status = 'open'").n,
    duplicate_groups: ctx.store.get("SELECT COUNT(*) AS n FROM findings WHERE status = 'open' AND kind = 'code.duplicated-code'").n,
    shared_writer_tables: ctx.store.get("SELECT COUNT(*) AS n FROM findings WHERE status = 'open' AND kind IN ('decomposition.shared-table-writers','service.shared-database','database.multiple-writers')").n,
  };
  const history = JSON.parse(ctx.store.meta('metrics:outcomes') ?? '[]');
  if (!history.length || history.at(-1).generation !== snap.generation) {
    history.push(snap);
    ctx.store.meta('metrics:outcomes', JSON.stringify(history.slice(-200)));
  }
  return { current: snap, previous: history.length > 1 ? history.at(-2) : null };
}
