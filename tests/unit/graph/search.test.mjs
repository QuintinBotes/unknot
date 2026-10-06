// unknot search: strings a dependency graph does not index, with definitions, uses, uses
// through the constant that holds them, and owners.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import { mapRepository } from '../../../runtime/graph/builder.mjs';
import { Graph } from '../../../runtime/graph/graph.mjs';
import { definitionOn, searchText } from '../../../runtime/graph/search.mjs';
import { TOOLS } from '../../../runtime/mcp/tools.mjs';

test('definitions are told apart from uses across languages and config formats', () => {
  const name = 'orders.checkout.latency';
  for (const line of [
    `public const string CheckoutLatency = "${name}";`,
    `static final String CHECKOUT_LATENCY = "${name}";`,
    `CHECKOUT_LATENCY = '${name}'`,
    `export const checkoutLatency = '${name}';`,
    `const checkoutLatency: string = "${name}";`,
  ]) assert.equal(definitionOn(line, name)?.kind, 'constant', line);
  assert.deepEqual(definitionOn(`  "${name}": 30,`, name), { kind: 'key', name });
  assert.deepEqual(definitionOn(`${name}: 30`, name), { kind: 'key', name });
  assert.equal(definitionOn(`metrics.Record("${name}", value);`, name), null);
  assert.equal(definitionOn(`if (x == "${name}") return;`, name), null);
});

test('search finds the constant, its uses through the constant name, config keys and owners', async () => {
  const p = K.makeProject({ files: {
    '.github/CODEOWNERS': 'src/orders/ @example/orders\n',
    'src/orders/Metrics.cs': 'namespace Shop.Orders;\npublic static class Metrics {\n    public const string CheckoutLatency = "orders.checkout.latency";\n}\n',
    'src/orders/Checkout.cs': 'namespace Shop.Orders;\npublic class Checkout {\n    void Done(IMeter m) { m.Record(Metrics.CheckoutLatency, 1); }\n}\n',
    'src/billing/Report.cs': 'namespace Shop.Billing;\npublic class Report { string Name() => "orders.checkout.latency"; }\n',
    'config/alerts.yaml': 'orders.checkout.latency:\n  threshold: 2s\n',
    'docs/runbook.md': 'Watch `orders.checkout.latency` during deploys.\n',
  } });
  const config = K.cfg({ mode: 'plan' });
  await mapRepository(p.ctx, { config, configDigest: 'd', history: false });
  const r = searchText(p.dir, { config, text: 'orders.checkout.latency', graph: Graph.fromStore(p.ctx.store) });
  assert.deepEqual(r.definitions.map((h) => [h.path, h.definition.kind]).sort(), [['config/alerts.yaml', 'key'], ['src/orders/Metrics.cs', 'constant']]);
  assert.equal(r.definitions.find((h) => h.path === 'src/orders/Metrics.cs').definition.name, 'CheckoutLatency');
  assert.deepEqual(r.uses.map((h) => h.path).sort(), ['docs/runbook.md', 'src/billing/Report.cs']);
  const via = r.via_constants.find((h) => h.path === 'src/orders/Checkout.cs');
  assert.equal(via.constant, 'CheckoutLatency');
  assert.deepEqual(via.owners, ['@example/orders']);
  assert.equal(r.counts.by_kind.doc, 1);
  assert.equal(searchText(p.dir, { config, text: 'not-anywhere-at-all' }).counts.hits, 0);
});

const mapAndSearch = async (files) => {
  const p = K.makeProject({ files });
  const config = K.cfg({ mode: 'plan' });
  await mapRepository(p.ctx, { config, configDigest: 'd', history: false });
  return { p, config, graph: Graph.fromStore(p.ctx.store) };
};

test('an exact constant match does not hide the constants that extend it', async () => {
  const route = '/v1/orders/{id}/lines';
  const { p, config, graph } = await mapAndSearch({
    'src/Routes.cs': `namespace Shop;\npublic static class Routes {\n    public const string Lines = "${route}";\n    public const string Line = "${route}/{lineId}";\n    public const string Other = "/v1/orders/{id}/payments";\n}\n`,
    'src/Client.cs': `namespace Shop;\npublic class Client { string One() => Routes.Line; string Two() => Routes.Lines; }\n`,
  });
  const r = searchText(p.dir, { config, graph, store: p.ctx.store, text: route });
  assert.equal(r.answered_by, 'graph');
  assert.deepEqual(r.constants.map((k) => k.value), [route, `${route}/{lineId}`]);
  assert.equal(r.constants_matched, 2);
  assert.equal(r.constants_left_out, 0);
  assert.deepEqual(r.definitions.map((h) => h.constant), [route, `${route}/{lineId}`]);
  assert.equal(r.counts.definitions, 2);
  // Without the exact constant the same two answer by prefix: adding characters never shrinks it.
  assert.deepEqual(searchText(p.dir, { config, graph, store: p.ctx.store, text: route.slice(0, -1) }).constants.map((k) => k.value), [route, `${route}/{lineId}`]);
  assert.equal(TOOLS.search_text.run(p.ctx, { text: route }).constants_matched, 2);
});

test('when the constant limit cuts the constants that extend an exact match, the result says how many', async () => {
  const body = Array.from({ length: 25 }, (_, i) => `    public const string K${i} = "app.queue.${String(i).padStart(2, '0')}";`).join('\n');
  const { p, config, graph } = await mapAndSearch({ 'src/A.cs': `namespace A;\npublic class A {\n    public const string Root = "app.queue";\n${body}\n}\n` });
  const r = searchText(p.dir, { config, graph, store: p.ctx.store, text: 'app.queue' });
  assert.equal(r.constants[0].value, 'app.queue');
  assert.equal(r.constants.length, 20);
  assert.equal(r.constants_matched, 26);
  assert.equal(r.constants_left_out, 6);
});
