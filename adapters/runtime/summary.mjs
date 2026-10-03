// Read-only digest of runtime facts for the CLI: services, chatty edges, error hotspots,
// and evidence windows with staleness against a reference time (§9.5 TTLs, §15A.4 CC).

import { EXTRACTOR } from './util.mjs';

const DAY_MS = 86_400_000;
const TOP = 10;

/**
 * @param {object[]} facts facts from this adapter (others are ignored)
 * @param {string} [now] ISO reference time; staleness is unknown without it
 */
export function summarizeRuntime(facts, now = null) {
  const nowMs = now ? Date.parse(now) : NaN;
  const mine = facts.filter((f) => f?.provenance?.extractor === EXTRACTOR);
  const services = [];
  const edges = [];
  const hot = [];
  const files = new Map();

  for (const f of mine) {
    const a = f.attrs ?? {};
    const file = String(f.provenance.source_ref ?? '').split('#')[0];
    if (a.observed_window) {
      const w = files.get(file) ?? { file, start: a.observed_window.start, end: a.observed_window.end, expires_at: a.expires_at, facts: 0 };
      if (a.observed_window.start < w.start) w.start = a.observed_window.start;
      if (a.observed_window.end > w.end) w.end = a.observed_window.end;
      if (a.expires_at > w.expires_at) w.expires_at = a.expires_at;
      w.facts += 1;
      files.set(file, w);
    }
    if (f.kind === 'node' && f.type === 'service') {
      services.push({
        name: f.name, span_count: a.span_count ?? null, error_rate: a.error_rate ?? null, p95_ms: a.p95_ms ?? null,
        owner: a.owner ?? null, tier: a.tier ?? null, code_root: a.code_root ?? null, call_cycles: a.call_cycles ?? null,
      });
      if (a.error_rate > 0) hot.push({ kind: 'service', name: f.name, error_rate: a.error_rate, weight: a.error_rate * (a.span_count ?? 1) });
    } else if (f.kind === 'edge' && f.type === 'RUNTIME_CALLS') {
      edges.push({ from: f.from, to: f.to, calls: a.calls, p95_ms: a.p95_ms, error_rate: a.error_rate, per_request_p95: a.per_request_p95 ?? null });
      if (a.error_rate > 0) hot.push({ kind: 'edge', name: `${f.from} -> ${f.to}`, error_rate: a.error_rate, weight: a.error_rate * (a.calls ?? 1) });
    } else if (f.kind === 'edge' && f.type === 'EXPOSES' && a.error_rate > 0) {
      hot.push({ kind: 'endpoint', name: f.to, error_rate: a.error_rate, weight: a.error_rate * (a.calls ?? 1) });
    }
  }

  const byName = (x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
  const windows = [...files.values()].sort((x, y) => (x.file < y.file ? -1 : 1)).map((w) => {
    const exp = Date.parse(w.expires_at);
    const stale = Number.isFinite(nowMs) && Number.isFinite(exp) ? nowMs > exp : null;
    const end = Date.parse(w.end);
    const age = Number.isFinite(nowMs) && Number.isFinite(end) ? Math.max(0, Math.round(((nowMs - end) / DAY_MS) * 10) / 10) : null;
    return { ...w, stale, age_days: age };
  });

  return {
    services: services.sort(byName),
    chatty_edges: edges.sort((x, y) => y.calls - x.calls || (x.from + x.to < y.from + y.to ? -1 : 1)).slice(0, TOP),
    error_hotspots: hot.sort((x, y) => y.weight - x.weight || byName(x, y)).slice(0, TOP).map(({ weight, ...rest }) => rest),
    windows,
    stale_files: windows.filter((w) => w.stale === true).map((w) => w.file),
  };
}
