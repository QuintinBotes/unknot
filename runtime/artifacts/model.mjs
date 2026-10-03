// Graph helpers shared by the architecture views, style classifier and reports: scoping,
// the container (deployable / package / directory) model, module-to-container mapping and
// evidence-label tallies. Pure functions over a Graph; nothing here writes.

import { posix } from 'node:path';
import { Graph } from '../graph/graph.mjs';

export const DEPLOY_TYPES = ['service', 'deployable', 'workload'];
export const LABELS = ['observed', 'corroborated', 'inferred', 'unknown', 'contradicted'];
export const WRITE_EDGES = ['MUTATES', 'WRITES', 'OWNS_DATA'];
export const READ_EDGES = ['QUERIES', 'READS'];
export const DATA_EDGES = [...READ_EDGES, ...WRITE_EDGES];

// Directory names that group several containers, so the container is the child directory.
const CONTAINER_ROOTS = new Set(['apps', 'packages', 'services', 'libs', 'modules', 'crates', 'cmd', 'internal', 'pkg', 'src', 'lib', 'app']);

export const isTestNode = (n) => n.attrs?.is_test === true
  || /(^|\/)(tests?|__tests__|spec|specs)\//i.test(n.path ?? '')
  || /\.(test|spec)\.[a-z]+$/i.test(n.path ?? '');

/** Non-test source modules. */
export const appModules = (graph) => graph.nodes('module').filter((n) => !isTestNode(n) && !n.attrs?.placeholder);

export const dirOf = (path) => (path && path.includes('/') ? posix.dirname(path) : '');

function inScope(node, scope) {
  if (!scope?.length || !node.path) return true;
  return scope.some((s) => {
    const p = s.replace(/\/+$/, '');
    return node.path === p || node.path.startsWith(`${p}/`);
  });
}

/** A new Graph holding only nodes under `scope` (path-less nodes stay) and edges between them. */
export function scopedGraph(graph, scope) {
  if (!scope?.length) return graph;
  const g = new Graph();
  for (const n of graph.nodeMap.values()) {
    if (!inScope(n, scope)) continue;
    g.nodeMap.set(n.id, n);
    g.index(g.typeIdx, n.type, n.id);
  }
  for (const e of graph.edgeMap.values()) {
    if (!g.nodeMap.has(e.from) || !g.nodeMap.has(e.to)) continue;
    g.edgeMap.set(e.id, e);
    g.index(g.outIdx, e.from, e);
    g.index(g.inIdx, e.to, e);
  }
  return g;
}

/** Counts of evidence labels over nodes and edges (a missing label counts as unknown). */
export function tally(items) {
  const out = Object.fromEntries(LABELS.map((l) => [l, 0]));
  for (const it of items) {
    if (!it) continue;
    out[LABELS.includes(it.label) ? it.label : 'unknown']++;
  }
  return out;
}

/** The enclosing module of any code-level node (function, class, endpoint...). */
export function moduleOf(graph, id) {
  let cur = graph.node(id);
  for (let i = 0; cur && i < 5; i++) {
    if (cur.type === 'module' || cur.type === 'file') return cur;
    cur = graph.parent(cur.id);
  }
  return null;
}

function rootOf(n) {
  if (n.attrs?.root) return String(n.attrs.root).replace(/^\.\//, '').replace(/\/+$/, '');
  if (n.attrs?.dir && n.attrs.dir !== '.') return String(n.attrs.dir).replace(/\/+$/, '');
  if (!n.path) return null;
  return /\.[A-Za-z0-9]+$/.test(posix.basename(n.path)) ? dirOf(n.path) : n.path;
}

function deployUnits(graph) {
  const byName = new Map();
  const unitOf = new Map();
  for (const n of graph.nodes().filter((x) => DEPLOY_TYPES.includes(x.type) && !x.attrs?.placeholder)) {
    // A Deployment, its Service and a traced service of the same name are one container.
    const key = String(n.name ?? n.id).toLowerCase();
    let u = byName.get(key);
    if (!u) byName.set(key, (u = { id: `unit:${key}`, name: n.name ?? n.id, type: n.type, root: null, nodeIds: [], moduleCount: 0, node: n }));
    u.nodeIds.push(n.id);
    if (n.type === 'service' && !n.attrs?.ports) { u.type = 'service'; u.node = n; }
    // Source roots come from the node that knows the source tree (a deployable's build
    // context or a declared root), not from a Kubernetes manifest's directory.
    if (!u.root && (n.type === 'deployable' || n.attrs?.root)) u.root = rootOf(n);
    unitOf.set(n.id, u.id);
  }
  return { units: [...byName.values()], unitOf, moduleUnit: new Map() };
}

function mapDeployModules(set, mods) {
  const byRoot = set.units.filter((u) => u.root).sort((a, b) => b.root.length - a.root.length);
  for (const m of mods) {
    const p = m.path ?? m.id.replace(/^module:/, '');
    const hit = byRoot.find((u) => p === u.root || p.startsWith(`${u.root}/`));
    if (hit) { set.moduleUnit.set(m.id, hit.id); hit.moduleCount++; }
  }
}

function directoryUnits(mods) {
  const units = new Map();
  const moduleUnit = new Map();
  for (const m of mods) {
    const segs = dirOf(m.path ?? '').split('/').filter(Boolean);
    const key = !segs.length ? 'root' : CONTAINER_ROOTS.has(segs[0]) && segs.length > 1 ? `${segs[0]}/${segs[1]}` : segs[0];
    let u = units.get(key);
    if (!u) units.set(key, (u = { id: `unit:dir/${key}`, name: key, type: 'directory', root: key === 'root' ? '' : key, nodeIds: [], moduleCount: 0, node: null }));
    u.moduleCount++;
    moduleUnit.set(m.id, u.id);
  }
  return { units: [...units.values()].sort((a, b) => b.moduleCount - a.moduleCount || a.name.localeCompare(b.name)), moduleUnit, unitOf: new Map() };
}

function packageUnits(graph, mods) {
  const units = [];
  for (const p of graph.nodes('package').filter((x) => !x.attrs?.placeholder)) {
    const root = rootOf(p);
    if (!root || root === '.') continue;
    units.push({ id: `unit:pkg/${p.name}`, name: p.name, type: 'package', root, nodeIds: [p.id], moduleCount: 0, node: p });
  }
  const byRoot = [...units].sort((a, b) => b.root.length - a.root.length);
  const moduleUnit = new Map();
  for (const m of mods) {
    const parent = graph.parent(m.id);
    const p = m.path ?? '';
    const u = (parent?.type === 'package' ? units.find((x) => x.nodeIds[0] === parent.id) : null)
      ?? byRoot.find((x) => p === x.root || p.startsWith(`${x.root}/`));
    if (u) { moduleUnit.set(m.id, u.id); u.moduleCount++; }
  }
  units.sort((a, b) => b.moduleCount - a.moduleCount || a.name.localeCompare(b.name));
  return { units, moduleUnit, unitOf: new Map(units.map((u) => [u.nodeIds[0], u.id])) };
}

const memo = new WeakMap();

/**
 * Deployable, package and directory readings of "what are the containers". `primary` is
 * the first with content: deployables, else packages (2+), else directories.
 */
export function unitModel(graph) {
  if (memo.has(graph)) return memo.get(graph);
  const mods = appModules(graph);
  const deploy = deployUnits(graph);
  mapDeployModules(deploy, mods);
  const pkg = packageUnits(graph, mods);
  const dirs = directoryUnits(mods);
  let primary = dirs;
  let kind = 'directories';
  if (deploy.units.length) { primary = deploy; kind = 'deployables'; } else if (pkg.units.length >= 2) { primary = pkg; kind = 'packages'; }
  const model = { kind, primary, deploy, pkg, dirs };
  memo.set(graph, model);
  return model;
}

/** The unit (within a unit set) owning a node: a deployable itself, or a code node via its module. */
export function unitOf(graph, set, id) {
  const direct = set.unitOf.get(id);
  if (direct) return direct;
  const m = moduleOf(graph, id);
  return m ? set.moduleUnit.get(m.id) ?? null : null;
}

/**
 * Directed unit-to-unit edge weights for the given edge types.
 * @returns {Map<string, {from: string, to: string, count: number, types: Set<string>, edges: object[]}>}
 */
export function unitEdges(graph, set, types) {
  const out = new Map();
  for (const e of graph.edges()) {
    if (!types.includes(e.type)) continue;
    const a = unitOf(graph, set, e.from);
    const b = unitOf(graph, set, e.to);
    if (!a || !b || a === b) continue;
    const k = `${a}\0${b}`;
    let w = out.get(k);
    if (!w) out.set(k, (w = { from: a, to: b, count: 0, types: new Set(), edges: [] }));
    w.count += e.attrs?.calls ?? e.attrs?.count ?? 1;
    w.types.add(e.type);
    w.edges.push(e);
  }
  return out;
}

/** Edges that read or write a table, with the table and the acting node. */
export function dataAccess(graph) {
  const out = [];
  for (const e of graph.edges()) {
    if (!DATA_EDGES.includes(e.type)) continue;
    const t = graph.node(e.to);
    if (!t || !['table', 'collection', 'view'].includes(t.type)) continue;
    const a = graph.node(e.from);
    if (!a || a.type === 'migration') continue;
    out.push({ edge: e, table: t, actor: a, write: WRITE_EDGES.includes(e.type) });
  }
  return out;
}

/** Nodes facing the outside: ingress, gateways, load balancers, public endpoints and rules. */
export function publicEntries(graph) {
  const out = [];
  for (const n of graph.nodes()) {
    const a = n.attrs ?? {};
    if (['ingress', 'gateway'].includes(n.type) && a.internal !== true) out.push({ node: n, why: `${n.type} entry point` });
    else if (n.type === 'load_balancer' && a.internal !== true && a.scheme !== 'internal') out.push({ node: n, why: 'load balancer' });
    else if (n.type === 'endpoint' && (a.public === true || a.exposed === true)) out.push({ node: n, why: 'public endpoint' });
    else if (n.type === 'net_endpoint' && a.public === true) out.push({ node: n, why: 'public network endpoint' });
    else if (n.type === 'firewall_rule' && a.public_ingress === true) out.push({ node: n, why: `public ingress ${(a.ports ?? []).join(',') || 'any port'}` });
    else if (n.type === 'resource' && !a.drift && (a.public_ingress === true || a.public_principal === true)) out.push({ node: n, why: a.public_principal ? 'public principal' : 'public ingress' });
  }
  return out;
}

/** Why a role/policy is broader than least privilege (empty when it is not). */
export function riskyRole(n) {
  const a = n.attrs ?? {};
  const reasons = [];
  if (a.cluster_admin) reasons.push('cluster-admin');
  if (a.namespace_admin) reasons.push('namespace admin');
  if (a.admin) reasons.push('admin');
  if (a.wildcard_verbs || a.wildcard_resources === true) reasons.push('wildcard verbs or resources');
  if (Array.isArray(a.wildcard_actions) && a.wildcard_actions.length) reasons.push(`wildcard actions ${a.wildcard_actions.slice(0, 3).join(' ')}`);
  if (a.escalation_risk) reasons.push('privilege escalation');
  if (a.secrets_read) reasons.push('reads secrets');
  if (a.pods_exec) reasons.push('pod exec');
  return reasons;
}

/** Edges of any of the given types (Graph.edges takes a single type). */
export const edgesOf = (graph, types) => graph.edges().filter((e) => types.includes(e.type));

export const dedupe = (arr) => [...new Set(arr)];
