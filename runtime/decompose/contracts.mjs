// Contract evidence for a set of modules: the routes that are written down somewhere other
// than in the handler. A route counts when
//   - a typed HTTP client interface (Refit, Feign, Retrofit) declares it and a member declares
//     that interface, consumes it, or imports a module that declares it;
//   - a member exposes an endpoint some typed client in the graph declares (its callers use a
//     typed client);
//   - a member exposes an endpoint an OpenAPI or Pact file describes.
// `clients` per route is the number of distinct client interfaces declaring it.

import { routeKey, routeKeyOfId } from '../graph/routes.mjs';

const isOp = (n) => n?.type === 'contract' && n.attrs?.kind === 'client_operation';

/**
 * @param {import('../graph/graph.mjs').Graph} graph
 * @param {Iterable<string>} ids module ids (or nodes whose children are modules) of the scope
 * @returns {{present: boolean, routes: {route: string, source: string, clients: number, interfaces: string[]}[], clients: number, evidence: string[]}}
 */
export function contractEvidence(graph, ids) {
  const scope = new Set(ids);
  // Members and everything they contain: a handler is a method inside a class inside the module.
  for (const id of scope) for (const c of graph.children(id)) scope.add(c.id);

  // Every typed client operation in the graph, by route key, with the interfaces declaring it.
  const ops = new Map();
  for (const n of graph.nodes('contract')) {
    if (!isOp(n)) continue;
    const key = routeKey(n.attrs.method, n.attrs.path);
    if (!key) continue;
    const e = ops.get(key) ?? { ids: [], interfaces: new Set() };
    e.ids.push(n.id);
    for (const d of graph.in(n.id, 'DEFINES')) e.interfaces.add(graph.node(d.from)?.name ?? d.from);
    ops.set(key, e);
  }

  const routes = new Map();
  const evidence = new Set();
  const add = (key, source, id) => {
    const o = ops.get(key);
    const r = routes.get(key) ?? { route: key, source, clients: o?.interfaces.size ?? 0, interfaces: [...(o?.interfaces ?? [])].sort() };
    // A typed client is the stronger statement: it names who calls the route.
    if (source === 'client') r.source = 'client';
    routes.set(key, r);
    evidence.add(id);
  };

  // The member declares, consumes or imports a typed client.
  for (const id of scope) {
    const viaModules = [id, ...graph.out(id, 'IMPORTS').map((e) => e.to)];
    for (const m of viaModules) {
      for (const e of graph.out(m, 'CONSUMES')) {
        if (!isOp(graph.node(e.to))) continue;
        const key = routeKeyOfId(e.to);
        if (key) add(key, 'client', e.id);
      }
    }
  }
  // The member serves a route a typed client declares, or one a contract file describes.
  for (const id of scope) {
    for (const e of graph.out(id, 'EXPOSES')) {
      const ep = graph.node(e.to);
      if (ep?.type !== 'endpoint') continue;
      const key = routeKeyOfId(ep.id) ?? routeKey(ep.attrs?.method, ep.attrs?.path);
      if (!key) continue;
      if (ops.has(key)) add(key, 'client', e.id);
      else if (ep.attrs?.contract) add(key, 'openapi', e.id);
      else if (ep.attrs?.contract_tested) add(key, 'pact', e.id);
    }
  }

  const list = [...routes.values()].sort((a, b) => (a.route < b.route ? -1 : 1));
  const interfaces = new Set(list.flatMap((r) => r.interfaces));
  return { present: list.length > 0, routes: list, clients: interfaces.size, evidence: [...evidence].sort() };
}
