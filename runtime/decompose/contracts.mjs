// Contract evidence for a set of modules: the routes that are written down somewhere other
// than in the handler. A route counts when
//   - a typed HTTP client (an interface or abstract type whose methods declare an HTTP method and route) declares it and a member declares
//     that interface, consumes it, or imports a module that declares it;
//   - a member exposes an endpoint some typed client in the graph declares (its callers use a
//     typed client);
//   - a member exposes an endpoint an OpenAPI or Pact file describes;
//   - a workspace map linked a client in another repository to an endpoint a member exposes, or a
//     client operation (or module) of the member to an endpoint another repository serves.
// `clients` per route is the number of distinct client interfaces declaring it.

import { operationKey } from '../graph/routes.mjs';

const isOp = (n) => n?.type === 'contract' && n.attrs?.kind === 'client_operation';

/**
 * @param {import('../graph/graph.mjs').Graph} graph
 * @param {Iterable<string>} ids module ids (or nodes whose children are modules) of the scope
 * @param {{links: {route: string, from_repo: string, from: string, to_repo: string, to: string}[], repository: string, mapped_at: string}|null} [workspace] cross-repository links from the last workspace map
 * @returns {{present: boolean, routes: {route: string, source: string, clients: number, interfaces: string[]}[], clients: number, evidence: string[]}}
 */
export function contractEvidence(graph, ids, workspace = null) {
  const scope = new Set(ids);
  // Members and everything they contain: a handler is a method inside a class inside the module.
  for (const id of scope) for (const c of graph.children(id)) scope.add(c.id);

  // Every typed client operation in the graph, by route key, with the interfaces declaring it.
  const ops = new Map();
  for (const n of graph.nodes('contract')) {
    if (!isOp(n)) continue;
    const key = operationKey(n);
    if (!key) continue;
    const e = ops.get(key) ?? { ids: [], interfaces: new Set() };
    e.ids.push(n.id);
    for (const d of graph.in(n.id, 'DEFINES')) e.interfaces.add(graph.node(d.from)?.name ?? d.from);
    ops.set(key, e);
  }

  const routes = new Map();
  const evidence = new Set();
  const add = (key, source, id, remote = null) => {
    const o = ops.get(key);
    const r = routes.get(key) ?? { route: key, source, clients: o?.interfaces.size ?? 0, interfaces: [...(o?.interfaces ?? [])].sort() };
    // A typed client is the stronger statement: it names who calls the route.
    if (source === 'client') r.source = 'client';
    if (remote) {
      // Evidence from another repository, as of the workspace map: who calls this route, or who serves it.
      r.workspace_mapped_at = workspace.mapped_at;
      if (remote.client) {
        r.client_repositories = [...new Set([...(r.client_repositories ?? []), remote.client])].sort();
        r.interfaces = [...new Set([...r.interfaces, (remote.consumer ?? remote.client)])].sort();
        r.clients = r.interfaces.length;
      } else r.served_by = [...new Set([...(r.served_by ?? []), remote.server])].sort();
    }
    routes.set(key, r);
    evidence.add(id);
  };

  // The member declares, consumes or imports a typed client.
  for (const id of scope) {
    const viaModules = [id, ...graph.out(id, 'IMPORTS').map((e) => e.to)];
    for (const m of viaModules) {
      for (const e of graph.out(m, 'CONSUMES')) {
        if (!isOp(graph.node(e.to))) continue;
        const key = operationKey(graph.node(e.to));
        if (key) add(key, 'client', e.id);
      }
    }
  }
  // The member serves a route a typed client declares, or one a contract file describes.
  for (const id of scope) {
    for (const e of graph.out(id, ['EXPOSES', 'PUBLISHES'])) {
      const ep = graph.node(e.to);
      if (ep?.type !== 'endpoint') continue;
      const key = operationKey(ep);
      if (!key) continue;
      if (ops.has(key)) add(key, 'client', e.id);
      else if (ep.attrs?.contract) add(key, 'openapi', e.id);
      else if (ep.attrs?.from_contract) add(key, 'schema', e.id);
      else if (ep.attrs?.contract_tested) add(key, 'pact', e.id);
    }
  }

  // A channel is a declared seam for either side. Distinct consuming modules, never
  // publishers or repeated calls, supply its clients/consumers count.
  for (const id of scope) {
    for (const e of graph.out(id, ['PUBLISHES', 'CONSUMES'])) {
      const channel = graph.node(e.to);
      if (channel?.attrs?.kind !== 'messaging_channel') continue;
      const consumers = [...new Set(graph.in(e.to, 'CONSUMES').map((c) => c.from))].sort();
      const key = e.to.slice('contract:'.length);
      routes.set(key, { route: key, source: 'messaging', clients: consumers.length, interfaces: consumers,
        consumers: consumers.length, consumer_modules: consumers,
        ...(channel.attrs.channel_unresolved ? { channel_unresolved: true } : {}) });
      evidence.add(e.id);
    }
  }

  // Links from a workspace map: the repository's own side of each cross-repository route.
  if (workspace?.links?.length) {
    const calls = new Map();
    const served = new Map();
    for (const l of workspace.links) {
      if (l.from_repo === workspace.repository) (calls.get(l.from) ?? calls.set(l.from, []).get(l.from)).push(l);
      if (l.to_repo === workspace.repository) (served.get(l.to) ?? served.set(l.to, []).get(l.to)).push(l);
    }
    for (const id of scope) {
      for (const m of [id, ...graph.out(id, 'IMPORTS').map((e) => e.to)]) {
        for (const l of [...(calls.get(m) ?? []), ...graph.children(m).flatMap((c) => calls.get(c.id) ?? []), ...graph.out(m, 'CONSUMES').flatMap((e) => calls.get(e.to) ?? [])]) {
          const key = l.route;
          add(key, l.kind === 'messaging' ? 'messaging' : 'client', `workspace:${l.from_repo}->${l.to_repo}:${l.to}`, { server: l.to_repo });
        }
      }
      for (const e of graph.out(id, ['EXPOSES', 'PUBLISHES'])) {
        for (const l of served.get(e.to) ?? []) {
          const key = l.route;
          add(key, l.kind === 'messaging' ? 'messaging' : 'client', `workspace:${l.from_repo}->${l.to_repo}:${l.to}`, { client: l.from_repo, ...(l.kind === 'messaging' ? { consumer: `${l.from_repo}:${l.from}` } : {}) });
        }
      }
    }
  }

  for (const r of routes.values()) if (r.source === 'messaging') { r.consumers = r.clients; r.consumer_modules = [...r.interfaces]; }
  const list = [...routes.values()].sort((a, b) => (a.route < b.route ? -1 : 1));
  const interfaces = new Set(list.flatMap((r) => r.interfaces));
  return { present: list.length > 0, routes: list, clients: interfaces.size, evidence: [...evidence].sort() };
}
