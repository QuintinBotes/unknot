// The composite affinity graph (spec §15A.3):
//   w(a,b) = α·S(a,b) + β·D(a,b) + γ·E(a,b) + δ·M(a,b)
// over source modules. Each component is normalised to [0, 1] before weighting, so the
// weights mean what they say. The default weights are heuristics and are reported as such.

const STOP = new Set(['src', 'lib', 'app', 'apps', 'packages', 'internal', 'pkg', 'cmd', 'main', 'index', 'utils', 'util', 'common', 'shared', 'core', 'helpers', 'helper', 'base', 'impl', 'types', 'type', 'model', 'models', 'service', 'services', 'controller', 'controllers', 'handler', 'handlers', 'module', 'modules', 'test', 'tests', 'spec', 'js', 'ts', 'tsx', 'jsx', 'py', 'go', 'java', 'kt', 'rb', 'cs', 'rs', 'php', 'mjs', 'cjs', 'default', 'get', 'set', 'new', 'init']);

export function terms(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));
}

const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** The module a node belongs to (functions/methods/classes roll up through CONTAINS). */
export function moduleOf(graph, id, cache = new Map()) {
  if (cache.has(id)) return cache.get(id);
  let cur = graph.node(id);
  let guard = 0;
  while (cur && cur.type !== 'module' && guard++ < 8) cur = graph.parent(cur.id);
  const out = cur?.type === 'module' ? cur.id : null;
  cache.set(id, out);
  return out;
}

/**
 * @param {import('../graph/graph.mjs').Graph} graph
 * @param {{modules: string[], weights: object}} opts
 * @returns {{nodes: string[], edges: {a, b, w, parts}[], components: object, weights: object}}
 */
export function buildAffinity(graph, { modules, weights }) {
  const set = new Set(modules);
  const cache = new Map();
  const comp = { S: new Map(), D: new Map(), E: new Map(), M: new Map() };
  const add = (m, a, b, w) => {
    if (a === b || !set.has(a) || !set.has(b)) return;
    const k = pairKey(a, b);
    m.set(k, (m.get(k) ?? 0) + w);
  };
  // S: imports between modules, and calls rolled up to their modules.
  for (const e of graph.edges('IMPORTS')) add(comp.S, e.from, e.to, Math.max(1, e.attrs.names?.length ?? 1));
  for (const e of graph.edges('CALLS')) add(comp.S, moduleOf(graph, e.from, cache), moduleOf(graph, e.to, cache), 1);
  // D: shared tables, writes weighted above reads.
  const touch = new Map();
  for (const type of ['QUERIES', 'MUTATES', 'OWNS_DATA', 'READS', 'WRITES']) {
    for (const e of graph.edges(type)) {
      const m = moduleOf(graph, e.from, cache);
      if (!m || !set.has(m)) continue;
      const w = type === 'QUERIES' || type === 'READS' ? 0.5 : 1;
      let t = touch.get(e.to);
      if (!t) touch.set(e.to, (t = new Map()));
      t.set(m, Math.max(t.get(m) ?? 0, w));
    }
  }
  for (const users of touch.values()) {
    const list = [...users.entries()];
    if (list.length > 40) continue; // a table everything touches is a hub, not affinity
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) add(comp.D, list[i][0], list[j][0], list[i][1] * list[j][1]);
  }
  // E: co-change degree (already filtered for changeset size and minimum shared commits).
  for (const e of graph.edges('CO_CHANGES')) add(comp.E, e.from, e.to, e.attrs.degree ?? 0);
  // M: domain-term overlap, only for pairs that are already related or share a directory,
  // so this stays linear-ish instead of quadratic in the module count.
  const termCache = new Map();
  const termsOf = (id) => {
    if (!termCache.has(id)) {
      const n = graph.node(id);
      const names = (n?.attrs?.exports ?? []).map((x) => x.name ?? x).join(' ');
      termCache.set(id, new Set(terms(`${(n?.path ?? id.slice(7)).replace(/\.[a-z]+$/, '')} ${names}`)));
    }
    return termCache.get(id);
  };
  const related = new Set([...comp.S.keys(), ...comp.D.keys(), ...comp.E.keys()]);
  const byDir = new Map();
  for (const m of modules) {
    const dir = m.slice(7).split('/').slice(0, -1).join('/');
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(m);
  }
  for (const list of byDir.values()) if (list.length <= 60) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) related.add(pairKey(list[i], list[j]));
  for (const k of related) {
    const [a, b] = k.split('\u0000');
    const ta = termsOf(a);
    const tb = termsOf(b);
    if (!ta.size || !tb.size) continue;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    const j = inter / (ta.size + tb.size - inter);
    if (j > 0) comp.M.set(k, j);
  }
  const norm = (m) => {
    let max = 0;
    for (const v of m.values()) max = Math.max(max, v);
    return max ? new Map([...m].map(([k, v]) => [k, v / max])) : m;
  };
  const N = { S: norm(comp.S), D: norm(comp.D), E: norm(comp.E), M: norm(comp.M) };
  const w = { S: weights.structural, D: weights.data, E: weights.evolutionary, M: weights.semantic };
  const keys = new Set([...N.S.keys(), ...N.D.keys(), ...N.E.keys(), ...N.M.keys()]);
  const edges = [];
  for (const k of [...keys].sort()) {
    const parts = { S: N.S.get(k) ?? 0, D: N.D.get(k) ?? 0, E: N.E.get(k) ?? 0, M: N.M.get(k) ?? 0 };
    const total = w.S * parts.S + w.D * parts.D + w.E * parts.E + w.M * parts.M;
    if (total <= 0) continue;
    const [a, b] = k.split('\u0000');
    edges.push({ a, b, w: +total.toFixed(6), parts });
  }
  return {
    nodes: [...modules].sort(),
    edges,
    components: { structural: comp.S.size, data: comp.D.size, evolutionary: comp.E.size, semantic: comp.M.size },
    weights: { ...weights, heuristic: true },
  };
}
