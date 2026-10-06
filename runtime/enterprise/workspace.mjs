// Multi-repository workspaces (spec §2.1: "explicitly linked repository sets").
//
// Every repository keeps its own `.unknot` store, keys and ledger; the workspace root
// project only holds the combined graph and the cross-repository campaigns. Repositories
// are linked by configuration, never discovered, so mapping one cannot reach a directory
// nobody listed.
//
// Combined-graph node ids encode the repository in the key so the node types stay valid:
// `module:src/a.ts` in repository `billing` becomes `module:billing:src/a.ts`. Repository
// names cannot contain ':' (config schema), so the form is unambiguous.

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { isInside, realpathLenient } from '../core/paths.mjs';
import { UNKNOT_DIR, isInitialized } from '../core/project.mjs';
import { openProject } from '../context.mjs';
import { Graph } from '../graph/graph.mjs';
import { routeKey, routeKeyOfId } from '../graph/routes.mjs';
import { mapRepository } from '../graph/builder.mjs';
import { createCampaign } from '../plan/campaign.mjs';
import { loadConfig } from '../policy/config.mjs';
import { casGet, casPut } from '../state/cas.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { catalogSummary } from './catalog.mjs';

export const WORKSPACE_GRAPH_META = 'workspace_graph';
export const WORKSPACE_GRAPH_FORMAT = 'unknot.workspace-graph';

/** Node types kept in the combined graph. Function-level detail stays in each repository's own store. */
const COARSE_TYPES = new Set([
  'package', 'module', 'dependency', 'build_target', 'endpoint', 'topic', 'queue', 'event', 'job', 'service',
  'deployable', 'workload', 'database', 'schema', 'table', 'collection', 'store', 'team', 'owner', 'contract',
]);
const TABLE_ACCESS = new Set(['QUERIES', 'MUTATES', 'READS', 'WRITES']);

export const qualify = (repo, id) => {
  const i = id.indexOf(':');
  return `${id.slice(0, i)}:${repo}:${id.slice(i + 1)}`;
};

/** Inverse of {@link qualify}: `{type, repo, local}` for a combined-graph id. */
export function unqualify(id) {
  const a = id.indexOf(':');
  const b = id.indexOf(':', a + 1);
  return { type: id.slice(0, a), repo: id.slice(a + 1, b), local: `${id.slice(0, a)}:${id.slice(b + 1)}` };
}

// ---- repositories ----

/**
 * Resolve `config.workspace.repositories` against the workspace root. Each must be the
 * root of a git repository, distinct from the workspace root and from each other.
 * Relative paths may use `..` (sibling checkouts are the normal layout); they are the
 * user's explicit, committed choice, and the git-root requirement keeps them from
 * pointing at an arbitrary directory.
 */
export function resolveRepositories(rootCtx, config) {
  const out = [];
  for (const r of config.workspace?.repositories ?? []) {
    if (out.some((o) => o.name === r.name)) throw new UnknotError('UK_CONFIG_INVALID', `workspace repository ${r.name} is listed twice`);
    if (r.path.includes('\0')) throw new UnknotError('UK_CONFIG_INVALID', `workspace repository ${r.name} has an invalid path`);
    const abs = realpathLenient(resolve(rootCtx.root, r.path));
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new UnknotError('UK_NOT_FOUND', `workspace repository ${r.name}: ${abs} is not a directory`);
    if (!existsSync(join(abs, '.git'))) throw new UnknotError('UK_CONFIG_INVALID', `workspace repository ${r.name}: ${abs} is not the root of a git repository`);
    if (abs === rootCtx.root) throw new UnknotError('UK_CONFIG_INVALID', `workspace repository ${r.name} is the workspace root itself`);
    const clash = out.find((o) => isInside(o.path, abs) || isInside(abs, o.path));
    if (clash) throw new UnknotError('UK_CONFIG_INVALID', `workspace repositories ${clash.name} and ${r.name} overlap`);
    out.push({ name: r.name, path: abs, configured_path: r.path, remote: r.remote ?? null });
  }
  return out;
}

/** Open (creating if needed) a linked repository's own project. */
function openRepo(repo) {
  // Pin the project root to the repository itself: findProjectRoot prefers the nearest
  // `.unknot`, so without this a repository nested under a directory that has its own
  // `.unknot` would be mapped as that directory.
  if (!isInitialized(repo.path)) mkdirSync(join(repo.path, UNKNOT_DIR), { recursive: true });
  const ctx = openProject(repo.path, { create: true });
  if (realpathLenient(ctx.root) !== repo.path) {
    throw new UnknotError('UK_CONFIG_INVALID', `workspace repository ${repo.name} resolved to project root ${ctx.root}, expected ${repo.path}`);
  }
  return ctx;
}

/** Per-repository status without creating anything. */
export function listWorkspace(rootCtx, config) {
  return resolveRepositories(rootCtx, config).map((repo) => {
    const initialized = isInitialized(repo.path) && existsSync(join(repo.path, UNKNOT_DIR, 'state', 'unknot.db'));
    let meta = {};
    if (initialized) {
      const ctx = openProject(repo.path, { readOnly: true });
      meta = { project_id: ctx.projectId ?? null, generation: Number(ctx.store.meta('generation') ?? 0), mapped_commit: ctx.store.meta('mapped_commit') || null, mapped_at: ctx.store.meta('mapped_at') };
    }
    return { name: repo.name, path: repo.path, remote: repo.remote, initialized, ...meta };
  });
}

// ---- cross-repository inference ----

const normPkg = (n) => String(n).toLowerCase().replace(/[_.]+/g, '-');
const normTable = (id) => id.toLowerCase().replace(/^table:(?:public\.)?/, '');
const bump = (map, key, make) => {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
};

/**
 * Combine per-repository graphs into one and infer the edges between repositories.
 * @param {Map<string, Graph>} graphs repository name to its graph
 * @returns {{graph: Graph, analysis: object}}
 */
export function buildWorkspaceGraph(graphs) {
  const out = new Graph();
  const names = [...graphs.keys()].sort();
  const ensure = (repo, localId) => {
    const g = graphs.get(repo);
    const id = qualify(repo, localId);
    if (out.node(id)) return id;
    const n = g.node(localId);
    if (!n) return null;
    out.addNode(id, n.type, { name: n.name, path: n.path, attrs: { ...n.attrs, repo, local_id: localId }, label: n.label });
    return id;
  };

  for (const repo of names) {
    out.addNode(`repository:${repo}`, 'repository', { name: repo, attrs: { repo } });
    const g = graphs.get(repo);
    for (const n of g.nodes()) if (COARSE_TYPES.has(n.type)) ensure(repo, n.id);
    for (const e of g.edges()) {
      const from = out.node(qualify(repo, e.from)) ? qualify(repo, e.from) : null;
      const to = out.node(qualify(repo, e.to)) ? qualify(repo, e.to) : null;
      if (from && to) out.addEdge(e.type, from, to, { ...e.attrs, repo });
    }
  }

  const cross = [];
  const link = (type, fromRepo, fromLocal, toRepo, toLocal, via, extra = {}) => {
    const from = ensure(fromRepo, fromLocal);
    const to = ensure(toRepo, toLocal);
    if (!from || !to) return;
    out.addEdge(type, from, to, { cross_repo: true, via, from_repo: fromRepo, to_repo: toRepo, ...extra });
    cross.push({ type, via, from_repo: fromRepo, to_repo: toRepo, detail: extra.detail ?? null });
  };

  // Packages: a repository's named `package:` node imported as `dependency:<name>` elsewhere.
  const provided = new Map();
  for (const repo of names) {
    for (const p of graphs.get(repo).nodes('package')) if (p.attrs?.name) bump(provided, normPkg(p.attrs.name), () => []).push({ repo, id: p.id, name: p.attrs.name });
  }
  for (const repo of names) {
    for (const e of graphs.get(repo).edges()) {
      if ((e.type !== 'DEPENDS_ON' && e.type !== 'IMPORTS') || !e.to.startsWith('dependency:')) continue;
      const name = e.to.slice('dependency:'.length);
      for (const prov of provided.get(normPkg(name)) ?? []) {
        if (prov.repo !== repo) link('DEPENDS_ON', repo, e.from, prov.repo, prov.id, 'package', { detail: prov.name });
      }
    }
  }

  // Contracts: an endpoint EXPOSED in one repository and CONSUMED or CALLED in another. Routes
  // match on method plus path template, so `{id}` and `{orderId}`, a missing leading slash, a
  // trailing slash and the case of the method make no difference; an endpoint served for ANY
  // method answers every client method. Anything else (a catalog `endpoint:api:x`) matches by id.
  const exposed = new Map();
  const matchKey = (id) => routeKeyOfId(id) ?? id;
  for (const repo of names) {
    for (const e of graphs.get(repo).edges('EXPOSES')) {
      if (e.to.startsWith('endpoint:')) bump(exposed, matchKey(e.to), () => new Map()).set(repo, e.to);
    }
  }
  const providers = (key) => {
    const any = key.includes(' /') ? exposed.get(`ANY ${key.slice(key.indexOf(' /') + 1)}`) : null;
    return new Map([...(any ?? []), ...(exposed.get(key) ?? [])]);
  };
  for (const repo of names) {
    for (const e of [...graphs.get(repo).edges('CONSUMES'), ...graphs.get(repo).edges('CALLS')]) {
      if (!e.to.startsWith('endpoint:')) continue;
      for (const [provider, endpoint] of providers(matchKey(e.to))) if (provider !== repo) link('CONSUMES', repo, e.from, provider, endpoint, 'contract', { detail: endpoint.slice('endpoint:'.length) });
    }
  }
  // A typed client operation (`contract` node) links to the endpoint that serves it, in this or another repository.
  const clientOps = { total: 0, linked: 0, internal: 0, unmatched: [] };
  for (const repo of names) {
    const g = graphs.get(repo);
    for (const op of g.nodes('contract')) {
      if (op.attrs?.kind !== 'client_operation') continue;
      const key = routeKey(op.attrs.method, op.attrs.path);
      if (!key) continue;
      clientOps.total++;
      const found = providers(key);
      let linkedHere = false;
      for (const [provider, endpoint] of found) {
        if (provider === repo) continue;
        linkedHere = true;
        const from = ensure(repo, op.id);
        const to = ensure(provider, endpoint);
        if (!from || !to) continue;
        out.addEdge('CONSUMES', from, to, { cross_repo: true, via: 'contract', from_repo: repo, to_repo: provider, detail: key, route: key, client_operation: op.id.slice('contract:'.length) });
        cross.push({ type: 'CONSUMES', via: 'contract', from_repo: repo, to_repo: provider, detail: key });
      }
      if (linkedHere) clientOps.linked++;
      else if (found.has(repo)) clientOps.internal++;
      else {
        const interfaces = g.in(op.id, 'DEFINES').map((d) => g.node(d.from)).filter(Boolean);
        clientOps.unmatched.push({ repo, route: key, operation: op.id, interfaces: interfaces.map((n) => n.name).sort(), paths: interfaces.map((n) => n.path).filter(Boolean).sort() });
      }
    }
  }
  clientOps.unmatched.sort((a, b) => `${a.repo} ${a.route}`.localeCompare(`${b.repo} ${b.route}`));

  // Messaging: PUBLISHES in one repository, SUBSCRIBES in another, same topic or queue id.
  const published = new Map();
  for (const repo of names) {
    for (const e of graphs.get(repo).edges('PUBLISHES')) bump(published, e.to, () => new Set()).add(repo);
  }
  for (const repo of names) {
    for (const e of graphs.get(repo).edges('SUBSCRIBES')) {
      for (const publisher of published.get(e.to) ?? []) if (publisher !== repo) link('SUBSCRIBES', repo, e.from, publisher, e.to, 'topic', { detail: e.to });
    }
  }

  // Shared tables: the same table touched from more than one repository means a shared database.
  const tables = new Map();
  for (const repo of names) {
    const g = graphs.get(repo);
    for (const e of g.edges()) {
      if (!TABLE_ACCESS.has(e.type) || !e.to.startsWith('table:')) continue;
      const t = bump(tables, normTable(e.to), () => new Map());
      bump(t, repo, () => ({ ids: new Set(), access: new Set(), edges: [] }));
      const r = t.get(repo);
      r.ids.add(e.to);
      r.access.add(e.type);
      r.edges.push(e);
    }
  }
  const sharedTables = [];
  for (const [key, byRepo] of [...tables].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (byRepo.size < 2) continue;
    const repos = [...byRepo.keys()].sort();
    const owner = repos.find((r) => {
      const g = graphs.get(r);
      return [...byRepo.get(r).ids].some((id) => ['OWNS_DATA', 'OWNS_SCHEMA', 'MIGRATES', 'MIGRATED_BY'].some((t) => g.in(id, t).length || g.out(id, t).length));
    }) ?? repos[0];
    const ownerId = [...byRepo.get(owner).ids].sort()[0];
    for (const r of repos.filter((x) => x !== owner)) {
      for (const e of byRepo.get(r).edges) link(e.type, r, e.from, owner, ownerId, 'shared_table', { detail: key });
    }
    sharedTables.push({ table: key, owner_repo: owner, shared_database: true, repos: repos.map((r) => ({ repo: r, access: [...byRepo.get(r).access].sort() })) });
  }

  // Roll the edges up into repository-to-repository dependencies and release hints.
  const rollup = new Map();
  const hints = new Map();
  for (const c of cross) {
    const k = `${c.from_repo}\0${c.to_repo}`;
    const r = bump(rollup, k, () => ({ from: c.from_repo, to: c.to_repo, via: new Set(), edges: 0 }));
    r.via.add(c.via);
    r.edges++;
    // The provider releases first for packages and contracts; a topic's publisher defines the message.
    const lockstep = c.via === 'shared_table';
    const before = lockstep ? [c.from_repo, c.to_repo].sort()[0] : c.to_repo;
    const after = lockstep ? [c.from_repo, c.to_repo].sort()[1] : c.from_repo;
    const h = bump(hints, `${c.via}\0${before}\0${after}`, () => ({ kind: lockstep ? 'lockstep' : 'ordered', via: c.via, before, after, items: new Set() }));
    if (c.detail) h.items.add(c.detail);
  }
  const byType = {};
  const byVia = {};
  for (const c of cross) {
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    byVia[c.via] = (byVia[c.via] ?? 0) + 1;
  }
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const analysis = {
    cross_repo_edges: { total: cross.length, by_type: sortObj(byType), by_via: sortObj(byVia) },
    repo_dependencies: [...rollup.values()].map((r) => ({ from: r.from, to: r.to, via: [...r.via].sort(), edges: r.edges })).sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`)),
    client_operations: { total: clientOps.total, linked: clientOps.linked, internal: clientOps.internal, unmatched: clientOps.unmatched },
    shared_tables: sharedTables,
    shared_database: sharedTables.length > 0,
    release_coupling: [...hints.values()]
      .map((h) => ({
        kind: h.kind,
        via: h.via,
        before: h.before,
        after: h.after,
        items: [...h.items].sort().slice(0, 20),
        hint: h.kind === 'lockstep'
          ? `${h.before} and ${h.after} share database tables (${[...h.items].sort().slice(0, 5).join(', ')}); release schema changes together or expand-then-contract`
          : `release ${h.before} before ${h.after}: ${h.after} depends on its ${h.via}${h.items.size ? ` (${[...h.items].sort().slice(0, 5).join(', ')})` : ''}`,
      }))
      .sort((a, b) => `${a.via}${a.before}${a.after}`.localeCompare(`${b.via}${b.before}${b.after}`)),
    catalog: catalogSummary(out),
  };
  return { graph: out, analysis };
}

// ---- persistence ----

/** Serialise the combined graph. Repository facts (commit, generation) come from `repositories`. */
export function graphToDocument(graph, analysis, repositories) {
  return {
    format: WORKSPACE_GRAPH_FORMAT,
    version: 1,
    generated_at: nowISO(),
    repositories,
    analysis,
    nodes: graph.nodes().map((n) => ({ id: n.id, type: n.type, name: n.name, path: n.path, attrs: n.attrs, label: n.label })),
    edges: graph.edges().map((e) => ({ id: e.id, type: e.type, from: e.from, to: e.to, attrs: e.attrs })),
  };
}

export function graphFromDocument(doc) {
  const g = new Graph();
  for (const n of doc.nodes) g.addNode(n.id, n.type, { name: n.name, path: n.path, attrs: n.attrs, label: n.label });
  for (const e of doc.edges) g.addEdge(e.type, e.from, e.to, e.attrs);
  return g;
}

/** Load the last combined graph stored in the workspace root's CAS, or null. */
export function loadWorkspaceGraph(rootCtx) {
  const d = rootCtx.store.meta(WORKSPACE_GRAPH_META);
  if (!d) return null;
  const doc = JSON.parse(casGet(rootCtx, d).toString('utf8'));
  if (doc.format !== WORKSPACE_GRAPH_FORMAT) throw new UnknotError('UK_INTEGRITY', 'stored workspace graph has an unknown format');
  return doc;
}

/** Map every linked repository into its own store, then build and store the combined graph. */
export async function mapWorkspace(rootCtx, { config, history = true } = {}) {
  const repos = resolveRepositories(rootCtx, config);
  if (!repos.length) throw new UnknotError('UK_CONFIG_INVALID', 'no repositories listed under workspace.repositories in .unknot/config.yaml');
  const graphs = new Map();
  const repositories = [];
  for (const repo of repos) {
    const ctx = openRepo(repo);
    const cfg = loadConfig(ctx);
    const s = await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest, history });
    graphs.set(repo.name, Graph.fromStore(ctx.store));
    repositories.push({ name: repo.name, path: repo.path, remote: repo.remote, project_id: ctx.projectId, commit: s.commit, generation: s.generation, status: s.status, files: s.files, nodes: s.nodes, edges: s.edges, failure_count: s.failure_count });
  }
  const { graph, analysis } = buildWorkspaceGraph(graphs);
  const doc = graphToDocument(graph, analysis, repositories);
  const digest = casPut(rootCtx, JSON.stringify(doc), { mediaType: 'application/json', label: WORKSPACE_GRAPH_META });
  rootCtx.store.meta(WORKSPACE_GRAPH_META, digest);
  rootCtx.store.meta('workspace_graph_at', doc.generated_at);
  appendEvent(rootCtx, {
    type: 'workspace.mapped',
    actor: 'runtime:workspace',
    payload: { repositories: repositories.map((r) => ({ name: r.name, commit: r.commit, generation: r.generation })), cross_repo_edges: analysis.cross_repo_edges.total, shared_tables: analysis.shared_tables.length, digest },
  });
  return { digest, repositories, analysis, nodes: doc.nodes.length, edges: doc.edges.length };
}

/** The summary `unknot workspace graph` prints. */
export function summarizeWorkspace(doc) {
  const a = doc.analysis;
  return {
    generated_at: doc.generated_at,
    repositories: doc.repositories.map(({ name, commit, generation, status, nodes, edges }) => ({ name, commit, generation, status, nodes, edges })),
    cross_repo_edges: a.cross_repo_edges,
    client_operations: a.client_operations ?? { total: 0, linked: 0, internal: 0, unmatched: [] },
    repo_dependencies: a.repo_dependencies,
    shared_tables: a.shared_tables,
    shared_database: a.shared_database,
    release_coupling: a.release_coupling,
    catalog: a.catalog,
  };
}

// ---- campaigns ----

/**
 * One campaign in the workspace root spanning several repositories. Each slice draft names
 * its repository; its scope is prefixed `<repo>/` so approvals bind to the repository it
 * touches, and `sources` records the findings it came from. Drafts stay sequential unless they
 * say otherwise, because createCampaign chains them.
 * @param {object} rootCtx workspace root project context
 * @param {{config: object, actor: string, objective: string, drafts: {repo: string, objective: string, scope: string[], [k: string]: any}[], constraints?: string[], rationale?: string}} req
 */
export function planWorkspaceCampaign(rootCtx, { config, actor, objective, drafts, constraints = [], rationale }) {
  const repos = new Set(resolveRepositories(rootCtx, config).map((r) => r.name));
  if (!Array.isArray(drafts) || !drafts.length) throw new UnknotError('UK_SCHEMA_INVALID', 'a workspace campaign needs at least one slice draft');
  const slices = drafts.map((d) => {
    if (!repos.has(d.repo)) throw new UnknotError('UK_CONFIG_INVALID', `slice "${d.objective}" names repository ${d.repo}, which is not listed in workspace.repositories`);
    const prefix = (p) => {
      if (p.startsWith('/') || p.split('/').includes('..')) throw new UnknotError('UK_SCOPE_VIOLATION', `slice scope ${p} must be relative to repository ${d.repo}`);
      return `${d.repo}/${p.replace(/^\.\//, '')}`;
    };
    const { repo, scope, ...rest } = d;
    return {
      ...rest,
      scope: { include: (scope?.include ?? scope ?? []).map(prefix), exclude: (scope?.exclude ?? []).map(prefix) },
      // `sources` holds finding or decomposition ids from the repository's own store (the
      // slice schema only admits ids); the repository itself is recorded in the scope
      // prefix and the rationale.
      sources: d.sources ?? [],
      rationale: `[repo ${repo}] ${d.rationale ?? d.objective}`,
    };
  });
  return createCampaign(rootCtx, {
    config,
    actor,
    objective,
    constraints,
    scope: [...new Set(slices.flatMap((s) => s.scope.include))].slice(0, 50),
    proposal: { slices, rationale: rationale ?? `Multi-repository campaign across ${[...new Set(drafts.map((d) => d.repo))].join(', ')}` },
  });
}
