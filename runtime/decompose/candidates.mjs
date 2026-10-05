// Candidate boundaries and their metrics (spec §15A.3–15A.4). Leiden proposes; a
// resolution sweep, label propagation and weight perturbation decide how robust each
// proposal is. Metrics are relative to this repository and carry what was not measured.

import { clusterMetrics, modularity, robustness } from '../graph/community.mjs';
import { cycleBreakdown, stronglyConnected } from '../graph/algorithms.mjs';
import { moduleOf } from './affinity.mjs';
import { maxOf, minOf } from '../core/arrays.mjs';
import { foldReason, foldSiblings } from './fold.mjs';

/**
 * @returns {{candidates: object[], modularity: number, stats: object}}
 */
export function findCandidates(graph, affinity, { sizeBand = [5, 20], robustness: threshold = 0.9, seed = 42, eligible = [] } = {}) {
  const input = { nodes: affinity.nodes, edges: affinity.edges.map(({ a, b, w }) => ({ a, b, w })) };
  const rob = robustness(input, { seed });
  const partition = rob.baseline;
  const cm = clusterMetrics(input, partition, { sizeBand });
  const stability = new Map();
  for (const c of rob.communities) for (const m of c.members) stability.set(m, c.stability);
  const cache = new Map();
  const tableOwners = ownersOfTables(graph, cache);
  const sccs = stronglyConnected(graph, { edgeTypes: ['IMPORTS'] });
  const clusters = cm.clusters.filter((cl) => cl.size >= 2);
  const folds = foldSiblings(graph, clusters.map((cl) => cl.members), eligible);
  const candidates = clusters
    .map((cl, i) => {
      const folded = folds.get(i) ?? [];
      const all = [...cl.members, ...folded.map((f) => f.module)].sort();
      const members = new Set(all);
      const stab = minOf(cl.members.map((m) => stability.get(m) ?? 0));
      const touching = cl.internal + cl.external;
      const named = describeName(cl.members, graph);
      const metrics = boundaryMetrics(graph, members, { cache, tableOwners, sccs, candidateOf: (m) => (partition.has(m) ? partition.get(m) : null), self: partition.get(cl.members[0]) });
      // Share of the affinity weight touching the candidate that stays inside, and that leaves it.
      metrics.metrics['boundary.cohesion'] = +cl.cohesion.toFixed(3);
      if (touching > 0) metrics.metrics['boundary.coupling'] = +(cl.external / touching).toFixed(3);
      metrics.metrics['boundary.stability'] = +stab.toFixed(3);
      return {
        id: `C-${i + 1}`,
        modules: all,
        size: all.length,
        ...(folded.length ? { folded: folded.map((f) => ({ module: f.module, reason: foldReason(f) })) } : {}),
        clustered: cl.members,
        size_flag: cl.sizeFlag,
        cohesion: +cl.cohesion.toFixed(3),
        stability: +stab.toFixed(3),
        robust: stab >= threshold,
        metrics: { ...metrics.metrics, gaps: metrics.gaps },
        details: metrics.details,
        name: named.name,
        name_basis: named.basis,
      };
    });
  return {
    candidates,
    modularity: +modularity(input, partition).toFixed(4),
    coupling: cm.coupling.filter((c) => c.coupling > 0).sort((x, y) => y.coupling - x.coupling).slice(0, 50),
    stats: rob.stats,
    partition,
  };
}

/** Fan-in of a module: modules importing it. */
const fanIn = (graph, id) => new Set(graph.in(id, 'IMPORTS').map((e) => e.from)).size;

/** Up to `n` members by fan-in (then path), as repository paths. */
export function topFiles(graph, modules, n = 5) {
  return modules.map((m) => ({ path: m.replace(/^module:/, ''), fan: graph ? fanIn(graph, m) : 0 }))
    .sort((a, b) => b.fan - a.fan || a.path.localeCompare(b.path)).slice(0, n).map((x) => x.path);
}

const namespaceOf = (graph, id) => {
  const a = graph?.node(id)?.attrs ?? {};
  return [a.namespace, a.package].find((v) => typeof v === 'string' && v) ?? null;
};

/**
 * Name a candidate: the longest namespace prefix shared by at least half of its members;
 * otherwise the dominant directory below their common directory prefix.
 * @returns {{name: string, basis: 'namespace'|'directory'}}
 */
export function describeName(modules, graph = null) {
  const counts = new Map();
  for (const m of modules) {
    const ns = namespaceOf(graph, m);
    if (!ns) continue;
    const seg = ns.split('.');
    for (let i = 1; i <= seg.length; i++) {
      const pre = seg.slice(0, i).join('.');
      counts.set(pre, (counts.get(pre) ?? 0) + 1);
    }
  }
  const shared = [...counts].filter(([, c]) => c * 2 >= modules.length);
  if (shared.length) {
    shared.sort((a, b) => b[0].split('.').length - a[0].split('.').length || b[1] - a[1] || a[0].localeCompare(b[0]));
    return { name: shared[0][0], basis: 'namespace' };
  }
  const parts = modules.map((m) => m.replace(/^module:/, '').split('/').slice(0, -1));
  let prefix = parts[0] ?? [];
  for (const p of parts) {
    let i = 0;
    while (i < prefix.length && prefix[i] === p[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const below = new Map();
  for (const p of parts) {
    const k = p[prefix.length];
    if (k !== undefined) below.set(k, (below.get(k) ?? 0) + 1);
  }
  const top = [...below].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return { name: [...prefix, ...(top ? [top] : [])].join('/') || '.', basis: 'directory' };
}

/** Kept for callers that name a module list without a graph. */
export const nameFor = (modules, graph = null) => describeName(modules, graph).name;

/** Names unique within a run: a shared name gets the candidate's hub file appended. */
export function disambiguate(candidates) {
  const byName = new Map();
  for (const c of candidates) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  const used = new Set();
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    for (const c of list) c.name = `${name} (hub ${(c.top_files?.[0] ?? c.modules[0]).split('/').pop()})`;
  }
  for (const c of candidates) {
    let n = c.name;
    for (let i = 2; used.has(n); i++) n = `${c.name} #${i}`;
    c.name = n;
    used.add(n);
  }
  return candidates;
}

function ownersOfTables(graph, cache) {
  // table → Map(module → 'w'|'r')
  const owners = new Map();
  for (const type of ['MUTATES', 'WRITES', 'OWNS_DATA', 'QUERIES', 'READS']) {
    for (const e of graph.edges(type)) {
      const m = moduleOf(graph, e.from, cache);
      if (!m) continue;
      let t = owners.get(e.to);
      if (!t) owners.set(e.to, (t = new Map()));
      const write = type !== 'QUERIES' && type !== 'READS';
      if (write || !t.has(m)) t.set(m, write ? 'w' : 'r');
    }
  }
  return owners;
}

/**
 * Spec §15A.4 metrics for one candidate. Unmeasurable metrics are omitted and listed in
 * `gaps`, so the pattern engine reports them as insufficient evidence.
 */
export function boundaryMetrics(graph, members, { cache = new Map(), tableOwners, sccs, candidateOf, self }) {
  const m = {};
  const gaps = [];
  // `details` carries the ids each metric was measured on, for the record's evidence.
  const details = {};
  // IFN: members used from outside; reverse deps: imports from members into the rest.
  // An import resolved only by namespace (or marked low confidence) is a guess, so it is
  // not counted; imports into test modules are counted apart.
  const ifn = new Set();
  let internalImports = 0;
  let lowReverse = 0;
  const reverseEdges = [];
  const reverseTest = [];
  const reverseTargets = new Map();
  for (const id of members) {
    for (const e of graph.in(id, 'IMPORTS')) if (!members.has(e.from) && graph.node(e.from)?.type === 'module') ifn.add(id);
    for (const e of graph.out(id, 'IMPORTS')) {
      const t = graph.node(e.to);
      if (t?.type !== 'module') continue;
      if (members.has(e.to)) internalImports++;
      else if (e.attrs?.via === 'namespace' || e.attrs?.confidence === 'low' || e.attrs?.low) lowReverse++;
      else if (t.attrs?.is_test) reverseTest.push(e.id);
      else {
        reverseEdges.push(e.id);
        reverseTargets.set(e.to, (reverseTargets.get(e.to) ?? 0) + 1);
      }
    }
  }
  m['boundary.interface_count'] = ifn.size;
  m['boundary.reverse_deps'] = reverseEdges.length;
  m['boundary.reverse_deps_test'] = reverseTest.length;
  if (lowReverse) {
    m['boundary.reverse_deps_low_confidence'] = lowReverse;
    gaps.push(`${lowReverse} import(s) from the candidate into the rest were resolved only by namespace (low confidence) and are not counted in reverse_deps`);
  }
  details.reverse_targets = [...reverseTargets].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([module, edges]) => ({ module, edges }));
  details.evidence = {
    'boundary.reverse_deps': reverseEdges,
    'boundary.interface_count': [...ifn].sort(),
  };
  m['boundary.size'] = members.size;
  // SW and CBJ from table ownership: a table is owned by whoever writes it most.
  let shared = 0;
  const sharedTables = [];
  const ownedHere = new Set();
  let anyTables = false;
  for (const [table, users] of tableOwners) {
    const writers = [...users].filter(([, k]) => k === 'w').map(([mod]) => mod);
    if (!writers.length) continue;
    anyTables = true;
    const here = writers.some((w) => members.has(w));
    const elsewhere = writers.some((w) => !members.has(w));
    if (here && elsewhere) {
      shared++;
      sharedTables.push(table);
    }
    const counts = new Map();
    for (const w of writers) {
      const c = members.has(w) ? self : candidateOf(w);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[0] === self) ownedHere.add(table);
  }
  if (anyTables) {
    m['boundary.shared_table_writers'] = shared;
    details.evidence['boundary.shared_table_writers'] = sharedTables;
    let cbj = 0;
    for (const t of ownedHere) for (const e of [...graph.out(t, 'JOINS_WITH'), ...graph.in(t, 'JOINS_WITH')]) if (!ownedHere.has(e.from === t ? e.to : e.from)) cbj++;
    m['boundary.cross_joins'] = cbj;
  } else gaps.push('no table access facts: shared_table_writers and cross_joins unknown');
  // CBT: transactions spanning tables owned by different candidates (needs transaction facts).
  const tx = graph.edges('SHARES_TRANSACTION_WITH');
  if (tx.length) m['boundary.cross_transactions'] = tx.filter((e) => ownedHere.has(e.from) !== ownedHere.has(e.to)).length;
  else gaps.push('no transaction-boundary facts: cross_transactions unknown');
  // CCL: share of co-change weight that crosses the boundary.
  let inside = 0;
  let crossing = 0;
  const leaks = [];
  for (const id of members) {
    for (const e of [...graph.out(id, 'CO_CHANGES'), ...graph.in(id, 'CO_CHANGES')]) {
      const other = e.from === id ? e.to : e.from;
      if (members.has(other)) inside += e.attrs.degree ?? 0;
      else {
        crossing += e.attrs.degree ?? 0;
        leaks.push(e.id);
      }
    }
  }
  details.evidence['module.co_change_leak'] = leaks;
  if (inside + crossing > 0) m['module.co_change_leak'] = +(crossing / (inside + crossing)).toFixed(3);
  else gaps.push('no co-change history in the window: co_change_leak unknown');
  // OA: largest single-owner share.
  const owners = new Map();
  let owned = 0;
  for (const id of members) {
    const o = graph.out(id, 'OWNED_BY')[0]?.to;
    if (o) {
      owners.set(o, (owners.get(o) ?? 0) + 1);
      owned++;
    }
  }
  if (owned) {
    const ranked = [...owners].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = ranked[0][0];
    // Who the owners are and what share each holds, so owners.count reads with alignment.
    details.owners = ranked.slice(0, 10).map(([o, n]) => ({ owner: graph.node(o)?.name ?? o, modules: n, share: +(n / members.size).toFixed(3) }));
    if (owned < members.size) details.unowned = members.size - owned;
    details.evidence['ownership.alignment'] = [...members].filter((id) => graph.out(id, 'OWNED_BY')[0]?.to === top).sort();
    m['ownership.alignment'] = +(maxOf(owners.values()) / members.size).toFixed(3);
    m['owners.count'] = owners.size;
  } else gaps.push('no ownership facts (CODEOWNERS/catalog): ownership alignment unknown');
  // Requests interceptable: the candidate exposes routable entry points.
  // The seam may also be inbound runtime evidence: a traced service or endpoint whose code
  // root maps into the candidate shows that requests reach it.
  const seams = [];
  for (const id of members) {
    for (const e of graph.out(id, 'EXPOSES')) seams.push(e.id);
    for (const c of graph.children(id)) for (const e of graph.out(c.id, 'EXPOSES')) seams.push(e.id);
  }
  const memberPaths = [...members].map((id) => graph.node(id)?.path ?? id.slice(7));
  const traced = (n) => n.attrs?.span_count > 0 || n.attrs?.calls > 0 || n.attrs?.request_count > 0 || graph.in(n.id, 'RUNTIME_CALLS').length > 0;
  for (const n of [...graph.nodes('service'), ...graph.nodes('endpoint')]) {
    const root = typeof n.attrs?.code_root === 'string' ? n.attrs.code_root.replace(/^\.\//, '').replace(/\/$/, '') : '';
    if (root && root !== '.' && traced(n) && memberPaths.some((p) => p.startsWith(`${root}/`))) seams.push(n.id);
  }
  m['requests.interceptable'] = seams.length > 0 ? 1 : 0;
  details.evidence['requests.interceptable'] = seams;
  if (!seams.length) gaps.push('no routable seam (HTTP route or queue entry) visible in this repository: a caller in another repository or a gateway would show an existing seam; import its traces (evidence.traces) or a catalog that names the endpoints (evidence.catalogs)');
  // Cycles touching the candidate.
  let tests = 0;
  const testEdges = [];
  for (const id of members) {
    tests += graph.in(id, 'TESTS').length;
    for (const e of graph.in(id, 'TESTS')) testEdges.push(e.id);
  }
  details.evidence['tests.present'] = testEdges;
  m['tests.present'] = tests;
  m['boundary.internal_imports'] = internalImports;
  // A cycle that crosses the boundary blocks extraction; one wholly inside it does not
  // (it is the candidate's own problem, reported separately).
  const touching = (sccs ?? stronglyConnected(graph, { edgeTypes: ['IMPORTS'] })).filter((c) => c.some((x) => members.has(x)));
  const crossingCycles = touching.filter((c) => c.some((x) => !members.has(x)));
  m['cycle.size'] = crossingCycles.length ? Math.max(...crossingCycles.map((c) => c.length)) : 0;
  const worst = crossingCycles.slice().sort((a, b) => b.length - a.length)[0] ?? [];
  const inCycle = new Set(worst);
  const closing = worst.flatMap((x) => graph.out(x, 'IMPORTS').filter((e) => inCycle.has(e.to) && members.has(x) !== members.has(e.to)).map((e) => e.id));
  details.evidence['cycle.size'] = [...worst, ...closing];
  // `cycle.size` counts only cycles that cross the boundary; the cycle wholly inside it is
  // `boundary.internal_cycle_size`. `cycle.crossing_size` names the first so neither reads as "the cycle".
  m['cycle.crossing_size'] = m['cycle.size'];
  const wholly = touching.filter((c) => c.every((x) => members.has(x))).sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
  m['boundary.internal_cycle_size'] = wholly.length ? wholly[0].length : 0;
  if (wholly.length) {
    const b = cycleBreakdown(graph, wholly[0], { edgeTypes: ['IMPORTS'], maxCycles: 20 });
    details.cycle_detail = { scope: 'internal', size: wholly[0].length, members: b.members, cycles: b.cycles.map((c) => c.nodes), cycles_truncated: b.truncated, cut: b.cut, declared_only: b.cut.filter((e) => e.declared_only).length };
  }
  // Consumers, contracts, per-unit CI and chattiness (spec §15A.4 and the card vocabulary).
  const consumers = new Set();
  let contracts = 0;
  let endpointsTotal = 0;
  for (const id of members) {
    for (const e of graph.in(id, 'IMPORTS')) if (!members.has(e.from) && graph.node(e.from)?.type === 'module') consumers.add(e.from);
    const eps = [...graph.out(id, 'EXPOSES'), ...graph.children(id).flatMap((c) => graph.out(c.id, 'EXPOSES'))];
    endpointsTotal += eps.length;
    contracts += eps.filter((e) => graph.node(e.to)?.attrs?.contract).length;
  }
  m['module.consumers'] = consumers.size;
  details.evidence['module.consumers'] = [...consumers].sort();
  if (endpointsTotal) m['contracts.present'] = contracts > 0 ? 1 : 0;
  const dirs = [...new Set([...members].map((id) => (graph.node(id)?.path ?? id.slice(7)).split('/').slice(0, -1).join('/')))];
  const common = dirs.reduce((a, b) => {
    const x = a.split('/');
    const y = b.split('/');
    let i = 0;
    while (i < x.length && x[i] === y[i]) i++;
    return x.slice(0, i).join('/');
  }, dirs[0] ?? '');
  const workflows = graph.nodes('workflow');
  if (workflows.length) {
    m['ci.per_unit_pipeline'] = common && workflows.some((w) => (w.attrs?.paths ?? w.attrs?.path_filters ?? []).length && (w.attrs.paths ?? w.attrs.path_filters).every((p) => String(p).startsWith(common))) ? 1 : 0;
  }
  const services = graph.nodes('service').filter((sv) => sv.attrs?.code_root && common && (sv.attrs.code_root.startsWith(common) || common.startsWith(sv.attrs.code_root)));
  const perRequest = services.flatMap((sv) => graph.out(sv.id, 'RUNTIME_CALLS').map((e) => e.attrs.per_request_p95 ?? 0));
  if (perRequest.length) m['boundary.calls_per_request_p95'] = Math.max(...perRequest);
  else if (!graph.edges('RUNTIME_CALLS').length) gaps.push('no runtime traces: chattiness (calls per request) unknown');
  return { metrics: m, gaps, details };
}
