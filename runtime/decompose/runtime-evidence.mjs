// Measured cross-boundary traffic for a decomposition candidate, from runtime call edges
// (imported with `unknot import runtime`, or derived from traces), and the confidence cap
// that static evidence alone puts on extraction. Coverage and its threshold are defined
// here and documented in docs/decomposition.md; nothing else decides them.

/**
 * Coverage = the share of the candidate's boundary edges (static imports between a member
 * module and a module outside it, either direction) that some runtime row connects. The
 * cap lifts at or above this share.
 */
export const COVERAGE_THRESHOLD = 0.5;
/** Treatments that move behaviour or data behind a network seam; static evidence alone caps them. */
export const CAPPED_TREATMENTS = new Set(['T3', 'T6', 'T7']);
export const STATIC_CAP = 'medium';

const ownerCache = new WeakMap();

/** The modules a runtime endpoint stands for: itself, its file, the code behind a route, or a service's code root. */
function ownersOf(graph, id) {
  let cache = ownerCache.get(graph);
  if (!cache) ownerCache.set(graph, (cache = new Map()));
  if (cache.has(id)) return cache.get(id);
  const n = graph.node(id);
  const out = new Set();
  const viaSymbol = (symbol) => {
    const own = symbol.path && graph.node(`module:${symbol.path}`);
    if (own) out.add(own.id);
    else {
      const parent = graph.parent(symbol.id);
      if (parent?.type === 'module') out.add(parent.id);
    }
  };
  if (n?.type === 'module') out.add(id);
  else if (n?.type === 'service') {
    const root = typeof n.attrs?.code_root === 'string' ? n.attrs.code_root.replace(/^\.\//, '').replace(/\/$/, '') : '';
    if (root && root !== '.') for (const m of graph.nodes('module')) if ((m.path ?? m.id.slice(7)).startsWith(`${root}/`)) out.add(m.id);
  } else if (n?.type === 'endpoint' || n?.type === 'route' || n?.type === 'constant') {
    for (const e of graph.in(id, ['EXPOSES', 'DEFINES', 'RENDERS'])) {
      const from = graph.node(e.from);
      if (from?.type === 'module') out.add(from.id);
      else if (from && from.type !== 'service') viaSymbol(from);
    }
  } else if (n) viaSymbol(n);
  cache.set(id, out);
  return out;
}

const hit = (set, other) => {
  for (const x of set) if (other.has(x)) return true;
  return false;
};

/**
 * @param {import('../graph/graph.mjs').Graph} graph
 * @param {Set<string>} members candidate module ids
 * @param {{now?: string}} [env] reference time: the age of the evidence and whether it expired
 * @returns {{metrics: object, gaps: string[], freshness?: object, runtime: object|null}}
 */
export function runtimeBoundary(graph, members, { now = new Date().toISOString() } = {}) {
  const all = graph.edges('RUNTIME_CALLS').filter((e) => Number.isFinite(e.attrs?.calls));
  if (!all.length) return { metrics: {}, gaps: [], runtime: null };
  // Expired edges are still used: their signals are reported stale and lower confidence one step (#239).
  const gaps = [];
  const sides = all.map((e) => ({ e, a: ownersOf(graph, e.from), b: ownersOf(graph, e.to) })).filter((s) => s.a.size && s.b.size);
  const crossing = sides.filter(({ a, b }) => (hit(a, members) && !hit(b, members)) || (hit(b, members) && !hit(a, members)));
  // Boundary edges, and which of them a runtime edge connects (either direction).
  const boundary = [];
  for (const id of members) {
    for (const e of [...graph.out(id, 'IMPORTS'), ...graph.in(id, 'IMPORTS')]) {
      const other = e.from === id ? e.to : e.from;
      if (!members.has(other) && graph.node(other)?.type === 'module') boundary.push(e.from === id ? [id, other] : [other, id]);
    }
  }
  const callers = new Map();
  const callees = new Map();
  sides.forEach(({ a, b }, i) => {
    for (const m of a) (callers.get(m) ?? callers.set(m, new Set()).get(m)).add(i);
    for (const m of b) (callees.get(m) ?? callees.set(m, new Set()).get(m)).add(i);
  });
  const joined = (x, y) => [...(callers.get(x) ?? [])].some((i) => callees.get(y)?.has(i));
  const unique = [...new Map(boundary.map((p) => [p.join('\0'), p])).values()];
  const covered = unique.filter(([x, y]) => joined(x, y) || joined(y, x)).length;
  const coverage = unique.length ? +(covered / unique.length).toFixed(3) : null;

  const metrics = {};
  if (crossing.length) {
    const calls = crossing.reduce((n, { e }) => n + e.attrs.calls, 0);
    const p95s = crossing.map(({ e }) => e.attrs.p95_ms).filter(Number.isFinite);
    const rated = crossing.filter(({ e }) => Number.isFinite(e.attrs.error_rate));
    const ratedCalls = rated.reduce((n, { e }) => n + e.attrs.calls, 0);
    metrics['runtime.cross_boundary_calls'] = calls;
    if (p95s.length) metrics['runtime.cross_boundary_p95_ms'] = Math.max(...p95s);
    if (ratedCalls > 0) metrics['runtime.cross_boundary_error_rate'] = +(rated.reduce((n, { e }) => n + e.attrs.error_rate * e.attrs.calls, 0) / ratedCalls).toFixed(4);
  } else gaps.push('runtime rows reach no edge that crosses this boundary: cross-boundary call volume is not measured for it');
  if (coverage !== null) metrics['runtime.boundary_coverage'] = coverage;
  if (coverage !== null && coverage < COVERAGE_THRESHOLD) gaps.push(`runtime coverage ${coverage} of this boundary's edges is below ${COVERAGE_THRESHOLD}: the static-only confidence cap stays`);
  // The age of what this boundary's runtime signals were measured on: the crossing edges, else every placed edge.
  const used = (crossing.length ? crossing : sides).map(({ e }) => e.attrs);
  const age = freshnessOf(used.length ? used : all.map((e) => e.attrs), now);
  const freshness = Object.fromEntries(['traces.available', ...Object.keys(metrics)].map((k) => [k, age]));
  gaps.push(...ageGaps('runtime evidence', age, now));

  const starts = crossing.map(({ e }) => e.attrs.observed_window?.start).filter(Boolean).sort();
  const ends = crossing.map(({ e }) => e.attrs.observed_window?.end).filter(Boolean).sort();
  const sources = [...new Set(crossing.flatMap(({ e }) => (e.attrs.imported ? (e.attrs.sources ?? []).map((x) => `import:${x}`) : ['traces'])))].sort();
  const lifted = coverage !== null && coverage >= COVERAGE_THRESHOLD && crossing.length > 0;
  return {
    metrics,
    gaps,
    freshness,
    runtime: {
      label: 'observed',
      window: starts.length ? { start: starts[0], end: ends[ends.length - 1] } : null,
      sources,
      edges: crossing.map(({ e }) => e.id).sort().slice(0, 50),
      boundary_edges: unique.length,
      covered_edges: covered,
      coverage,
      coverage_threshold: COVERAGE_THRESHOLD,
      cap: lifted ? 'lifted' : 'applies',
    },
  };
}

const DAY_MS = 86_400_000;
export const daysBetween = (from, to) => Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);

/**
 * Age of the facts a signal was measured on: whole days from the earliest observed window end
 * to `now` (null when none has a window), the earliest expiry, and whether it has passed.
 * @returns {{age_days: number|null, expires_at: string|null, stale: boolean}}
 */
export function freshnessOf(attrs, now) {
  const end = attrs.map((a) => a?.observed_window?.end).filter(Boolean).sort()[0];
  const expires_at = attrs.map((a) => a?.expires_at).filter(Boolean).sort()[0] ?? null;
  return { age_days: end ? daysBetween(end, now) : null, expires_at, stale: Boolean(expires_at && expires_at < now) };
}

/** Gap lines for one kind of evidence: its age is unknown, or it expired and how long ago. */
export function ageGaps(what, f, now) {
  if (!f) return [];
  return [
    ...(f.age_days === null ? [`${what} has no observed window: its age is unknown`] : []),
    ...(f.stale ? [`${what} expired ${daysBetween(f.expires_at, now)} day(s) ago (${f.expires_at}): its signals are still reported, marked stale, and lower the confidence one step; re-export and import again`] : []),
  ];
}

/**
 * Static evidence alone caps an extraction treatment at `medium`. Enough runtime coverage
 * lifts the cap; a lower confidence is never raised.
 * @returns {{confidence: string, capped: boolean, reason: string|null}}
 */
export function capConfidence(confidence, treatment, runtime) {
  if (confidence !== 'high' || !CAPPED_TREATMENTS.has(treatment) || runtime?.cap === 'lifted') return { confidence, capped: false, reason: null };
  const why = runtime
    ? `runtime coverage ${runtime.coverage ?? 'unmeasured'} is below ${COVERAGE_THRESHOLD}`
    : 'no runtime evidence covers this boundary';
  return { confidence: STATIC_CAP, capped: true, reason: `confidence capped at ${STATIC_CAP} for ${treatment}: static evidence alone (${why})` };
}

/** The record's `runtime_evidence`: the measured signal, labelled observed, with its window and coverage. */
export function runtimeSummary(runtime, metrics) {
  return {
    label: runtime.label,
    window: runtime.window,
    sources: runtime.sources,
    cross_boundary_calls: metrics['runtime.cross_boundary_calls'] ?? null,
    cross_boundary_p95_ms: metrics['runtime.cross_boundary_p95_ms'] ?? null,
    cross_boundary_error_rate: metrics['runtime.cross_boundary_error_rate'] ?? null,
    coverage: runtime.coverage,
    coverage_threshold: runtime.coverage_threshold,
    covered_edges: runtime.covered_edges,
    boundary_edges: runtime.boundary_edges,
    cap: runtime.cap,
    edges: runtime.edges,
  };
}
