// Architecture views (spec §10.1) as Mermaid (and Structurizr for containers). Every view
// is derived from graph facts only and reports how well-evidenced its content is. Labels
// and identifiers from the repository are untrusted: ids are generated (`n1`, `c2`...),
// labels pass through `plain()`, and no view ever emits click/href/directive syntax.

import { shortestCycle, stronglyConnected } from '../graph/algorithms.mjs';
import { IdMap, mermaidFence, plain } from './mermaid.mjs';
import {
  appModules, dataAccess, dedupe, dirOf, edgesOf, publicEntries, riskyRole, scopedGraph, tally, unitEdges, unitModel, unitOf, WRITE_EDGES,
} from './model.mjs';
import { classifyStyles } from './styles.mjs';

const EDGE_WORD = { RUNTIME_CALLS: 'calls', CALLS: 'calls', IMPORTS: 'imports', DEPENDS_ON: 'depends on', ROUTES_TO: 'routes to' };
const UNIT_EDGES = ['IMPORTS', 'CALLS', 'DEPENDS_ON', 'RUNTIME_CALLS', 'ROUTES_TO'];
const MORE = '__more__';

const SHAPES = {
  rect: (id, l) => `${id}["${l}"]`,
  db: (id, l) => `${id}[("${l}")]`,
  stadium: (id, l) => `${id}(["${l}"])`,
  flag: (id, l) => `${id}>"${l}"]`,
  hex: (id, l) => `${id}{{"${l}"}}`,
};
const CLASS_DEFS = {
  shared: 'fill:#fde2e2,stroke:#c0392b,stroke-width:2px',
  risky: 'fill:#fde2e2,stroke:#c0392b,stroke-width:2px',
  public: 'fill:#fff3cd,stroke:#d68910,stroke-width:2px',
  lockstep: 'fill:#fde2e2,stroke:#c0392b,stroke-width:2px',
  more: 'fill:#eeeeee,stroke:#999999,stroke-dasharray:4 3',
};

/** Minimal flowchart builder: generated ids, quoted sanitized labels, optional groups. */
class Flow {
  constructor(dir = 'LR') {
    this.dir = dir;
    this.ids = new IdMap('n');
    this.gids = new IdMap('g');
    this.nodes = new Map();
    this.groups = new Map();
    this.edgeList = [];
    this.used = new Set();
  }

  node(key, label, { shape = 'rect', group = null, cls = null } = {}) {
    if (!this.nodes.has(key)) this.nodes.set(key, { id: this.ids.get(key), decl: SHAPES[shape](this.ids.get(key), plain(label, 48)), group, cls });
    return this.nodes.get(key).id;
  }

  has(key) {
    return this.nodes.has(key);
  }

  edge(a, b, label = null, style = 'arrow') {
    if (!this.nodes.has(a) || !this.nodes.has(b)) return;
    this.edgeList.push({ a: this.nodes.get(a).id, b: this.nodes.get(b).id, label, style });
  }

  toString() {
    const out = [`flowchart ${this.dir}`];
    const byGroup = new Map();
    for (const n of this.nodes.values()) {
      if (!n.group) { out.push(`  ${n.decl}`); continue; }
      if (!byGroup.has(n.group)) byGroup.set(n.group, []);
      byGroup.get(n.group).push(n);
    }
    for (const [g, list] of byGroup) {
      out.push(`  subgraph ${this.gids.get(g)}["${plain(g, 48)}"]`);
      for (const n of list) out.push(`    ${n.decl}`);
      out.push('  end');
    }
    const op = { arrow: ['-->', '-->'], dotted: ['-.->', '-.->'], thick: ['==>', '==>'] };
    for (const e of this.edgeList) {
      const [o] = op[e.style] ?? op.arrow;
      out.push(e.label ? `  ${e.a} ${o}|"${plain(e.label, 32)}"| ${e.b}` : `  ${e.a} ${o} ${e.b}`);
    }
    const used = new Set();
    for (const n of this.nodes.values()) if (n.cls) { used.add(n.cls); out.push(`  class ${n.id} ${n.cls}`); }
    for (const c of used) out.push(`  classDef ${c} ${CLASS_DEFS[c]}`);
    return out.join('\n');
  }
}

/** Keep the `max` heaviest items; the rest collapse into one "+N more" bucket. */
function cap(items, max, weight) {
  if (items.length <= max) return { shown: items, hidden: [] };
  const sorted = [...items].sort((a, b) => weight(b) - weight(a) || String(a.id).localeCompare(String(b.id)));
  return { shown: sorted.slice(0, Math.max(1, max - 1)), hidden: sorted.slice(Math.max(1, max - 1)) };
}

const view = (mermaid, notes, used, extra = {}) => ({ mermaid, ...extra, notes, evidence: tally(used) });
const systemName = (g) => plain(g.nodes('repository')[0]?.name ?? 'System', 40);
const short = (n) => (n.path ? n.path.split('/').slice(-2).join('/') : n.name ?? n.id);

function unitTech(graph, set, u) {
  const a = u.node?.attrs ?? {};
  const declared = a.language ?? a.framework ?? a.runtime ?? a.image ?? a.containers?.[0]?.image;
  if (declared) return declared;
  const counts = new Map();
  for (const m of appModules(graph)) if (set.moduleUnit.get(m.id) === u.id && m.attrs?.language) counts.set(m.attrs.language, (counts.get(m.attrs.language) ?? 0) + 1);
  const best = [...counts].sort((x, y) => y[1] - x[1])[0];
  return best ? best[0] : u.type;
}

/** The shared reading of the system used by landscape, context and containers. */
function systemModel(graph) {
  const um = unitModel(graph);
  const set = um.primary;
  const units = set.units.filter((u) => u.moduleCount > 0 || u.nodeIds.length > 0);
  const unitEdgeList = [...unitEdges(graph, set, UNIT_EDGES).values()];

  const stores = new Map();
  const storeLinks = [];
  const synthetic = () => { if (!stores.has('store:database')) stores.set('store:database', { id: 'store:database', name: 'Database', kind: 'db', node: null }); return 'store:database'; };
  const storeOf = (table) => {
    let cur = graph.parent(table.id);
    for (let i = 0; cur && i < 5; i++, cur = graph.parent(cur.id)) {
      if (cur.type === 'database' || cur.type === 'engine') {
        stores.set(cur.id, { id: cur.id, name: cur.name, kind: 'db', node: cur });
        return cur.id;
      }
    }
    return synthetic();
  };
  for (const acc of dataAccess(graph)) {
    const u = unitOf(graph, set, acc.actor.id);
    if (u) storeLinks.push({ unit: u, store: storeOf(acc.table), rel: acc.write ? 'writes' : 'reads', edge: acc.edge });
  }
  for (const e of graph.edges()) {
    const t = graph.node(e.to);
    if (!t || !['database', 'engine'].includes(t.type) || ['CONTAINS', 'MIGRATES'].includes(e.type)) continue;
    const u = unitOf(graph, set, e.from);
    if (!u) continue;
    stores.set(t.id, { id: t.id, name: t.name, kind: 'db', node: t });
    storeLinks.push({ unit: u, store: t.id, rel: WRITE_EDGES.includes(e.type) ? 'writes' : 'uses', edge: e });
  }
  const channelLinks = [];
  for (const e of edgesOf(graph, ['PUBLISHES', 'SUBSCRIBES', 'CONSUMES'])) {
    const ch = graph.node(e.to);
    if (!ch || !['topic', 'queue'].includes(ch.type)) continue;
    const u = unitOf(graph, set, e.from);
    if (!u) continue;
    stores.set(ch.id, { id: ch.id, name: ch.name, kind: ch.type, node: ch });
    channelLinks.push({ unit: u, store: ch.id, rel: e.type === 'PUBLISHES' ? 'publishes' : 'consumes', edge: e });
  }

  // Units that face the outside: routed to by an entry point, or exposing an endpoint.
  const publicUnits = new Set();
  const entries = publicEntries(graph);
  for (const { node } of entries) for (const e of graph.out(node.id, 'ROUTES_TO')) { const u = unitOf(graph, set, e.to); if (u) publicUnits.add(u); }
  for (const ep of graph.nodes('endpoint')) { if (ep.attrs?.public === false) continue; const u = unitOf(graph, set, ep.id); if (u) publicUnits.add(u); }
  return { kind: um.kind, set, units, unitEdgeList, stores: [...stores.values()], storeLinks, channelLinks, publicUnits, entries };
}

const edgeLabel = (w) => {
  const by = new Map();
  for (const e of w.edges) by.set(e.type, (by.get(e.type) ?? 0) + (e.attrs?.calls ?? e.attrs?.count ?? 1));
  return [...by].map(([t, n]) => `${n} ${EDGE_WORD[t] ?? t.toLowerCase()}`).join(', ');
};

/** Cap units and fold the rest into one bucket; returns a mapper for edge endpoints. */
function capUnits(sys, max) {
  const weight = (u) => u.moduleCount + sys.unitEdgeList.filter((w) => w.from === u.id || w.to === u.id).reduce((s, w) => s + w.count, 0);
  const { shown, hidden } = cap(sys.units, max, weight);
  const shownIds = new Set(shown.map((u) => u.id));
  const map = (id) => (shownIds.has(id) ? id : hidden.length ? MORE : null);
  return { shown, hidden, map };
}

function foldEdges(sys, map) {
  const folded = new Map();
  for (const w of sys.unitEdgeList) {
    const a = map(w.from);
    const b = map(w.to);
    if (!a || !b || a === b) continue;
    const k = `${a}\0${b}`;
    let f = folded.get(k);
    if (!f) folded.set(k, (f = { from: a, to: b, edges: [] }));
    f.edges.push(...w.edges);
  }
  return [...folded.values()];
}

function landscape(graph, maxNodes) {
  const sys = systemModel(graph);
  const f = new Flow('LR');
  const used = [];
  const notes = [];
  const { shown, hidden, map } = capUnits(sys, maxNodes);
  const sname = systemName(graph);
  for (const u of shown) { f.node(u.id, u.name, { group: sname, cls: sys.publicUnits.has(u.id) ? 'public' : null }); used.push(...u.nodeIds.map((id) => graph.node(id))); }
  if (hidden.length) f.node(MORE, `+${hidden.length} more`, { group: sname, cls: 'more' });
  const storeCap = cap(sys.stores, Math.max(4, Math.floor(maxNodes / 3)), () => 1);
  for (const s of storeCap.shown) { f.node(s.id, s.name, { shape: s.kind === 'db' ? 'db' : 'flag', group: s.kind === 'db' ? 'Data stores' : 'Messaging' }); used.push(s.node); }
  if (sys.entries.length) {
    f.node('ext:users', 'Users and external clients', { shape: 'stadium', group: 'External' });
    for (const u of shown) if (sys.publicUnits.has(u.id)) f.edge('ext:users', u.id);
    used.push(...sys.entries.map((e) => e.node));
  }
  for (const w of foldEdges(sys, map)) { f.edge(w.from, w.to, edgeLabel(w)); used.push(...w.edges); }
  for (const l of [...sys.storeLinks, ...sys.channelLinks]) {
    const u = map(l.unit);
    if (u) { f.edge(u, l.store, l.rel, l.rel === 'reads' || l.rel === 'consumes' ? 'dotted' : 'arrow'); used.push(l.edge); }
  }
  notes.push(`${sys.units.length} ${sys.kind === 'deployables' ? 'deployable unit(s)' : sys.kind === 'packages' ? 'package(s)' : 'top-level directories'}, ${sys.stores.length} data store/channel node(s).`);
  if (sys.kind !== 'deployables') notes.push('No deployable units were observed, so containers are approximated from source structure (inferred).');
  if (!sys.units.length) notes.push('No source modules or deployable units were found in scope.');
  return view(f.toString(), notes, used);
}

function context(graph) {
  const sys = systemModel(graph);
  const c = new IdMap('c');
  const lines = ['C4Context', `  title System context for ${systemName(graph)}`];
  const used = [];
  const notes = [];
  const sid = c.get('system');
  if (sys.entries.length) {
    lines.push(`  Person(${c.get('users')}, "Users and external clients", "Reach the system through ${sys.entries.length} public entry point(s)")`);
    used.push(...sys.entries.map((e) => e.node));
  }
  lines.push(`  System(${sid}, "${systemName(graph)}", "${sys.units.length} unit(s); ${sys.stores.filter((s) => s.kind === 'db').length} data store(s)")`);
  // Externals: cloud providers and nodes explicitly flagged external; dependencies are too noisy.
  const externals = [...graph.nodes('cloud'), ...graph.nodes('net_endpoint').filter((n) => n.attrs?.external === true)].slice(0, 8);
  for (const x of externals) { lines.push(`  System_Ext(${c.get(x.id)}, "${plain(x.name, 40)}", "External dependency")`); used.push(x); }
  if (sys.entries.length) lines.push(`  Rel(${c.get('users')}, ${sid}, "Uses")`);
  for (const x of externals) lines.push(`  Rel(${sid}, ${c.get(x.id)}, "Depends on")`);
  notes.push(sys.entries.length ? `${sys.entries.length} public entry point(s) observed.` : 'No public entry point was observed; the user relationship is omitted (unknown).');
  if (!externals.length) notes.push('No external systems were declared in the graph.');
  return view(lines.join('\n'), notes, used);
}

function containers(graph, maxNodes) {
  const sys = systemModel(graph);
  const c = new IdMap('c');
  const used = [];
  const notes = [];
  const { shown, hidden, map } = capUnits(sys, maxNodes);
  const lines = ['C4Container', `  title Containers of ${systemName(graph)}`];
  const dsl = [];
  const hasUsers = sys.publicUnits.size > 0;
  if (hasUsers) lines.push(`  Person(${c.get('users')}, "Users and external clients")`);
  lines.push(`  System_Boundary(${c.get('boundary')}, "${systemName(graph)}") {`);
  for (const u of shown) {
    const tech = plain(unitTech(graph, sys.set, u), 30);
    lines.push(`    Container(${c.get(u.id)}, "${plain(u.name, 40)}", "${tech}", "${u.moduleCount} module(s)")`);
    dsl.push({ id: c.get(u.id), name: u.name, tech, desc: `${u.moduleCount} modules` });
    used.push(...u.nodeIds.map((id) => graph.node(id)));
  }
  if (hidden.length) lines.push(`    Container(${c.get(MORE)}, "+${hidden.length} more", "aggregate", "${hidden.reduce((s, u) => s + u.moduleCount, 0)} module(s)")`);
  const storeCap = cap(sys.stores, Math.max(4, Math.floor(maxNodes / 3)), () => 1);
  for (const s of storeCap.shown) {
    lines.push(`    ${s.kind === 'db' ? 'ContainerDb' : 'ContainerQueue'}(${c.get(s.id)}, "${plain(s.name, 40)}", "${s.kind === 'db' ? 'datastore' : s.kind}")`);
    used.push(s.node);
  }
  lines.push('  }');
  const shownStores = new Set(storeCap.shown.map((s) => s.id));
  const rels = [];
  if (hasUsers) for (const u of shown) if (sys.publicUnits.has(u.id)) rels.push([c.get('users'), c.get(u.id), 'Uses']);
  for (const w of foldEdges(sys, map)) { rels.push([c.get(w.from), c.get(w.to), edgeLabel(w)]); used.push(...w.edges); }
  const seen = new Set();
  for (const l of [...sys.storeLinks, ...sys.channelLinks]) {
    const u = map(l.unit);
    if (!u || !shownStores.has(l.store)) continue;
    const k = `${u}|${l.store}|${l.rel}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rels.push([c.get(u), c.get(l.store), l.rel]);
    used.push(l.edge);
  }
  for (const [a, b, l] of rels) lines.push(`  Rel(${a}, ${b}, "${plain(l, 40)}")`);
  const structurizr = shown.length ? structurizrDsl(graph, dsl, c, rels, hasUsers, storeCap.shown) : undefined;
  notes.push(`${shown.length + (hidden.length ? 1 : 0)} container(s), ${storeCap.shown.length} data/messaging element(s), ${rels.length} relationship(s).`);
  if (sys.kind !== 'deployables') notes.push(`Containers are ${sys.kind} (no deployable units observed): inferred, not deployment-verified.`);
  if (hidden.length) notes.push(`${hidden.length} lower-weight container(s) are aggregated as "+${hidden.length} more"; raise --max-nodes to see them.`);
  return view(lines.join('\n'), notes, used, structurizr ? { structurizr } : {});
}

function structurizrDsl(graph, units, c, rels, hasUsers, stores) {
  const q = (s) => `"${plain(s, 80)}"`;
  const out = [`workspace ${q(systemName(graph))} "Generated by Unknot from the codebase knowledge graph" {`, '  model {'];
  if (hasUsers) out.push(`    ${c.get('users')} = person "Users and external clients"`);
  out.push(`    ${c.get('boundary')} = softwareSystem ${q(systemName(graph))} {`);
  for (const u of units) out.push(`      ${u.id} = container ${q(u.name)} ${q(u.desc)} ${q(u.tech)}`);
  for (const s of stores) out.push(`      ${c.get(s.id)} = container ${q(s.name)} "" ${q(s.kind === 'db' ? 'datastore' : s.kind)}${s.kind === 'db' ? ' { tags "Database" }' : ''}`);
  out.push('    }');
  for (const [a, b, l] of rels) out.push(`    ${a} -> ${b} ${q(l)}`);
  out.push('  }', '  views {');
  out.push(`    systemContext ${c.get('boundary')} "Context" { include * autolayout lr }`);
  out.push(`    container ${c.get('boundary')} "Containers" { include * autolayout lr }`);
  out.push('    styles { element "Database" { shape Cylinder } }', '  }', '}');
  return out.join('\n');
}

function components(graph, maxNodes, container) {
  const sys = systemModel(graph);
  const set = sys.set;
  const pick = (container && sys.units.find((u) => u.id === container || u.name === container)) ?? [...sys.units].sort((a, b) => b.moduleCount - a.moduleCount)[0];
  const notes = [];
  if (!pick || pick.moduleCount === 0) {
    return view('C4Component\n  title Components\n  Component(c1, "No modules", "n/a", "No source modules were mapped to a container")', ['No modules are mapped to any container, so no component view can be drawn (unknown).'], []);
  }
  const mods = appModules(graph).filter((m) => set.moduleUnit.get(m.id) === pick.id);
  // Group by directory, deepening until more than one group exists (or depth 4).
  const rel = (m) => { const p = m.path ?? ''; return pick.root && p.startsWith(`${pick.root}/`) ? p.slice(pick.root.length + 1) : p; };
  let depth = 1;
  const groupKey = (m, d) => dirOf(rel(m)).split('/').filter(Boolean).slice(0, d).join('/') || '(root)';
  while (depth < 4 && new Set(mods.map((m) => groupKey(m, depth))).size < 2 && new Set(mods.map((m) => groupKey(m, depth + 1))).size > 1) depth++;
  const groups = new Map();
  for (const m of mods) {
    const k = groupKey(m, depth);
    if (!groups.has(k)) groups.set(k, { id: k, modules: [] });
    groups.get(k).modules.push(m);
  }
  const all = [...groups.values()];
  const { shown, hidden } = cap(all, maxNodes, (g) => g.modules.length);
  const groupOf = new Map();
  for (const g of shown) for (const m of g.modules) groupOf.set(m.id, g.id);
  for (const g of hidden) for (const m of g.modules) groupOf.set(m.id, MORE);
  const c = new IdMap('c');
  const lines = ['C4Component', `  title Components of ${plain(pick.name, 40)}`, `  Container_Boundary(${c.get('boundary')}, "${plain(pick.name, 40)}") {`];
  for (const g of shown) lines.push(`    Component(${c.get(g.id)}, "${plain(g.id, 40)}", "directory", "${g.modules.length} module(s)")`);
  if (hidden.length) lines.push(`    Component(${c.get(MORE)}, "+${hidden.length} more", "aggregate", "${hidden.reduce((s, g) => s + g.modules.length, 0)} module(s) in ${hidden.length} directories")`);
  lines.push('  }');
  const agg = new Map();
  const used = [...mods];
  for (const e of graph.edges('IMPORTS')) {
    const a = groupOf.get(e.from);
    const b = groupOf.get(e.to);
    if (!a || !b || a === b) continue;
    const k = `${a}\0${b}`;
    agg.set(k, (agg.get(k) ?? 0) + (e.attrs?.count ?? 1));
    used.push(e);
  }
  for (const [k, n] of agg) { const [a, b] = k.split('\0'); lines.push(`  Rel(${c.get(a)}, ${c.get(b)}, "imports", "${n} import(s)")`); }
  notes.push(`Container "${plain(pick.name, 40)}": ${mods.length} module(s) in ${all.length} director${all.length === 1 ? 'y' : 'ies'}; showing ${shown.length}.`);
  if (hidden.length) notes.push(`${hidden.length} smaller director${hidden.length === 1 ? 'y is' : 'ies are'} aggregated as "+${hidden.length} more".`);
  return view(lines.join('\n'), notes, used);
}

function deployment(graph, maxNodes) {
  const c = new IdMap('c');
  const used = [];
  const notes = [];
  const lines = ['C4Deployment', `  title Deployment topology of ${systemName(graph)}`];
  const budget = { left: maxNodes };
  const takeNodes = (items) => { const t = items.slice(0, Math.max(0, budget.left)); budget.left -= t.length; return t; };

  const byNs = new Map();
  for (const w of graph.nodes('workload')) {
    const ns = w.attrs?.effective_namespace ?? w.attrs?.namespace ?? graph.in(w.id, 'CONTAINS').map((e) => graph.node(e.from)).find((n) => n?.type === 'k8s_namespace')?.name ?? 'default';
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push(w);
  }
  const shownKeys = new Set();
  for (const [ns, list] of [...byNs].sort((a, b) => b[1].length - a[1].length)) {
    const take = takeNodes(list);
    if (!take.length) break;
    lines.push(`  Deployment_Node(${c.get(`ns:${ns}`)}, "${plain(ns, 40)}", "Kubernetes namespace") {`);
    for (const w of take) {
      const replicas = w.attrs?.replicas;
      lines.push(`    Container(${c.get(w.id)}, "${plain(w.name, 40)}", "${plain(w.attrs?.kind ?? 'workload', 20)}", "${replicas ? `${replicas} replica(s)` : 'replicas unspecified'}")`);
      used.push(w);
      shownKeys.add(w.id);
    }
    lines.push('  }');
    if (take.length < list.length) notes.push(`Namespace ${plain(ns, 40)}: ${list.length - take.length} more workload(s) not shown.`);
  }
  const resources = graph.nodes('resource').filter((r) => r.attrs?.type && !r.attrs.data && !r.attrs.drift);
  const byProvider = new Map();
  for (const r of resources) {
    const p = r.attrs.provider ?? String(r.attrs.type).split('_')[0];
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p).push(r);
  }
  for (const [p, list] of [...byProvider].sort((a, b) => b[1].length - a[1].length)) {
    const take = takeNodes(list);
    if (!take.length) break;
    lines.push(`  Deployment_Node(${c.get(`cloud:${p}`)}, "${plain(p, 30)} resources", "Cloud") {`);
    for (const r of take) { lines.push(`    Container(${c.get(r.id)}, "${plain(r.attrs.address ?? r.name, 40)}", "${plain(r.attrs.type, 30)}", "declared in ${plain(r.path ?? 'IaC', 40)}")`); used.push(r); shownKeys.add(r.id); }
    lines.push('  }');
    if (take.length < list.length) notes.push(`${plain(p, 30)}: ${list.length - take.length} more resource(s) not shown.`);
  }
  for (const e of edgesOf(graph, ['ROUTES_TO', 'DEPLOYED_TO', 'DEPLOYS_TO'])) {
    if (!shownKeys.has(e.from) || !shownKeys.has(e.to)) continue;
    lines.push(`  Rel(${c.get(e.from)}, ${c.get(e.to)}, "${e.type === 'ROUTES_TO' ? 'routes to' : 'deployed to'}")`);
    used.push(e);
  }
  if (!shownKeys.size) {
    lines.push(`  Deployment_Node(${c.get('none')}, "No deployment evidence", "unknown") {`, `    Container(${c.get('none-c')}, "none", "n/a", "No workloads or declared cloud resources found")`, '  }');
    notes.push('No workloads, namespaces or cloud resources were found; deployment topology is unknown.');
  } else {
    notes.push(`${shownKeys.size} deployment element(s) shown (${byNs.size} namespace(s), ${byProvider.size} cloud provider group(s)).`);
  }
  return view(lines.join('\n'), notes, used);
}

function sequences(graph) {
  const calls = graph.edges('RUNTIME_CALLS').sort((a, b) => (b.attrs.calls ?? b.attrs.count ?? 0) - (a.attrs.calls ?? a.attrs.count ?? 0) || a.id.localeCompare(b.id));
  const n = (e) => e.attrs.calls ?? e.attrs.count ?? 1;
  if (!calls.length) {
    return view('sequenceDiagram\n  participant none as "No RUNTIME_CALLS evidence"', ['No runtime call evidence (traces) was imported, so no sequence can be derived (unknown).'], [{ label: 'unknown' }]);
  }
  const p = new IdMap('p');
  const lines = ['sequenceDiagram'];
  const declared = new Set();
  const used = [];
  const notes = [];
  const declare = (id) => {
    if (declared.has(id)) return;
    declared.add(id);
    lines.push(`  participant ${p.get(id)} as "${plain(graph.node(id)?.name ?? id, 40)}"`);
  };
  const starts = calls.slice(0, 3);
  const chains = starts.map((first) => {
    const path = [first];
    const seen = new Set([first.from, first.to]);
    for (let i = 0; i < 4; i++) {
      const next = graph.out(path.at(-1).to, 'RUNTIME_CALLS').filter((e) => !seen.has(e.to)).sort((a, b) => n(b) - n(a) || a.id.localeCompare(b.id))[0];
      if (!next) break;
      path.push(next);
      seen.add(next.to);
    }
    return path;
  });
  for (const ch of chains) for (const e of ch) { declare(e.from); declare(e.to); }
  chains.forEach((ch, i) => {
    lines.push('  rect rgb(245, 247, 250)', `    Note over ${p.get(ch[0].from)},${p.get(ch.at(-1).to)}: Sequence ${i + 1} - ${n(ch[0])} calls on the first hop`);
    for (const e of ch) {
      const bits = [`${n(e)} calls`];
      if (typeof e.attrs.p95_ms === 'number') bits.push(`p95 ${e.attrs.p95_ms} ms`);
      if (e.attrs.error_rate) bits.push(`${(e.attrs.error_rate * 100).toFixed(1)}% errors`);
      lines.push(`    ${p.get(e.from)}->>${p.get(e.to)}: ${plain(bits.join(' '), 60)}`);
      used.push(e);
    }
    lines.push('  end');
    notes.push(`Sequence ${i + 1}: ${ch.map((e, j) => (j === 0 ? `${plain(graph.node(e.from)?.name ?? e.from, 30)} -> ` : '') + plain(graph.node(e.to)?.name ?? e.to, 30)).join(' -> ')}.`);
  });
  notes.push('Sequences follow the heaviest outgoing call at each hop; they are call chains from traces, not guaranteed request paths.');
  return view(lines.join('\n'), notes, used);
}

function dataOwnership(graph, maxNodes) {
  const sys = systemModel(graph);
  const acc = dataAccess(graph);
  const f = new Flow('LR');
  const used = [];
  const notes = [];
  if (!acc.length) {
    f.node('none', 'No table access recorded', { shape: 'stadium' });
    return view(f.toString(), ['No module or service reads or writes a table in the graph (unknown).'], [{ label: 'unknown' }]);
  }
  const actorKey = (a) => unitOf(graph, sys.set, a.id) ?? a.id;
  const tables = new Map();
  for (const x of acc) {
    if (!tables.has(x.table.id)) tables.set(x.table.id, { id: x.table.id, node: x.table, writers: new Set(), readers: new Set(), owners: new Set(), edges: [] });
    const t = tables.get(x.table.id);
    const k = actorKey(x.actor);
    if (x.edge.type === 'OWNS_DATA') t.owners.add(k);
    else if (x.write) t.writers.add(k);
    else t.readers.add(k);
    t.edges.push({ ...x, actor: k });
  }
  const writersOf = (t) => new Set([...t.writers, ...t.owners]);
  const list = [...tables.values()];
  const shared = list.filter((t) => writersOf(t).size >= 2);
  const { shown, hidden } = cap(list, maxNodes, (t) => (writersOf(t).size >= 2 ? 1000 : 0) + t.edges.length);
  const nameOf = (k) => sys.set.units.find((u) => u.id === k)?.name ?? graph.node(k)?.name ?? k;
  for (const t of shown) {
    f.node(t.id, t.node.name, { shape: 'db', group: 'Tables', cls: writersOf(t).size >= 2 ? 'shared' : null });
    used.push(t.node);
  }
  if (hidden.length) f.node(MORE, `+${hidden.length} more tables`, { shape: 'db', group: 'Tables', cls: 'more' });
  const seen = new Set();
  for (const t of shown) {
    for (const x of t.edges) {
      if (!f.has(x.actor)) f.node(x.actor, nameOf(x.actor), { group: 'Owners and users' });
      const kind = x.edge.type === 'OWNS_DATA' ? 'owns' : x.write ? 'writes' : 'reads';
      const k = `${x.actor}|${t.id}|${kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      f.edge(x.actor, t.id, kind, kind === 'owns' ? 'thick' : kind === 'writes' ? 'arrow' : 'dotted');
      used.push(x.edge);
    }
  }
  for (const t of shared.slice(0, 10)) notes.push(`Shared writers: ${plain(t.node.name, 40)} is written by ${[...writersOf(t)].map((k) => plain(nameOf(k), 30)).join(', ')}.`);
  const unowned = list.filter((t) => !t.owners.size);
  notes.unshift(`${list.length} table(s); ${shared.length} with more than one writer (highlighted); ${unowned.length} with no declared owner (OWNS_DATA).`);
  if (hidden.length) notes.push(`${hidden.length} lower-traffic table(s) are aggregated as "+${hidden.length} more tables".`);
  return view(f.toString(), notes, used);
}

function trustBoundaries(graph, maxNodes) {
  const f = new Flow('LR');
  const used = [];
  const notes = [];
  const entries = publicEntries(graph).slice(0, 10);
  for (const { node } of entries) { f.node(node.id, `${node.type}: ${node.name}`, { shape: 'hex', group: 'Internet-facing', cls: 'public' }); used.push(node); }
  const workloads = graph.nodes('workload').slice(0, Math.max(1, Math.floor(maxNodes / 2)));
  for (const w of workloads) {
    f.node(w.id, w.name, { group: `namespace ${w.attrs?.namespace ?? 'default'}` });
    used.push(w);
  }
  const policies = graph.nodes('firewall_rule').filter((p) => graph.in(p.id, 'PROTECTED_BY').length || graph.out(p.id, ['ALLOWS_INGRESS_FROM', 'ALLOWS_EGRESS_TO']).length).slice(0, 10);
  for (const p of policies) { f.node(p.id, p.name, { shape: 'stadium', group: 'Network policy' }); used.push(p); }
  const roleNodes = new Set();
  const saList = dedupe([
    ...workloads.map((w) => (w.attrs?.service_account ? `service_account:${w.attrs.namespace}/${w.attrs.service_account}` : null)).filter(Boolean),
    ...graph.nodes('service_account').map((s) => s.id),
  ]).filter((id) => graph.node(id)).slice(0, 12);
  for (const id of saList) {
    const sa = graph.node(id);
    f.node(id, sa.name, { shape: 'stadium', group: 'Identities' });
    used.push(sa);
    for (const e of graph.out(id, 'ASSUMES')) {
      const role = graph.node(e.to);
      if (!role || roleNodes.size >= 12) continue;
      const risks = riskyRole(role);
      if (!roleNodes.has(role.id)) { roleNodes.add(role.id); f.node(role.id, role.name, { group: 'Roles', cls: risks.length ? 'risky' : null }); used.push(role); }
      f.edge(id, role.id, 'assumes');
      used.push(e);
    }
  }
  for (const w of workloads) {
    const sa = w.attrs?.service_account ? `service_account:${w.attrs.namespace}/${w.attrs.service_account}` : null;
    if (sa) f.edge(w.id, sa, 'runs as', 'dotted');
  }
  for (const e of edgesOf(graph, ['ROUTES_TO', 'PROTECTED_BY', 'ALLOWS_INGRESS_FROM', 'ALLOWS_EGRESS_TO'])) {
    if (!f.has(e.from) || !f.has(e.to)) continue;
    f.edge(e.from, e.to, e.type === 'PROTECTED_BY' ? 'protected by' : e.type === 'ROUTES_TO' ? 'routes to' : e.type === 'ALLOWS_INGRESS_FROM' ? 'ingress from' : 'egress to', e.type === 'PROTECTED_BY' ? 'dotted' : 'arrow');
    used.push(e);
  }
  if (!f.nodes.size) f.node('none', 'No trust-boundary evidence', { shape: 'stadium' });
  notes.push(entries.length ? `${entries.length} internet-facing entry point(s): ${entries.map((e) => `${plain(e.node.name, 30)} (${e.why})`).join('; ')}.` : 'No internet-facing entry point was observed (unknown rather than none).');
  for (const id of roleNodes) { const r = graph.node(id); const why = riskyRole(r); if (why.length) notes.push(`Privileged role ${plain(r.name, 40)}: ${why.join(', ')}.`); }
  if (workloads.length && policies.length) {
    const unprotected = workloads.filter((w) => !graph.out(w.id, 'PROTECTED_BY').some((e) => graph.node(e.to)?.type === 'firewall_rule'));
    if (unprotected.length) notes.push(`${unprotected.length} workload(s) have no network policy attached: ${unprotected.slice(0, 5).map((w) => plain(w.name, 30)).join(', ')}.`);
  } else if (workloads.length) notes.push('No network policies were found; east-west traffic restrictions are unknown.');
  return view(f.toString(), notes, used);
}

function cycles(graph) {
  const f = new Flow('LR');
  const used = [];
  const notes = [];
  const mod = stronglyConnected(graph, { nodeTypes: ['module'] });
  const pkg = stronglyConnected(graph, { edgeTypes: ['DEPENDS_ON'], nodeTypes: ['package'] });
  const comps = [...mod.map((c) => ({ c, types: ['IMPORTS'], what: 'module' })), ...pkg.map((c) => ({ c, types: ['DEPENDS_ON'], what: 'package' }))];
  if (!comps.length) {
    f.node('none', 'No dependency cycles', { shape: 'stadium' });
    return view(f.toString(), ['No import or package dependency cycles were found.'], []);
  }
  comps.sort((a, b) => b.c.length - a.c.length);
  let budget = 40;
  comps.slice(0, 4).forEach(({ c, types }, i) => {
    const members = c.slice(0, 12);
    const set = new Set(members);
    const cyc = shortestCycle(graph, c, types) ?? [];
    const onCycle = new Set(cyc.map((id, j) => `${id}|${cyc[(j + 1) % cyc.length]}`));
    for (const id of members) { f.node(id, short(graph.node(id)), { group: `Cycle ${i + 1} (${c.length})` }); used.push(graph.node(id)); }
    for (const id of members) {
      for (const e of graph.out(id, types)) {
        if (!set.has(e.to) || budget <= 0) continue;
        budget--;
        f.edge(id, e.to, null, onCycle.has(`${id}|${e.to}`) ? 'thick' : 'arrow');
        used.push(e);
      }
    }
    notes.push(`Cycle ${i + 1}: ${c.length} ${types[0] === 'IMPORTS' ? 'modules' : 'packages'}; shortest loop ${cyc.map((id) => plain(short(graph.node(id)), 30)).join(' -> ')}${cyc.length ? ` -> ${plain(short(graph.node(cyc[0])), 30)}` : ''}.`);
  });
  notes.unshift(`${mod.length} module cycle(s) and ${pkg.length} package cycle(s) found; the shortest loop of each shown cycle is drawn with thick arrows.`);
  if (comps.length > 4) notes.push(`${comps.length - 4} smaller cycle(s) not drawn.`);
  return view(f.toString(), notes, used);
}

function buildDeployCoupling(graph, maxNodes) {
  const sys = systemModel(graph);
  const deploy = unitModel(graph).deploy;
  const f = new Flow('LR');
  const used = [];
  const notes = [];
  const drivers = [...graph.nodes('pipeline'), ...graph.nodes('build_target'), ...graph.nodes('builder')].slice(0, maxNodes);
  let lockstep = 0;
  for (const d of drivers) {
    const outs = graph.out(d.id, ['BUILDS', 'DEPLOYS', 'DEPLOYS_TO']);
    if (!outs.length) continue;
    const targets = dedupe(outs.map((e) => unitOf(graph, deploy, e.to) ?? e.to));
    const together = targets.filter((t) => deploy.units.some((u) => u.id === t)).length >= 2;
    f.node(d.id, `${d.type}: ${d.name}`, { shape: 'stadium', group: 'Build and release', cls: together ? 'lockstep' : null });
    used.push(d);
    if (together) {
      lockstep++;
      notes.push(`${plain(d.name, 40)} builds or deploys ${targets.length} units in one release: ${targets.slice(0, 6).map((t) => plain(deploy.units.find((u) => u.id === t)?.name ?? graph.node(t)?.name ?? t, 30)).join(', ')} (lockstep).`);
    }
    for (const e of outs) {
      const t = unitOf(graph, deploy, e.to);
      const key = t ?? e.to;
      const tn = t ? deploy.units.find((u) => u.id === t) : graph.node(e.to);
      if (!tn) continue;
      f.node(key, tn.name, { group: 'Deployable units' });
      f.edge(d.id, key, e.type === 'BUILDS' ? 'builds' : 'deploys');
      used.push(e);
    }
  }
  const pairs = new Map();
  for (const e of graph.edges('CO_CHANGES')) {
    const a = unitOf(graph, sys.set, e.from);
    const b = unitOf(graph, sys.set, e.to);
    if (!a || !b || a === b) continue;
    const k = [a, b].sort().join('\0');
    pairs.set(k, (pairs.get(k) ?? 0) + (e.attrs.shared ?? 1));
    used.push(e);
  }
  const hot = [...pairs].sort((x, y) => y[1] - x[1]).slice(0, 6);
  for (const [k, n] of hot) {
    const [a, b] = k.split('\0');
    const un = (id) => sys.set.units.find((u) => u.id === id)?.name ?? id;
    f.node(a, un(a), { group: 'Deployable units' });
    f.node(b, un(b), { group: 'Deployable units' });
    f.edge(a, b, `co-change ${n}`, 'dotted');
    notes.push(`${plain(un(a), 30)} and ${plain(un(b), 30)} changed together in ${n} commit(s).`);
  }
  if (!f.nodes.size) {
    f.node('none', 'No build/deploy coupling evidence', { shape: 'stadium' });
    notes.push('No pipelines, build targets or change history link units together (unknown).');
  } else notes.unshift(`${lockstep} pipeline(s) release multiple units together; ${hot.length} cross-unit co-change pair(s).`);
  return view(f.toString(), notes, used);
}

/**
 * Build every view plus the style classification for a graph.
 * @param {import('../graph/graph.mjs').Graph} graph
 * @param {{scope?: string[], maxNodes?: number, container?: string}} [opts]
 */
export function architectureViews(graph, { scope = [], maxNodes = 60, container = null } = {}) {
  const g = scopedGraph(graph, scope);
  const max = Math.max(4, Number(maxNodes) || 60);
  return {
    styles: classifyStyles(g),
    views: {
      landscape: landscape(g, max),
      context: context(g),
      containers: containers(g, max),
      components: components(g, max, container),
      deployment: deployment(g, max),
      sequences: sequences(g),
      data_ownership: dataOwnership(g, max),
      trust_boundaries: trustBoundaries(g, max),
      cycles: cycles(g),
      build_deploy_coupling: buildDeployCoupling(g, max),
    },
    labels: tally([...g.nodes(), ...g.edges()]),
  };
}

export const VIEW_TITLES = {
  landscape: 'System landscape',
  context: 'C4 context',
  containers: 'C4 containers',
  components: 'C4 components',
  deployment: 'Deployment topology',
  sequences: 'Critical runtime sequences',
  data_ownership: 'Data ownership',
  trust_boundaries: 'Trust boundaries and privilege paths',
  cycles: 'Dependency cycles',
  build_deploy_coupling: 'Build and deployment coupling',
};

const evidenceTable = (ev) => ['| Label | Elements |', '|---|---:|', ...Object.entries(ev).map(([k, v]) => `| ${k} | ${v} |`)].join('\n');

/** One markdown page for a view: the diagram, its notes and how well it is evidenced. */
export function renderViewPage(name, v) {
  return [
    `# ${VIEW_TITLES[name] ?? plain(name)}`,
    '',
    '_Generated by Unknot from the codebase knowledge graph. Regenerate rather than edit by hand._',
    '',
    mermaidFence(v.mermaid),
    '',
    '## Notes',
    '',
    ...(v.notes.length ? v.notes.map((n) => `- ${plain(n, 400)}`) : ['- (none)']),
    '',
    '## Evidence labels',
    '',
    evidenceTable(v.evidence),
    '',
  ].join('\n');
}

/** The style classification as a page: every style with its label and the evidence for it. */
export function renderStylesPage(styles, labels) {
  const out = ['# Architecture styles', '', '_Classification describes actual evidence and may return several styles (spec 10.2). Labels: observed, corroborated, inferred, unknown, contradicted._', ''];
  for (const s of styles) {
    out.push(`## ${plain(s.style, 60)} (${s.label})`, '', plain(s.summary, 400), '');
    for (const e of s.evidence) out.push(`- ${plain(e.summary, 300)}${e.refs.length ? ` (${e.refs.map((r) => `\`${plain(r, 80)}\``).join(', ')})` : ''}`);
    out.push('');
  }
  if (labels) out.push('## Graph evidence labels', '', evidenceTable(labels), '');
  return out.join('\n');
}
