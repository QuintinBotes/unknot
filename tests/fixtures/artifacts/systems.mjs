// Hand-made fact sets for the artifact emitters: three synthetic systems (layered monolith,
// microservices with runtime calls, event-driven) plus builders for ad-hoc graphs.

import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';

export const P = prov({ source_type: 'ast', source_ref: 'fixture.ts:1', extractor: 'fixture@1' });
export const T = prov({ source_type: 'trace', source_ref: 'traces.json:1', extractor: 'fixture-traces@1' });
export const C = prov({ source_type: 'config', source_ref: 'deploy.yaml:1', extractor: 'fixture-config@1' });

export const mod = (path, attrs = {}) => nodeFact('module', path, { path, attrs: { language: 'typescript', ...attrs } }, P);
export const node = (type, key, { name, path, attrs } = {}, p = P) => nodeFact(type, key, { name, path, attrs }, p);
export const edge = (type, from, to, attrs = {}, p = P) => edgeFact(type, from, to, attrs, p);
export const imp = (a, b) => edge('IMPORTS', `module:${a}`, `module:${b}`);

/** controllers -> services -> repositories, strictly downward; a User table written by the repository. */
export function layeredMonolith() {
  const facts = [];
  const files = {
    controllers: ['orders', 'users'],
    services: ['orders', 'users'],
    repositories: ['orders', 'users'],
  };
  for (const [dir, names] of Object.entries(files)) for (const n of names) facts.push(mod(`src/${dir}/${n}.ts`));
  for (const n of files.controllers) facts.push(imp(`src/controllers/${n}.ts`, `src/services/${n}.ts`));
  for (const n of files.services) facts.push(imp(`src/services/${n}.ts`, `src/repositories/${n}.ts`));
  facts.push(node('table', 'public.orders', { name: 'public.orders' }));
  facts.push(edge('MUTATES', 'module:src/repositories/orders.ts', 'table:public.orders'));
  facts.push(edge('QUERIES', 'module:src/repositories/users.ts', 'table:public.orders'));
  return facts;
}

/** Four services with distinct manifests, traced calls (web -> orders -> payments -> ledger) and no shared state. */
export function microservices() {
  const facts = [];
  const names = ['web', 'orders', 'payments', 'ledger'];
  for (const n of names) {
    facts.push(node('service', n, { name: n }, T));
    facts.push(node('workload', `prod/Deployment/${n}`, { name: n, path: `deploy/${n}.yaml`, attrs: { namespace: 'prod', kind: 'Deployment', replicas: 2 } }, C));
  }
  const calls = [['web', 'orders', 900], ['orders', 'payments', 500], ['payments', 'ledger', 300], ['web', 'payments', 40]];
  for (const [a, b, n] of calls) facts.push(edge('RUNTIME_CALLS', `service:${a}`, `service:${b}`, { calls: n, p95_ms: 12, error_rate: 0.01 }, T));
  facts.push(node('table', 'orders.orders', { name: 'orders.orders' }));
  facts.push(edge('MUTATES', 'service:orders', 'table:orders.orders', {}, T));
  facts.push(node('table', 'ledger.entries', { name: 'ledger.entries' }));
  facts.push(edge('MUTATES', 'service:ledger', 'table:ledger.entries', {}, T));
  facts.push(node('ingress', 'prod/edge', { name: 'edge', attrs: { namespace: 'prod' } }, C));
  facts.push(edge('ROUTES_TO', 'ingress:prod/edge', 'workload:prod/Deployment/web', {}, C));
  return facts;
}

/** Same services, but shipped by one pipeline and writing one shared table. */
export function distributedMonolith() {
  const facts = microservices().filter((f) => !(f.kind === 'edge' && f.type === 'MUTATES'));
  facts.push(node('table', 'shared.accounts', { name: 'shared.accounts' }));
  for (const n of ['orders', 'payments', 'ledger']) facts.push(edge('MUTATES', `service:${n}`, 'table:shared.accounts', {}, T));
  facts.push(node('pipeline', 'release', { name: 'release' }, C));
  for (const n of ['web', 'orders', 'payments', 'ledger']) facts.push(edge('DEPLOYS', 'pipeline:release', `service:${n}`, {}, C));
  return facts;
}

/** Producers and consumers around two topics, no direct calls. */
export function eventDriven() {
  const facts = [];
  for (const n of ['checkout', 'inventory', 'shipping']) facts.push(node('service', n, { name: n }, T));
  facts.push(node('topic', 'order.placed', { name: 'order.placed' }));
  facts.push(node('topic', 'stock.reserved', { name: 'stock.reserved' }));
  facts.push(edge('PUBLISHES', 'service:checkout', 'topic:order.placed'));
  facts.push(edge('SUBSCRIBES', 'service:inventory', 'topic:order.placed'));
  facts.push(edge('PUBLISHES', 'service:inventory', 'topic:stock.reserved'));
  facts.push(edge('SUBSCRIBES', 'service:shipping', 'topic:stock.reserved'));
  return facts;
}
