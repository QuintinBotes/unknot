// Candidate boundaries and their metrics (spec §15A.3–15A.4). Leiden proposes; a
// resolution sweep, label propagation and weight perturbation decide how robust each
// proposal is. Metrics are relative to this repository and carry what was not measured.

import { clusterMetrics, modularity, robustness } from '../graph/community.mjs';
import { stronglyConnected } from '../graph/algorithms.mjs';
import { moduleOf } from './affinity.mjs';

/**
 * @returns {{candidates: object[], modularity: number, stats: object}}
 */
export function findCandidates(graph, affinity, { sizeBand = [5, 20], robustness: threshold = 0.9, seed = 42 } = {}) {
  const input = { nodes: affinity.nodes, edges: affinity.edges.map(({ a, b, w }) => ({ a, b, w })) };
  const rob = robustness(input, { seed });
  const partition = rob.baseline;
  const cm = clusterMetrics(input, partition, { sizeBand });
  const stability = new Map();
  for (const c of rob.communities) for (const m of c.members) stability.set(m, c.stability);
  const cache = new Map();
  const tableOwners = ownersOfTables(graph, cache);
  const sccs = stronglyConnected(graph, { edgeTypes: ['IMPORTS'] });
  const candidates = cm.clusters
    .filter((cl) => cl.size >= 2)
    .map((cl, i) => {
      const members = new Set(cl.members);
      const stab = Math.min(...cl.members.map((m) => stability.get(m) ?? 0));
      return {
        id: `C-${i + 1}`,
        modules: cl.members,
        size: cl.size,
        size_flag: cl.sizeFlag,
        cohesion: +cl.cohesion.toFixed(3),
        stability: +stab.toFixed(3),
        robust: stab >= threshold,
        metrics: boundaryMetrics(graph, members, { cache, tableOwners, sccs, candidateOf: (m) => (partition.has(m) ? partition.get(m) : null), self: partition.get(cl.members[0]) }),
        name: nameFor(cl.members),
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

/** Name a candidate after its longest common directory prefix (or most common dir). */
export function nameFor(modules) {
  const parts = modules.map((m) => m.replace(/^module:/, '').split('/').slice(0, -1));
  let prefix = parts[0] ?? [];
  for (const p of parts) {
    let i = 0;
    while (i < prefix.length && prefix[i] === p[i]) i++;
    prefix = prefix.slice(0, i);
  }
  if (prefix.length) return prefix.join('/');
  const counts = new Map();
  for (const p of parts) {
    const k = p.slice(0, 2).join('/') || '.';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '.';
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
  // IFN: members used from outside; reverse deps: imports from members into the rest.
  const ifn = new Set();
  let reverse = 0;
  let internalImports = 0;
  for (const id of members) {
    for (const e of graph.in(id, 'IMPORTS')) if (!members.has(e.from) && graph.node(e.from)?.type === 'module') ifn.add(id);
    for (const e of graph.out(id, 'IMPORTS')) {
      const t = graph.node(e.to);
      if (t?.type !== 'module') continue;
      if (members.has(e.to)) internalImports++;
      else reverse++;
    }
  }
  m['boundary.interface_count'] = ifn.size;
  m['boundary.reverse_deps'] = reverse;
  m['boundary.size'] = members.size;
  // SW and CBJ from table ownership: a table is owned by whoever writes it most.
  let shared = 0;
  const ownedHere = new Set();
  let anyTables = false;
  for (const [table, users] of tableOwners) {
    const writers = [...users].filter(([, k]) => k === 'w').map(([mod]) => mod);
    if (!writers.length) continue;
    anyTables = true;
    const here = writers.some((w) => members.has(w));
    const elsewhere = writers.some((w) => !members.has(w));
    if (here && elsewhere) shared++;
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
  for (const id of members) {
    for (const e of [...graph.out(id, 'CO_CHANGES'), ...graph.in(id, 'CO_CHANGES')]) {
      const other = e.from === id ? e.to : e.from;
      if (members.has(other)) inside += e.attrs.degree ?? 0;
      else crossing += e.attrs.degree ?? 0;
    }
  }
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
    m['ownership.alignment'] = +(Math.max(...owners.values()) / members.size).toFixed(3);
    m['owners.count'] = owners.size;
  } else gaps.push('no ownership facts (CODEOWNERS/catalog): ownership alignment unknown');
  // Requests interceptable: the candidate exposes routable entry points.
  let endpoints = 0;
  for (const id of members) {
    endpoints += graph.out(id, 'EXPOSES').length;
    for (const c of graph.children(id)) endpoints += graph.out(c.id, 'EXPOSES').length;
  }
  m['requests.interceptable'] = endpoints > 0 ? 1 : 0;
  // Cycles touching the candidate.
  let tests = 0;
  for (const id of members) tests += graph.in(id, 'TESTS').length;
  m['tests.present'] = tests;
  m['boundary.internal_imports'] = internalImports;
  // A cycle that crosses the boundary blocks extraction; one wholly inside it does not
  // (it is the candidate's own problem, reported separately).
  const touching = (sccs ?? stronglyConnected(graph, { edgeTypes: ['IMPORTS'] })).filter((c) => c.some((x) => members.has(x)));
  const crossingCycles = touching.filter((c) => c.some((x) => !members.has(x)));
  m['cycle.size'] = crossingCycles.length ? Math.max(...crossingCycles.map((c) => c.length)) : 0;
  m['boundary.internal_cycle_size'] = touching.length ? Math.max(...touching.filter((c) => c.every((x) => members.has(x))).map((c) => c.length), 0) : 0;
  if (!graph.edges('RUNTIME_CALLS').length) gaps.push('no runtime traces: chattiness (calls per request) unknown');
  return { ...m, gaps };
}
