// Imported delivery history (`unknot import deliveries`): rows kept in the store are
// aggregated per deployable unit and turned into facts on every map. A unit becomes a
// `deployable` node with the same id the CI adapter uses, so measured delivery data
// merges onto the CI-derived node; units released together get a RELEASED_WITH edge.

import { freshness } from '../../database/stats/facts.mjs';
import { underRoot } from '../../../runtime/core/paths.mjs';
import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { ascending, percentile, round, ttlOf } from '../../runtime/util.mjs';
import { EXTRACTOR } from '../util.mjs';

export { ttlOf };
export const RELEASED_WITH = 'RELEASED_WITH';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The window one stored import covers: the span of its counted rows (stored, or recomputed). */
function importWindow(imp) {
  if (imp.window?.start && imp.window?.end) return imp.window;
  const times = (imp.rows ?? []).map((r) => r.deployed_at).filter(Boolean).sort();
  return times.length ? { start: times[0], end: times[times.length - 1] } : null;
}

/** Conventional median of an ascending array: the middle value, averaged when even. */
function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The value a unit's rows name most often (ties keep the lexicographically first). */
function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))[0]?.[0] ?? null;
}

/**
 * Aggregate every stored import per unit. Several sources for one unit combine their
 * counts and keep the union of the windows of the imports that name the unit.
 * @returns {Map<string, object>} unit name to its measured delivery data
 */
function aggregateDeliveries(imports, graph) {
  const units = new Map();
  for (const imp of [...imports].sort((a, b) => byName(a.source, b.source))) {
    const window = importWindow(imp);
    if (!window) continue;
    const touched = new Set();
    for (const r of imp.rows ?? []) {
      let u = units.get(r.unit);
      if (!u) {
        units.set(r.unit, (u = {
          unit: r.unit, deployments: 0, failures: 0, rolled_back: 0, leads: [], roots: [],
          releases: new Set(), sources: new Set(), imported_at: imp.imported_at, start: null, end: null,
        }));
      }
      u.deployments += 1;
      if (r.status === 'failure') u.failures += 1;
      else if (r.status === 'rolled_back') u.rolled_back += 1;
      const lead = r.committed_at ? (Date.parse(r.deployed_at) - Date.parse(r.committed_at)) / HOUR_MS : null;
      if (lead !== null && Number.isFinite(lead) && lead >= 0) u.leads.push(lead);
      if (r.code_root) u.roots.push(r.code_root);
      if (r.release) u.releases.add(r.release);
      u.sources.add(imp.source);
      if (imp.imported_at > u.imported_at) u.imported_at = imp.imported_at;
      touched.add(r.unit);
    }
    for (const name of touched) {
      const u = units.get(name);
      if (!u.start || window.start < u.start) u.start = window.start;
      if (!u.end || window.end > u.end) u.end = window.end;
    }
  }
  const serviceRoot = new Map();
  if (graph) {
    for (const n of graph.nodes('service')) {
      const root = typeof n.attrs?.code_root === 'string' && n.attrs.code_root ? n.attrs.code_root : null;
      if (root && !serviceRoot.has(n.name)) serviceRoot.set(n.name, root);
    }
  }
  for (const u of units.values()) {
    const days = Math.max((Date.parse(u.end) - Date.parse(u.start)) / DAY_MS, 1);
    const leads = ascending(u.leads);
    u.window = { start: u.start, end: u.end };
    u.delivery = {
      deployments: u.deployments,
      failures: u.failures,
      rolled_back: u.rolled_back,
      change_failure_rate: round((u.failures + u.rolled_back) / u.deployments, 3),
      deploys_per_week: round((u.deployments / days) * 7, 2),
      lead_time_median_hours: leads.length ? round(median(leads), 3) : null,
      lead_time_p90_hours: leads.length ? round(percentile(leads, 90), 3) : null,
      code_root: mostCommon(u.roots) ?? serviceRoot.get(u.unit) ?? null,
    };
  }
  return units;
}

/**
 * Facts for every stored import: one `deployable` node per unit carrying
 * `attrs.delivery`, and one RELEASED_WITH edge per pair of units sharing a release.
 * @param {{source: string, imported_at: string, rows: object[], window?: object}[]} imports
 */
export function deliveryImportFacts(imports, graph, { options = {} } = {}) {
  const ttlDays = ttlOf(options);
  const units = aggregateDeliveries(imports, graph);
  const facts = [];
  const p = (sources, locator) => prov({
    source_type: 'catalog', source_ref: `import:${[...sources].sort().join('+')}#${locator}`, extractor: EXTRACTOR, confidence: 'medium',
  });
  for (const u of [...units.values()].sort((a, b) => byName(a.unit, b.unit))) {
    const sources = [...u.sources].sort();
    facts.push(nodeFact('deployable', u.unit, {
      name: u.unit,
      attrs: {
        delivery: {
          ...u.delivery,
          sources,
          imported: true,
          imported_at: u.imported_at,
          ...freshness(u.window, ttlDays),
        },
      },
    }, p(sources, `unit/${u.unit}`)));
  }
  // Released together: release ids two units share, counted across every source.
  const pairs = new Map();
  const names = [...units.keys()].sort(byName);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = units.get(names[i]);
      const b = units.get(names[j]);
      const shared = [...a.releases].filter((r) => b.releases.has(r));
      if (!shared.length) continue;
      const sources = [...new Set([...a.sources, ...b.sources])].sort();
      const window = { start: a.window.start < b.window.start ? a.window.start : b.window.start, end: a.window.end > b.window.end ? a.window.end : b.window.end };
      pairs.set(`${names[i]}\0${names[j]}`, { a, b, releases: shared.length, sources, window });
    }
  }
  for (const { a, b, releases, sources, window } of [...pairs.values()].sort((x, y) => byName(`${x.a.unit}\0${x.b.unit}`, `${y.a.unit}\0${y.b.unit}`))) {
    facts.push(edgeFact(RELEASED_WITH, `deployable:${a.unit}`, `deployable:${b.unit}`, {
      releases,
      share: round(releases / Math.min(a.releases.size, b.releases.size), 3),
      sources,
      imported: true,
      ...freshness(window, ttlDays),
    }, p(sources, `released-with/${a.unit}->${b.unit}`)));
  }
  return facts;
}

/**
 * What an import matched, read from the re-projected graph: a unit is matched when
 * its code root (from its rows, else a same-named service) holds a module.
 */
export function matchReport(imp, graph) {
  const paths = graph.nodes('module').map((n) => n.path ?? n.id.slice('module:'.length));
  const units = [...new Set((imp.rows ?? []).map((r) => r.unit))].sort(byName);
  const matched = [];
  const unmatched = [];
  for (const unit of units) {
    const root = graph.node(`deployable:${unit}`)?.attrs?.delivery?.code_root ?? null;
    const placed = typeof root === 'string' && paths.some((pth) => underRoot(pth, root));
    (placed ? matched : unmatched).push(unit);
  }
  return { units, units_matched: matched, units_unmatched: unmatched };
}
