// Frontend structure for decomposition (spec §15A.10). Unknot proposes only vertical
// (route/domain) splits by default; a horizontal fragment split needs an explicit owner
// per fragment, which this module reports as missing rather than inventing.

const FSD_LAYERS = ['app', 'processes', 'pages', 'widgets', 'features', 'entities', 'shared'];
const FRONTEND_EXT = /\.(jsx|tsx|vue|svelte)$/;
const FRONTEND_DIR = /(^|\/)(components|pages|views|screens|features|widgets|entities|routes|ui|frontend|web|client|app)\//;

export function isFrontendModule(graph, node) {
  if (node.type !== 'module' || node.attrs.is_test) return false;
  const path = node.path ?? node.id.slice(7);
  if (FRONTEND_EXT.test(path)) return true;
  if (graph.in(node.id, 'RENDERS').length) return true;
  return ['javascript', 'typescript'].includes(node.attrs.language) && FRONTEND_DIR.test(path) && !/(^|\/)(server|api|backend)\//.test(path);
}

/** FSD layer and slice of a path, or null when the project does not use FSD names. */
export function fsdOf(path) {
  const segs = path.split('/');
  const i = segs.findIndex((s) => FSD_LAYERS.includes(s));
  if (i === -1) return null;
  return { layer: segs[i], rank: FSD_LAYERS.indexOf(segs[i]), slice: ['app', 'shared'].includes(segs[i]) ? null : segs[i + 1] ?? null };
}

/** Feature folder of a path: FSD slice, else `features|modules|domains/<x>`, else null. */
export function featureOf(path) {
  const f = fsdOf(path);
  if (f?.slice) return `${f.layer}/${f.slice}`;
  const m = /(?:^|\/)(features|modules|domains|feature)\/([^/]+)\//.exec(path);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Route groups, closures and the frontend signals of the vocabulary.
 * @returns {{modules: string[], groups: object[], signals: object, violations: object[], gaps: string[]}}
 */
export function analyzeFrontend(graph, { scopeFilter = () => true } = {}) {
  const modules = graph.nodes('module').filter((n) => isFrontendModule(graph, n) && scopeFilter(n)).map((n) => n.id);
  const set = new Set(modules);
  const gaps = [];
  // Feature imports and FSD layer violations.
  const violations = [];
  let crossFeature = 0;
  for (const id of modules) {
    const from = graph.node(id).path ?? id.slice(7);
    for (const e of graph.out(id, 'IMPORTS')) {
      if (!set.has(e.to)) continue;
      const to = graph.node(e.to).path ?? e.to.slice(7);
      const fa = featureOf(from);
      const fb = featureOf(to);
      if (fa && fb && fa !== fb) {
        crossFeature++;
        const la = fsdOf(from);
        const lb = fsdOf(to);
        if (la && lb && la.rank === lb.rank) violations.push({ kind: 'same-layer-cross-slice', from, to });
      }
      const la = fsdOf(from);
      const lb = fsdOf(to);
      if (la && lb && lb.rank < la.rank) violations.push({ kind: 'upward-layer-import', from, to, from_layer: la.layer, to_layer: lb.layer });
    }
  }
  // Route closures: modules reachable from each route's rendered module.
  const routes = graph.nodes('route');
  const closures = new Map();
  for (const r of routes) {
    const seen = new Set();
    const queue = graph.out(r.id, 'RENDERS').map((e) => [e.to, 0]);
    while (queue.length) {
      const [id, d] = queue.shift();
      if (seen.has(id) || !set.has(id) || d > 6) continue;
      seen.add(id);
      for (const e of graph.out(id, 'IMPORTS')) queue.push([e.to, d + 1]);
    }
    closures.set(r.id, seen);
  }
  const usage = new Map();
  for (const c of closures.values()) for (const m of c) usage.set(m, (usage.get(m) ?? 0) + 1);
  const sharedCut = Math.max(2, Math.ceil(routes.length / 2));
  const shared = new Set([...usage].filter(([, n]) => n >= sharedCut).map(([m]) => m));
  // Vertical groups: routes by their first path segment.
  const groups = new Map();
  for (const r of routes) {
    const seg = (r.name ?? r.id.slice(6)).replace(/^\//, '').split('/')[0] || '(root)';
    if (!groups.has(seg)) groups.set(seg, { name: seg, routes: [], modules: new Set() });
    const g = groups.get(seg);
    g.routes.push(r.id);
    for (const m of closures.get(r.id)) if (!shared.has(m)) g.modules.add(m);
  }
  const stores = graph.nodes('store');
  let sharedStores = 0;
  for (const s of stores) {
    const owner = graph.parent(s.id)?.id;
    const users = new Set();
    for (const [seg, g] of groups) if (owner && (g.modules.has(owner) || [...g.modules].some((m) => graph.out(m, 'IMPORTS').some((e) => e.to === owner)))) users.add(seg);
    if (users.size > 1) sharedStores++;
  }
  const owners = new Set();
  const groupList = [...groups.values()].map((g) => {
    const teams = new Set();
    for (const m of g.modules) for (const e of graph.out(m, 'OWNED_BY')) {
      teams.add(e.to);
      owners.add(e.to);
    }
    return { name: g.name, routes: g.routes, modules: [...g.modules].sort(), teams: [...teams].sort() };
  });
  if (!routes.length) gaps.push('no routes recognised: vertical split candidates come from affinity clustering instead');
  if (!owners.size) gaps.push('no ownership facts for frontend code: team count unknown');
  gaps.push('no navigation analytics: cross-route navigation share unknown (provide it to evaluate micro-frontends)');
  const signals = {
    'frontend.routes': routes.length,
    'frontend.cross_feature_imports': crossFeature,
    'frontend.shared_state_stores': sharedStores,
    'layer.violations': violations.length,
  };
  if (owners.size) signals['frontend.teams'] = owners.size;
  return { modules, groups: groupList, shared: [...shared].sort(), signals, violations, gaps };
}
