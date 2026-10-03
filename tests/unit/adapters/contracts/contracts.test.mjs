import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import adapter from '../../../../adapters/contracts/index.mjs';
import { assertFact, nodeFact, prov } from '../../../../runtime/graph/facts.mjs';

const fx = (name) => readFileSync(fileURLToPath(new URL(`../../../fixtures/contracts/${name}`, import.meta.url)), 'utf8');
function run(fixture, path) {
  const facts = adapter.extract({ path, size: 0, language: null, kind: 'config', blob: 'x' }, fx(fixture), {});
  facts.forEach(assertFact);
  return facts;
}
const node = (facts, id) => facts.find((f) => f.kind === 'node' && f.id === id);
const edges = (facts, type, from, to) => facts.filter((f) => f.kind === 'edge' && f.type === type && (!from || f.from === from) && (!to || f.to === to));

test('adapter shape', () => {
  assert.equal(adapter.id, 'contracts');
  assert.equal(adapter.kind, 'contracts');
  assert.equal(adapter.capabilities.network, false);
  assert.deepEqual(run('not-a-contract.json', 'openapi-config.json'), []);
});

test('openapi 3: endpoints normalised, attrs, artifact and DESCRIBED_BY', () => {
  const f = run('openapi.yaml', 'api/openapi.yaml');
  const art = node(f, 'artifact:api/openapi.yaml');
  assert.equal(art.attrs.kind, 'openapi');
  assert.equal(art.attrs.version, '3.0.3');
  assert.equal(art.attrs.endpoints, 4);
  assert.deepEqual(art.attrs.security_schemes, ['bearerAuth']);
  assert.deepEqual(art.attrs.servers, ['https://api.example.com/v1']);
  assert.ok(!JSON.stringify(f).includes('secret'), 'credentials in server URLs are dropped');
  const get = node(f, 'endpoint:GET /orders/:id');
  assert.equal(get.attrs.operation_id, 'getOrder');
  assert.equal(get.attrs.deprecated, true);
  assert.deepEqual(get.attrs.security, []);
  assert.deepEqual(get.attrs.response_schemas, ['Order']);
  const post = node(f, 'endpoint:POST /orders');
  assert.deepEqual(post.attrs.request_schemas, ['NewOrder']);
  assert.deepEqual(post.attrs.security, ['bearerAuth']);
  assert.deepEqual(node(f, 'endpoint:GET /orders').attrs.response_schemas, ['Order']);
  assert.deepEqual(node(f, 'endpoint:GET /orders').attrs.tags, ['orders']);
  assert.equal(edges(f, 'DESCRIBED_BY', 'endpoint:GET /orders/:id', 'artifact:api/openapi.yaml').length, 1);
});

test('swagger 2: body parameter, security definitions, host', () => {
  const f = run('swagger.json', 'docs/swagger.json');
  assert.equal(node(f, 'artifact:docs/swagger.json').attrs.kind, 'swagger');
  assert.deepEqual(node(f, 'artifact:docs/swagger.json').attrs.servers, ['https://legacy.example.com/api']);
  const put = node(f, 'endpoint:PUT /users/:userId');
  assert.deepEqual(put.attrs.request_schemas, ['User']);
  assert.deepEqual(put.attrs.response_schemas, ['User']);
  assert.deepEqual(put.attrs.security, ['apiKey']);
});

test('asyncapi 2: topics with operations', () => {
  const f = run('asyncapi.yaml', 'asyncapi.yaml');
  const t = node(f, 'topic:orders.created');
  assert.deepEqual(t.attrs.operations, [{ action: 'publish', operation_id: 'onOrderCreated', messages: ['OrderCreated'] }]);
  assert.deepEqual(t.attrs.bindings, ['kafka']);
  assert.deepEqual(node(f, 'topic:orders.cancelled').attrs.operations[0].messages, ['OrderCancelled']);
  assert.equal(node(f, 'artifact:asyncapi.yaml').attrs.channels, 2);
});

test('graphql sdl: operations become endpoints, types become type nodes', () => {
  const f = run('schema.graphql', 'api/schema.graphql');
  const q = node(f, 'endpoint:GRAPHQL Query.products');
  assert.deepEqual(q.attrs.args, ['first', 'after']);
  assert.equal(q.attrs.deprecated, true);
  assert.equal(q.attrs.return_type, '[Product!]!');
  assert.equal(q.provenance.confidence, 'medium');
  assert.ok(node(f, 'endpoint:GRAPHQL Query.product'));
  assert.ok(node(f, 'endpoint:GRAPHQL Mutation.addProduct'));
  assert.ok(node(f, 'endpoint:GRAPHQL Subscription.priceChanged'));
  assert.deepEqual(node(f, 'type:api/schema.graphql#Product').attrs.implements, ['Node']);
  assert.deepEqual(node(f, 'type:api/schema.graphql#Currency').attrs.fields, ['EUR', 'USD']);
  const art = node(f, 'artifact:api/schema.graphql');
  assert.deepEqual([art.attrs.queries, art.attrs.mutations, art.attrs.subscriptions], [2, 1, 1]);
  assert.equal(node(f, 'type:api/schema.graphql#Query'), undefined);
});

test('protobuf: package, rpc endpoints, streaming, reserved', () => {
  const f = run('pricing.proto', 'proto/pricing.proto');
  const get = node(f, 'endpoint:RPC shop.pricing.v1.Pricing/GetPrice');
  assert.equal(get.attrs.request, 'PriceRequest');
  assert.equal(get.attrs.server_streaming, false);
  const watch = node(f, 'endpoint:RPC shop.pricing.v1.Pricing/WatchPrices');
  assert.equal(watch.attrs.client_streaming, true);
  assert.equal(watch.attrs.server_streaming, true);
  const art = node(f, 'artifact:proto/pricing.proto');
  assert.equal(art.attrs.messages, 2);
  assert.equal(art.attrs.syntax, 'proto3');
  assert.equal(art.attrs.has_reserved, true);
  assert.deepEqual(art.attrs.services, ['Pricing']);
});

test('avro and json schema become type nodes', () => {
  const a = run('order.avsc', 'schemas/order.avsc');
  assert.deepEqual(node(a, 'type:com.shop.Order').attrs.fields, ['id', 'status', 'customer']);
  assert.deepEqual(node(a, 'type:com.shop.Status').attrs.symbols, ['NEW', 'PAID']);
  assert.equal(edges(a, 'REFERENCES', 'type:com.shop.Order', 'type:com.shop.Customer').length, 1);
  const j = run('customer.schema.json', 'schemas/customer.schema.json');
  const c = node(j, 'type:Customer');
  assert.deepEqual(c.attrs.required, ['email', 'id']);
  assert.deepEqual(c.attrs.definitions, ['tag']);
  assert.deepEqual(c.attrs.external_refs, ['address.schema.json']);
});

test('pact: consumer CONSUMES and provider EXPOSES with contract_tested', () => {
  const f = run('pact.json', 'pacts/web-orders.json');
  assert.equal(edges(f, 'CONSUMES', 'service:web-frontend', 'endpoint:GET /orders/42')[0].attrs.contract_tested, true);
  assert.equal(edges(f, 'EXPOSES', 'service:orders-service', 'endpoint:GET /orders/42')[0].attrs.contract_tested, true);
  const ep = node(f, 'endpoint:GET /orders/42');
  assert.deepEqual(ep.attrs.statuses, [200, 404]);
  assert.equal(ep.attrs.concrete, true);
  assert.equal(node(f, 'artifact:pacts/web-orders.json').attrs.interactions, 2);
  assert.equal(f.filter((x) => x.kind === 'node' && x.type === 'endpoint').length, 1);
});

test('link: documented, undocumented and unimplemented endpoints', () => {
  const lang = prov({ source_type: 'ast', source_ref: 'src/routes.ts:1', extractor: 'javascript@0.1.0' });
  const ep = (k) => nodeFact('endpoint', k, { path: 'src/routes.ts' }, lang);
  const factsByFile = new Map([
    ['api/openapi.yaml', run('openapi.yaml', 'api/openapi.yaml')],
    ['api/schema.graphql', run('schema.graphql', 'api/schema.graphql')],
    ['pacts/web-orders.json', run('pact.json', 'pacts/web-orders.json')],
    ['src/routes.ts', [ep('GET /orders'), ep('GET /orders/:id'), ep('DELETE /orders/:id'), ep('GET /health')]],
  ]);
  const out = adapter.link({ files: new Map(), factsByFile, options: {} });
  out.forEach(assertFact);
  const by = (id) => out.find((f) => f.id === id);
  assert.equal(by('endpoint:GET /orders').attrs.contract, 'api/openapi.yaml');
  assert.equal(by('endpoint:GET /orders/:id').attrs.contract, 'api/openapi.yaml');
  assert.equal(by('endpoint:DELETE /orders/:id').attrs.undocumented, true);
  assert.equal(by('endpoint:GET /health').attrs.undocumented, true);
  assert.equal(by('endpoint:POST /orders').attrs.unimplemented, true);
  assert.equal(by('endpoint:POST /refunds/:id').attrs.unimplemented, true);
  assert.equal(by('endpoint:POST /orders').provenance.confidence, 'medium');
  // No GraphQL implementation was found, so GraphQL contract fields are not called unimplemented.
  assert.equal(by('endpoint:GRAPHQL Query.product'), undefined);
  // Concrete pact paths never count as missing implementations.
  assert.equal(by('endpoint:GET /orders/42'), undefined);
});

test('link: no contracts means no undocumented claims; pact match marks contract_tested', () => {
  const lang = prov({ source_type: 'ast', source_ref: 'a:1', extractor: 'javascript@0.1.0' });
  const only = new Map([['r', [nodeFact('endpoint', 'GET /orders/42', {}, lang), nodeFact('endpoint', 'GET /x', {}, lang)]]]);
  assert.deepEqual(adapter.link({ files: new Map(), factsByFile: only, options: {} }), []);
  only.set('pacts/p.json', run('pact.json', 'pacts/p.json'));
  const out = adapter.link({ files: new Map(), factsByFile: only, options: {} });
  assert.equal(out.length, 1);
  assert.equal(out[0].attrs.contract_tested, true);
});
