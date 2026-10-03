// Decomposition detectors (spec §15A.9) for the inside of a monolith. Service-level
// coupling (distributed monoliths, chatty calls, nanoservices) belongs to the service
// detectors; these look at package boundaries within one deployable.

import { moduleOf, terms } from '../../decompose/affinity.mjs';

const groupOf = (graph, id) => {
  const pkg = graph.in(id, 'CONTAINS').map((e) => graph.node(e.from)).find((n) => n?.type === 'package');
  if (pkg) return pkg.id;
  const p = (graph.node(id)?.path ?? id.replace(/^module:/, '')).split('/');
  return p.length > 2 ? `dir:${p.slice(0, 2).join('/')}` : `dir:${p[0]}`;
};
const label = (g) => g.replace(/^(dir|package):/, '');
const isMonolith = (graph) => graph.nodes('service').filter((s) => s.attrs.code_root || s.attrs.deployable).length < 2;

const base = (extra) => ({
  recovery: { type: 'revert' },
  blast_radius: 'moderate',
  quality_impacts: { changeability: 'high', reliability: 'medium', security: 'low' },
  verification: ['Characterization tests for the affected boundary pass before and after', 'No new dependency cycle', 'Run /unknot:decompose to re-evaluate the boundary'],
  ...extra,
});

const sharedTableWriters = {
  id: 'decomposition.shared-table-writers',
  version: '1.0.0',
  category: 'decomposition',
  kinds: ['decomposition.shared-table-writers'],
  detect({ graph, options }) {
    if (!isMonolith(graph)) return [];
    const min = options.min_groups ?? 2;
    const out = [];
    const cache = new Map();
    for (const t of graph.nodes('table')) {
      const writers = new Map();
      for (const e of [...graph.in(t.id, 'MUTATES'), ...graph.in(t.id, 'WRITES'), ...graph.in(t.id, 'OWNS_DATA')]) {
        const m = moduleOf(graph, e.from, cache);
        if (!m) continue;
        const g = groupOf(graph, m);
        if (!writers.has(g)) writers.set(g, []);
        writers.get(g).push(m);
      }
      if (writers.size < min) continue;
      const groups = [...writers.keys()].sort();
      const modules = [...new Set([...writers.values()].flat())].sort();
      out.push(base({
        kind: 'decomposition.shared-table-writers',
        title: `${t.name} is written by ${groups.length} packages (${groups.map(label).join(', ')})`,
        scope: modules.map((m) => m.slice(7)),
        key: t.id,
        evidence: [{ ref: t.id, label: 'observed', summary: `writers: ${modules.map((m) => m.slice(7)).join(', ')}`, source_ref: null }, ...modules.slice(0, 5).map((m) => ({ ref: m, label: 'observed', summary: `writes ${t.name}` }))],
        measurements: { 'table.writers': groups.length, 'boundary.shared_table_writers': groups.length },
        thresholds: { groups: min },
        why_accidental: 'Several packages writing one table means none of them owns its invariants; every change to the table is a cross-team change, and no package can be extracted or evolved alone.',
        essential_considerations: ['A shared write path can be deliberate for reference data or audit tables', 'The writes may already go through one repository function the analysis did not see'],
        smallest_simplification: `Make ownership explicit: route writes to ${t.name} through one owning package's interface (or a database view/wrapper) before any data moves.`,
        invariants: ['Every existing write still happens with the same semantics and transaction boundaries', 'Readers observe the same data'],
        risks: ['Changing write paths can split a transaction that used to be atomic', 'Hidden writers (raw SQL, scripts) may bypass the new interface'],
        factors: { benefit: 3, evidence: 0.8, reversibility: 0.8, blast: 3, cost: 3, uncertainty: 2 },
        uncertainties: ['Static analysis sees only literal SQL and ORM mappings; dynamic queries may add writers'],
        alternatives: [{ id: 'retain', summary: 'Keep shared writes if the table is append-only reference or audit data with no cross-package invariants.' }, { id: 'owning-interface', summary: 'One package owns writes; others call it.' }, { id: 'database-decomposition', summary: 'Follow the T6 data ladder when extraction is the goal.' }],
        patterns: ['database.owned-interface-for-cross-service-writes', 'decomposition.database-decomposition', 'anti-pattern.shared-database'],
      }));
    }
    return out;
  },
};

const coChangeLeak = {
  id: 'decomposition.co-change-leak',
  version: '1.0.0',
  category: 'decomposition',
  kinds: ['decomposition.co-change-leak'],
  detect({ graph, options, config }) {
    const threshold = options.threshold ?? config?.decomposition?.thresholds?.co_change_leak ?? 0.2;
    const groups = new Map();
    for (const e of graph.edges('CO_CHANGES')) {
      const ga = groupOf(graph, e.from);
      const gb = groupOf(graph, e.to);
      for (const [g, other] of [[ga, gb], [gb, ga]]) {
        if (!groups.has(g)) groups.set(g, { inside: 0, crossing: 0, partners: new Map() });
        const s = groups.get(g);
        const d = e.attrs.degree ?? 0;
        if (g === other) s.inside += d / 2;
        else {
          s.crossing += d;
          s.partners.set(other, (s.partners.get(other) ?? 0) + d);
        }
      }
    }
    const out = [];
    for (const [g, s] of groups) {
      const total = s.inside + s.crossing;
      if (total < (options.min_weight ?? 2)) continue;
      const leak = s.crossing / total;
      if (leak <= threshold) continue;
      const partners = [...s.partners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      out.push(base({
        kind: 'decomposition.co-change-leak',
        title: `${label(g)} changes together with other packages ${(leak * 100).toFixed(0)}% of the time`,
        scope: [label(g)],
        key: `co-change:${g}`,
        evidence: [{ ref: g.startsWith('package:') ? g : `module:${label(g)}`, label: 'observed', summary: `co-change partners: ${partners.map(([p, w]) => `${label(p)} (${w.toFixed(1)})`).join(', ')}`, source_ref: 'git log' }],
        measurements: { 'module.co_change_leak': +leak.toFixed(3) },
        thresholds: { co_change_leak: threshold, note: 'heuristic (spec 15A.4)' },
        why_accidental: 'When a package rarely changes alone, its boundary is not where the work happens: features cut across it, so each change needs coordinated edits and reviews.',
        essential_considerations: ['Co-change is neither good nor bad in itself; compare it with the intended architecture', 'Large mechanical commits inflate co-change (they are filtered by max_changeset)'],
        smallest_simplification: `Look at the top partner (${partners[0] ? label(partners[0][0]) : 'n/a'}): move the concept they share into one package, or record why the coupling is intended.`,
        invariants: ['Behaviour unchanged; only code location and imports move'],
        risks: ['Moving code changes import paths for consumers'],
        factors: { benefit: 3, evidence: 0.6, reversibility: 0.9, blast: 2, cost: 2, uncertainty: 3 },
        uncertainties: ['Co-change is evolutionary evidence from the history window; it does not prove a structural dependency'],
        alternatives: [{ id: 'retain', summary: 'Keep the boundary if the coupling is intended (e.g. a shared kernel) and document it.' }, { id: 'move-shared-concept', summary: 'Consolidate the shared concept into one package.' }],
        patterns: ['decomposition.modularize-in-place', 'anti-pattern.shotgun-surgery', 'domain.package-by-feature'],
      }));
    }
    return out;
  },
};

const misplacedModule = {
  id: 'decomposition.misplaced-module',
  version: '1.0.0',
  category: 'decomposition',
  kinds: ['decomposition.misplaced-module'],
  detect({ graph, options }) {
    const minRatio = options.min_ratio ?? 2;
    const minEdges = options.min_edges ?? 4;
    const out = [];
    for (const m of graph.nodes('module')) {
      if (m.attrs.is_test || m.attrs.placeholder) continue;
      const own = groupOf(graph, m.id);
      const counts = new Map();
      for (const e of [...graph.out(m.id, 'IMPORTS'), ...graph.in(m.id, 'IMPORTS')]) {
        const other = e.from === m.id ? e.to : e.from;
        if (graph.node(other)?.type !== 'module') continue;
        const g = groupOf(graph, other);
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
      const home = counts.get(own) ?? 0;
      const [best, n] = [...counts.entries()].filter(([g]) => g !== own).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      if (!best || n < minEdges || n < minRatio * Math.max(1, home)) continue;
      const vocab = new Set(terms(label(best)));
      const shares = terms(m.path ?? m.id).some((t) => vocab.has(t));
      out.push(base({
        kind: 'decomposition.misplaced-module',
        title: `${m.path ?? m.id.slice(7)} talks to ${label(best)} ${n}× but to its own package ${home}×`,
        scope: [m.path ?? m.id.slice(7)],
        key: m.id,
        evidence: [{ ref: m.id, label: 'observed', summary: `import edges: ${label(best)} ${n}, ${label(own)} ${home}`, source_ref: m.path }],
        measurements: { 'module.fan_in': graph.in(m.id, 'IMPORTS').length, 'module.fan_out': graph.out(m.id, 'IMPORTS').length },
        thresholds: { min_ratio: minRatio, min_edges: minEdges, note: 'heuristic' },
        blast_radius: 'bounded',
        why_accidental: 'A module whose dependencies are mostly in another package is living in the wrong place; its package boundary costs every change a cross-package edit.',
        essential_considerations: ['It may be a deliberate adapter or anti-corruption layer that belongs at the edge of its package', shares ? 'Its name shares vocabulary with the other package, which supports moving it' : 'Its name does not share vocabulary with the other package; check the domain fit before moving it'],
        smallest_simplification: `Move ${m.path ?? m.id.slice(7)} into ${label(best)} behind a re-export so existing importers keep working.`,
        invariants: ['Public exports unchanged (re-exported from the old path for one release)'],
        risks: ['Import paths change for consumers once the re-export is removed'],
        factors: { benefit: 2, evidence: 0.7, reversibility: 0.9, blast: 1, cost: 1, uncertainty: shares ? 2 : 3 },
        uncertainties: ['Import counts are structural evidence only; runtime and data coupling may differ'],
        alternatives: [{ id: 'retain', summary: 'Keep it where it is if it is an intentional boundary adapter.' }, { id: 'move-module', summary: 'Move it to the package it depends on.' }],
        patterns: ['decomposition.extract-module', 'domain.package-by-feature', 'anti-pattern.feature-envy'],
      }));
    }
    return out;
  },
};

const entityService = {
  id: 'decomposition.entity-service',
  version: '1.0.0',
  category: 'decomposition',
  kinds: ['decomposition.entity-service'],
  detect({ graph }) {
    // A package whose endpoints are only CRUD over one table, with almost no logic, is a
    // technical-layer split rather than a capability (Microsoft boundary guidance, 2022).
    const byGroup = new Map();
    for (const ep of graph.nodes('endpoint')) {
      const exposer = graph.in(ep.id, 'EXPOSES')[0]?.from;
      const m = exposer && moduleOf(graph, exposer);
      if (!m) continue;
      const g = groupOf(graph, m);
      if (!byGroup.has(g)) byGroup.set(g, { endpoints: [], modules: new Set() });
      byGroup.get(g).endpoints.push(ep);
      byGroup.get(g).modules.add(m);
    }
    const out = [];
    for (const [g, v] of byGroup) {
      if (v.endpoints.length < 3) continue;
      const methods = new Set(v.endpoints.map((e) => e.id.split(' ')[0].slice(9)));
      const crud = [...methods].every((x) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(x));
      const tables = new Set();
      let cyclo = 0;
      let fns = 0;
      for (const m of v.modules) {
        for (const e of graph.out(m, ['MUTATES', 'QUERIES', 'OWNS_DATA'])) tables.add(e.to);
        for (const c of graph.children(m)) if (c.attrs.cyclomatic != null) {
          cyclo += c.attrs.cyclomatic;
          fns++;
        }
      }
      if (!crud || tables.size !== 1 || !fns || cyclo / fns > 2) continue;
      out.push(base({
        kind: 'decomposition.entity-service',
        title: `${label(g)} is CRUD over ${[...tables][0].slice(6)} with little behaviour (avg cyclomatic ${(cyclo / fns).toFixed(1)})`,
        scope: [...v.modules].map((m) => m.slice(7)),
        key: `entity:${g}`,
        evidence: [{ ref: [...v.modules][0], label: 'inferred', summary: `${v.endpoints.length} endpoints, ${tables.size} table, ${fns} functions` }],
        measurements: { 'boundary.interface_count': v.endpoints.length },
        thresholds: { max_avg_cyclomatic: 2, note: 'heuristic' },
        why_accidental: 'A boundary drawn around one entity rather than a business capability pushes the behaviour into its callers and makes every feature a multi-boundary change.',
        essential_considerations: ['A thin data-access facade can be intended as a stable public API'],
        smallest_simplification: `Do not extract or expand this boundary; consider merging it into the capability that owns the behaviour around ${[...tables][0].slice(6)}.`,
        invariants: ['Endpoint contracts unchanged'],
        risks: ['Merging boundaries changes ownership; agree it with the owners first'],
        factors: { benefit: 2, evidence: 0.5, reversibility: 0.7, blast: 3, cost: 3, uncertainty: 3 },
        uncertainties: ['Classification uses endpoint method names, table access and average complexity only'],
        alternatives: [{ id: 'retain', summary: 'Keep it as a deliberate data API.' }, { id: 'merge-into-capability', summary: 'Fold it into the owning capability.' }],
        patterns: ['domain.bounded-context', 'domain.aggregate', 'anti-pattern.nanoservices'],
      }));
    }
    return out;
  },
};

const crossBoundaryTransaction = {
  id: 'decomposition.cross-boundary-transaction',
  version: '1.0.0',
  category: 'decomposition',
  kinds: ['decomposition.cross-boundary-transaction'],
  detect({ graph }) {
    const out = [];
    const cache = new Map();
    const owner = (t) => {
      const w = [...graph.in(t, 'MUTATES'), ...graph.in(t, 'OWNS_DATA')].map((e) => moduleOf(graph, e.from, cache)).filter(Boolean)[0];
      return w ? groupOf(graph, w) : null;
    };
    for (const e of graph.edges('SHARES_TRANSACTION_WITH')) {
      const a = owner(e.from);
      const b = owner(e.to);
      if (!a || !b || a === b) continue;
      out.push(base({
        kind: 'decomposition.cross-boundary-transaction',
        title: `One transaction spans ${e.from.slice(6)} (${label(a)}) and ${e.to.slice(6)} (${label(b)})`,
        scope: [label(a), label(b)],
        key: e.id,
        evidence: [{ ref: e.from, label: 'observed', summary: `shares a transaction with ${e.to}` }],
        measurements: { 'boundary.cross_transactions': 1 },
        thresholds: {},
        blast_radius: 'high',
        why_accidental: 'Atomicity across two packages ties them together: neither can move to its own data store without a saga, an outbox or a merge.',
        essential_considerations: ['Strong consistency may be a real requirement; then the two belong together'],
        smallest_simplification: 'Record whether this atomicity is required. If it is, keep both in one boundary; if not, design an outbox/saga before any extraction.',
        invariants: ['The combined write remains atomic until an explicit consistency design replaces it'],
        risks: ['Splitting the transaction without compensation loses data consistency'],
        factors: { benefit: 2, evidence: 0.8, reversibility: 0.5, blast: 4, cost: 4, uncertainty: 3 },
        uncertainties: [],
        alternatives: [{ id: 'retain', summary: 'Keep both in one boundary because consistency requires it.' }, { id: 'saga-or-outbox', summary: 'Introduce an explicit eventual-consistency design first.' }],
        patterns: ['distributed.transactional-outbox', 'distributed.saga-orchestration', 'decomposition.retain'],
      }));
    }
    return out;
  },
};

export default [sharedTableWriters, coChangeLeak, misplacedModule, entityService, crossBoundaryTransaction];
