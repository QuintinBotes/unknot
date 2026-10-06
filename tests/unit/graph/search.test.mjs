// unknot search: strings a dependency graph does not index, with definitions, uses, uses
// through the constant that holds them, and owners.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import { mapRepository } from '../../../runtime/graph/builder.mjs';
import { Graph } from '../../../runtime/graph/graph.mjs';
import { definitionOn, searchText } from '../../../runtime/graph/search.mjs';

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
