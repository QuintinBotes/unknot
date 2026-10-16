import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../../../../adapters/contracts/index.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';
import { Graph } from '../../../../runtime/graph/graph.mjs';
import { contractEvidence } from '../../../../runtime/decompose/contracts.mjs';
import { buildWorkspaceGraph } from '../../../../runtime/enterprise/workspace.mjs';

function project(files) {
  const factsByFile = new Map(Object.entries(files).map(([path, text]) => [path, adapter.extract({ path }, text)]));
  const linked = adapter.link({ factsByFile });
  const all = [...factsByFile.values()].flat().concat(linked);
  all.forEach(assertFact);
  return Graph.fromFacts(all);
}
const proto = 'syntax = "proto3";\npackage ledger; service OrdersService { rpc ListOrders (Orders) returns (Orders); rpc CreateOrder (Order) returns (Order); }';
const schema = 'type Query {\n orders: [Order!]!\n invoices: [Invoice!]!\n}\ntype Mutation {\n createOrder: Order\n}';

for (const [path, src] of [
  ['orders.js', 'const client = new OrdersServiceClient(channel); client.listOrders(request);'],
  ['orders.java', 'var client = new OrdersServiceClient(channel); client.listOrders(request);'],
  ['orders.py', 'client = OrdersServiceStub(channel)\nclient.ListOrders(request)'],
  ['orders.go', 'client := NewOrdersServiceClient(conn)\nclient.ListOrders(ctx, request)'],
]) test(`generated RPC client: ${path} matches service and method`, () => {
  const g = project({ [path]: src, 'orders.proto': proto });
  const client = g.nodes('contract').find((n) => n.attrs.kind === 'rpc_client');
  assert.equal(client.attrs.service, 'OrdersService');
  assert.equal(client.attrs.matched, true);
  assert.ok(g.out(`module:${path}`, 'CONSUMES').some((e) => e.to === 'contract:RPC ledger.OrdersService/ListOrders'));
  assert.equal(g.out(`module:${path}`, 'CONSUMES').length, 1);
  const evidence = contractEvidence(g, [`module:${path}`]);
  assert.equal(evidence.present, true);
  assert.equal(evidence.clients, 1);
  assert.equal(evidence.routes[0].route, 'RPC ledger.OrdersService/ListOrders');
});

test('service-only clients match all declared methods; other services, methods and ambiguous packages do not match', () => {
  const g = project({ 'orders.js': 'new OrdersServiceClient(channel); new InvoicesServiceClient(channel);', 'orders.proto': proto });
  assert.equal(g.out('module:orders.js', 'CONSUMES').length, 2);
  const other = project({ 'orders.js': 'const client = new OrdersServiceClient(channel); client.DeleteOrder(request);', 'orders.proto': proto });
  assert.equal(other.out('module:orders.js', 'CONSUMES').length, 0);
  const ambiguous = project({ 'orders.js': 'new OrdersServiceClient(channel)', 'orders.proto': proto, 'invoices.proto': proto.replace('package ledger;', 'package invoices;') });
  assert.equal(ambiguous.out('module:orders.js', 'CONSUMES').length, 0);
  assert.ok(ambiguous.nodes('contract').some((n) => n.attrs.kind === 'rpc_client' && !n.attrs.matched));
});

for (const [path, src] of [
  ['orders.js', 'const doc = gql`query Orders { latest: orders { id } }`;'],
  ['orders.graphql', 'query Orders { latest: orders { id } }'],
  ['orders.gql', 'query Orders { latest: orders { id } }'],
]) test(`named GraphQL client: ${path} matches schema operation and retains document name`, () => {
  const g = project({ [path]: src, 'schema.graphqls': schema });
  const client = g.nodes('contract').find((n) => n.attrs.kind === 'graphql_client');
  assert.equal(client.name, 'Orders');
  assert.deepEqual(client.attrs.fields, ['orders']);
  assert.ok(g.out(`module:${path}`, 'CONSUMES').some((e) => e.to === 'contract:GRAPHQL Query.orders'));
  assert.equal(g.node('contract:GRAPHQL Query.orders').attrs.operation_name, 'Orders');
  assert.equal(contractEvidence(g, [`module:${path}`]).present, true);
});

test('GraphQL multiple operations, variables, aliases, mutations and unmatched operations', () => {
  const g = project({ 'orders.graphql': 'query Orders($id: ID!) { orders(id: $id) { id } invoices { id } }\nmutation CreateOrder { createOrder { id } }\nquery Ledger { ledger { id } }', 'schema.graphqls': schema });
  assert.equal(g.out('module:orders.graphql', 'CONSUMES').length, 3);
  assert.equal(g.nodes('contract').filter((n) => n.attrs.kind === 'graphql_client').length, 3);
  assert.ok(g.nodes('contract').some((n) => n.name === 'Ledger' && !n.attrs.matched));
});

test('RPC and GraphQL client operations link against another repository service/schema declarations', () => {
  const clients = project({ 'orders.js': 'new OrdersServiceClient(channel); const doc = gql`query Orders { orders { id } }`;', 'orders.proto': proto, 'schema.graphqls': schema });
  const services = project({ 'orders.proto': proto, 'schema.graphqls': schema });
  const { graph, analysis } = buildWorkspaceGraph(new Map([['orders', clients], ['ledger', services]]));
  assert.equal(analysis.client_operations.linked, 3);
  assert.equal(analysis.cross_repo_edges.total, 3);
  assert.equal(graph.edges().filter((e) => e.attrs.cross_repo).length, 3);
  assert.ok(graph.edges('CONSUMES').some((e) => e.attrs.cross_repo && e.to === 'endpoint:ledger:GRAPHQL Query.orders'));
  assert.ok(graph.edges('CONSUMES').some((e) => e.attrs.cross_repo && e.to === 'endpoint:ledger:RPC ledger.OrdersService/ListOrders'));
});

test('comments and ordinary strings do not become generated clients or query operations', () => {
  const g = project({ 'orders.js': '// new OrdersServiceClient(channel)\nconst text = "new OrdersServiceClient(channel)"; const doc = gql`query Orders { ${fields} }`;', 'orders.proto': proto });
  assert.equal(g.nodes('contract').length, 0);
});


test('workspace matches generated clients and query documents without a local service/schema file', () => {
  const clients = project({ 'orders.js': 'const client = new OrdersServiceClient(channel); client.ListOrders(request); const doc = gql`query Orders { orders { id } }`;' });
  const services = project({ 'orders.proto': proto, 'schema.graphqls': schema });
  const { graph, analysis } = buildWorkspaceGraph(new Map([['orders', clients], ['ledger', services]]));
  const links = graph.edges('CONSUMES').filter((e) => e.attrs.cross_repo);
  assert.equal(links.length, 2);
  assert.equal(analysis.client_operations.linked, 2);
  const local = new Map(graph.nodes().map((n) => [n.id, n.attrs.local_id]));
  const workspace = { repository: 'orders', mapped_at: '2026-10-12', links: links.map((e) => ({ route: e.attrs.route, from_repo: e.attrs.from_repo, from: local.get(e.from), to_repo: e.attrs.to_repo, to: local.get(e.to) })) };
  const evidence = contractEvidence(clients, ['module:orders.js'], workspace);
  assert.equal(evidence.present, true);
  assert.deepEqual(evidence.routes.map((r) => r.route), ['GRAPHQL Query.orders', 'RPC ledger.OrdersService/ListOrders']);
  assert.ok(evidence.routes.every((r) => r.served_by.includes('ledger')));
});


test('method specificity does not choose between two packages declaring the same service', () => {
  const g = project({ 'orders.js': 'const client = new OrdersServiceClient(channel); client.ListOrders(request);',
    'orders.proto': proto, 'invoices.proto': proto.replace('package ledger;', 'package invoices;').replace('ListOrders', 'ReadInvoices') });
  assert.equal(g.out('module:orders.js', 'CONSUMES').length, 0);
});
