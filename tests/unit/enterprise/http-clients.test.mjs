// Typed HTTP clients as contracts: Refit, Feign and Retrofit interfaces become `contract`
// facts, decompose treats them as contract evidence, and a workspace map links a client
// operation in one repository to the endpoint that serves it in another.

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;

const { default: generic } = await import('../../../adapters/language/generic/index.mjs');
const { openProject } = await import('../../../runtime/context.mjs');
const { loadConfig } = await import('../../../runtime/policy/config.mjs');
const { mapRepository } = await import('../../../runtime/graph/builder.mjs');
const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { boundaryMetrics } = await import('../../../runtime/decompose/candidates.mjs');
const { scopeSignals } = await import('../../../runtime/diagnose/signals.mjs');
const { selectTreatment } = await import('../../../runtime/decompose/select.mjs');
const { routeKey, routeKeyOfId } = await import('../../../runtime/graph/routes.mjs');
const { stringifyYAML } = await import('../../../runtime/core/yaml.mjs');
const { buildWorkspaceGraph, graphFromDocument, loadWorkspaceGraph, mapWorkspace } = await import('../../../runtime/enterprise/workspace.mjs');

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'clients');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

function materialize(parent, name) {
  const dir = join(parent, name);
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const extract = (path, text) => generic.extract({ path }, text, {});
const contracts = (facts) => facts.filter((f) => f.kind === 'node' && f.type === 'contract');

test('route keys ignore parameter names, slashes, query strings and method case', () => {
  assert.equal(routeKey('get', '/v1/orders/{id}'), 'GET /v1/orders/:');
  assert.equal(routeKey('GET', 'v1/orders/{orderId}/'), 'GET /v1/orders/:');
  assert.equal(routeKey('GET', '/v1/orders/:id?x=1'), 'GET /v1/orders/:');
  assert.equal(routeKey('GET', '/v1/orders/{id:guid}'), 'GET /v1/orders/:');
  assert.notEqual(routeKey('GET', '/v1/orders/{id}'), routeKey('POST', '/v1/orders/{id}'));
  assert.notEqual(routeKey('GET', '/v1/orders/{id}'), routeKey('GET', '/v1/orders'));
  assert.equal(routeKeyOfId('endpoint:GET /v1/orders/:orderId'), 'GET /v1/orders/:');
  assert.equal(routeKeyOfId('contract:app:GET /v1/orders/:id'), 'GET /v1/orders/:');
  assert.equal(routeKeyOfId('endpoint:api:catalog'), null);
});

test('Refit: one contract per interface, one per route, consumed by the declaring module', () => {
  const path = 'src/Clients/IOrdersApi.cs';
  const facts = extract(path, readFileSync(join(FIXTURES, 'orders-client', path), 'utf8'));
  const [iface, ...ops] = contracts(facts);
  assert.equal(iface.id, `contract:${path}#IOrdersApi`);
  assert.equal(iface.attrs.kind, 'http_client');
  assert.equal(iface.attrs.framework, 'refit');
  assert.deepEqual(iface.attrs.operations.map((o) => `${o.method} ${o.path}`), ['GET /v1/orders/:id', 'POST /v1/orders', 'DELETE /v1/orders/:id', 'GET /v1/orders/:id/history']);
  assert.deepEqual(iface.attrs.operations.map((o) => o.name), ['GetAsync', 'CreateAsync', 'CancelAsync', 'HistoryAsync']);
  assert.equal(ops.length, 4);
  assert.ok(ops.every((o) => o.attrs.kind === 'client_operation'));
  const edge = (type, to) => facts.some((f) => f.kind === 'edge' && f.type === type && f.to === to);
  assert.ok(edge('CONSUMES', 'contract:GET /v1/orders/:id'), '[Headers] is ignored; the Get attribute names the route');
  assert.ok(edge('CONSUMES', 'contract:POST /v1/orders'));
  assert.ok(edge('DEFINES', 'contract:GET /v1/orders/:id/history'), 'the query string is not part of the route');
  assert.equal(facts.filter((f) => f.type === 'endpoint').length, 0, 'a client is not an endpoint');
});

test('Feign and Retrofit interfaces are clients; a controller, JAX-RS resource and plain interface are not', () => {
  const java = `@FeignClient(name = "orders", path = "/v1")
public interface OrdersClient {
  @GetMapping("/orders/{id}")
  Order get(@PathVariable("id") String id);
  @RequestMapping(method = RequestMethod.POST, value = "/orders")
  Order create(Order o);
  @RequestLine("DELETE /orders/{id}")
  void cancel(String id);
}
interface Api { @GET("orders/{id}/history") Call<History> history(@Path("id") String id); }
interface Resource { @GET @Path("x") String g(); }
interface Plain { void run(); }
@RestController
class Ctl { @GetMapping("/served") String s() { return ""; } }
`;
  const facts = extract('src/Clients.java', java);
  const ifaces = contracts(facts).filter((c) => c.attrs.kind === 'http_client');
  assert.deepEqual(ifaces.map((c) => [c.name, c.attrs.framework]), [['OrdersClient', 'feign'], ['Api', 'retrofit']]);
  assert.deepEqual(ifaces[0].attrs.operations.map((o) => `${o.method} ${o.path}`), ['GET /v1/orders/:id', 'POST /v1/orders', 'DELETE /v1/orders/:id']);
  assert.deepEqual(ifaces[1].attrs.operations.map((o) => `${o.method} ${o.path}`), ['GET /orders/:id/history']);
  assert.deepEqual(facts.filter((f) => f.type === 'endpoint').map((f) => f.id), ['endpoint:GET /served']);
});

async function mapped(dir) {
  const ctx = openProject(dir, { create: true });
  const cfg = loadConfig(ctx);
  await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest, history: false });
  return { ctx, graph: Graph.fromStore(ctx.store) };
}

test('decompose: a candidate whose members use a typed client has contracts.present, the routes and clients per route', { timeout: 120_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'uk-clients-'));
  const { graph } = await mapped(materialize(parent, 'orders-client'));
  const service = 'module:src/Orders/OrderService.cs';
  const client = 'module:src/Clients/IOrdersApi.cs';
  assert.ok(graph.node(service) && graph.node(client));
  const run = (members) => boundaryMetrics(graph, new Set(members), { tableOwners: new Map(), sccs: [], candidateOf: () => null, self: 0 });

  // The caller imports the module that declares the client.
  const caller = run([service]);
  assert.equal(caller.metrics['contracts.present'], 1);
  assert.equal(caller.metrics['clients.count'], 1);
  assert.deepEqual(caller.details.contracts.map((r) => [r.route, r.clients, r.source]), [
    ['DELETE /v1/orders/:', 1, 'client'], ['GET /v1/orders/:', 1, 'client'], ['GET /v1/orders/:/history', 1, 'client'], ['POST /v1/orders', 1, 'client'],
  ].map(([r, c, s]) => [r, c, s]));
  assert.ok(caller.details.evidence['contracts.present'].length > 0);
  // The module that declares it has them too.
  assert.equal(run([client]).metrics['contracts.present'], 1);
  assert.equal(scopeSignals(graph, [client])['contracts.present'], 1);

  // With no contract and no client the evidence stays missing, never defaulted.
  const bare = Graph.fromFacts([]);
  assert.equal(scopeSignals(bare, [])['contracts.present'], 0);

  // Extraction is no longer rejected for missing contracts once a client names the routes.
  const signals = { 'tests.present': 3, 'boundary.robust': 1, 'cycle.size': 0, 'boundary.shared_table_writers': 0, 'boundary.cross_joins': 0, 'boundary.cross_transactions': 0, 'ownership.alignment': 0.95, 'module.co_change_leak': 0.05, 'boundary.reverse_deps': 0, 'boundary.calls_per_request_p95': 1, 'requests.interceptable': 1, 'traces.available': 1, 'layer.violations': 2, 'boundary.interface_count': 3, 'boundary.size': 8, 'owners.count': 1, 'driver.any': 1 };
  const reasons = (extra) => selectTreatment({ target: 'backend', signals: { ...signals, ...extra }, drivers: ['independent_deploy'] }).rejected_treatments.map((x) => x.reason).join('\n');
  assert.match(reasons({}), /evidence missing: [^\n]*contracts\.present/);
  assert.match(reasons({ 'contracts.present': 0 }), /failed: contracts\.present=0/);
  assert.doesNotMatch(reasons(caller.metrics), /contracts\.present/);
});

test('decompose: a candidate serving a route a typed client declares has contracts.present', { timeout: 120_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'uk-clients-'));
  const dir = materialize(parent, 'orders-server');
  // The server repository also holds the client interface that calls it (an in-process caller).
  const both = join(parent, 'both');
  cpSync(dir, both, { recursive: true });
  cpSync(join(FIXTURES, 'orders-client', 'src', 'Clients'), join(both, 'src', 'Clients'), { recursive: true });
  git(both, 'init', '-q');
  git(both, 'add', '-A');
  git(both, 'commit', '-qm', 'init');
  const { graph } = await mapped(both);
  const m = boundaryMetrics(graph, new Set(['module:src/Api/OrdersController.cs']), { tableOwners: new Map(), sccs: [], candidateOf: () => null, self: 0 }).metrics;
  assert.equal(m['contracts.present'], 1);
  assert.equal(m['clients.count'], 1);
});

test('workspace: a client operation links to the endpoint in another repository by method and path template', { timeout: 120_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'uk-clients-ws-'));
  materialize(parent, 'orders-client');
  materialize(parent, 'orders-server');
  const root = join(parent, 'platform');
  mkdirSync(join(root, '.unknot'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'workspace root\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  writeFileSync(join(root, '.unknot/config.yaml'), stringifyYAML({ version: 1, mode: 'plan', workspace: { repositories: [{ name: 'app', path: '../orders-client' }, { name: 'svc', path: '../orders-server' }] } }));
  const ctx = openProject(root, { create: true });
  const cfg = loadConfig(ctx);
  const r = await mapWorkspace(ctx, { config: cfg.config, history: false });

  const doc = loadWorkspaceGraph(ctx);
  const g = graphFromDocument(doc);
  const link = (from, to) => g.edges('CONSUMES').find((e) => e.from === from && e.to === to && e.attrs.cross_repo && e.attrs.via === 'contract');
  const get = link('contract:app:GET /v1/orders/:id', 'endpoint:svc:GET /v1/orders/:orderId');
  assert.ok(get, 'GET /v1/orders/{id} matches [HttpGet("v1/orders/{orderId}")]');
  assert.equal(get.attrs.from_repo, 'app');
  assert.equal(get.attrs.to_repo, 'svc');
  assert.ok(link('contract:app:POST /v1/orders', 'endpoint:svc:POST /v1/orders'));
  assert.equal(g.out('endpoint:svc:GET /v1/orders/:orderId', 'CONSUMES').length, 0);

  // Operations the other repository does not serve are listed, not dropped.
  const ops = r.analysis.client_operations;
  assert.equal(ops.total, 4);
  assert.equal(ops.linked, 2);
  assert.deepEqual(ops.unmatched.map((u) => [u.repo, u.route]), [['app', 'DELETE /v1/orders/:'], ['app', 'GET /v1/orders/:/history']]);
  assert.deepEqual(ops.unmatched[0].interfaces, ['IOrdersApi']);
  assert.ok(r.analysis.repo_dependencies.some((d) => d.from === 'app' && d.to === 'svc' && d.via.includes('contract')));

  // `graph edges <client operation> --workspace` shows the link, by qualified id or by the id inside its repository.
  const { run } = await import('../../../runtime/cli/commands/graph.mjs');
  const edges = async (node) => {
    const write = process.stdout.write;
    let text = '';
    process.stdout.write = (c) => { text += c; return true; };
    try { await run({ positional: ['edges', node], flags: { cwd: root, workspace: true, json: true } }); } finally { process.stdout.write = write; }
    return JSON.parse(text);
  };
  for (const node of ['contract:app:GET /v1/orders/:id', 'contract:GET /v1/orders/:id']) {
    const rows = await edges(node);
    assert.ok(rows.some((x) => x.type === 'CONSUMES' && x.src === 'contract:app:GET /v1/orders/:id' && x.dst === 'endpoint:svc:GET /v1/orders/:orderId' && /contract app->svc/.test(x.label)), node);
  }
  await assert.rejects(edges('contract:app:GET /nope'), /no node/);
});

test('workspace route matching: ANY serves every method, same repository is internal, nothing else matches', () => {
  const P = { source_type: 'config', source_ref: 'x:1', extractor: 'test@1', confidence: 'high', scope: [], contradicts: [] };
  const op = (method, path) => ({ kind: 'node', type: 'contract', id: `contract:${method} ${path}`, name: `${method} ${path}`, attrs: { kind: 'client_operation', method, path }, provenance: P });
  const ep = (id) => ({ kind: 'node', type: 'endpoint', id: `endpoint:${id}`, name: id, attrs: {}, provenance: P });
  const mod = (id) => ({ kind: 'node', type: 'module', id: `module:${id}`, name: id, attrs: {}, provenance: P });
  const edge = (type, from, to) => ({ kind: 'edge', type, from, to, attrs: {}, provenance: P });
  const a = Graph.fromFacts([mod('a.cs'), op('GET', '/x/:id'), op('PUT', '/y'), op('GET', '/own'), ep('GET /own'), mod('own.cs'), edge('EXPOSES', 'module:own.cs', 'endpoint:GET /own')]);
  const b = Graph.fromFacts([mod('b.cs'), ep('ANY /x/:key'), edge('EXPOSES', 'module:b.cs', 'endpoint:ANY /x/:key')]);
  const { analysis, graph } = buildWorkspaceGraph(new Map([['a', a], ['b', b]]));
  assert.ok(graph.edges('CONSUMES').some((e) => e.from === 'contract:a:GET /x/:id' && e.to === 'endpoint:b:ANY /x/:key'));
  assert.deepEqual(analysis.client_operations, { total: 3, linked: 1, internal: 1, unmatched: [{ repo: 'a', route: 'PUT /y', operation: 'contract:PUT /y', interfaces: [], paths: [] }] });
});
