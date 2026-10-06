// Identifier-like string constants as graph nodes: sub-kinds, prose excluded, definition and use
// links, caps, search and status.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as K from '../../../helpers/kernel.mjs';
import { mapRepository } from '../../../../runtime/graph/builder.mjs';
import { Graph } from '../../../../runtime/graph/graph.mjs';
import { searchText } from '../../../../runtime/graph/search.mjs';
import adapter, { isIdentifierLike, subkindOf } from '../../../../adapters/literals/index.mjs';
import { run as runStatus } from '../../../../runtime/cli/commands/status.mjs';
import { TOOLS } from '../../../../runtime/mcp/tools.mjs';

const FILES = {
  'src/orders/Metrics.cs': 'namespace Shop.Orders;\npublic static class Metrics {\n    public const string CheckoutLatency = "orders.checkout.latency";\n}\n',
  'src/orders/Checkout.cs': 'namespace Shop.Orders;\npublic class Checkout {\n    void Done(IMeter m) { m.Record(Metrics.CheckoutLatency, 1); }\n}\n',
  'src/orders/Reports.cs': 'namespace Shop.Orders;\npublic class Reports {\n    void Done(IMeter m) { histogram.Record(Metrics.CheckoutLatency, 2); }\n    void Direct(IMeter m) { counter.Add("orders.checkout.latency"); }\n}\n',
  'src/billing/Retry.cs': 'namespace Shop.Billing;\npublic class Retry {\n    int N(IConfiguration c) => c.GetValue<int>("Invoices:RetryCount");\n}\n',
  'src/billing/Api.cs': 'namespace Shop.Billing;\npublic class Api {\n    [HttpGet("/api/orders/{id}")]\n    public void Get() {}\n    [Authorize(Roles = "invoice-approver")]\n    public void Approve() {}\n}\n',
  'src/billing/Prose.cs': 'namespace Shop.Billing;\npublic class Prose {\n    void Log(ILogger l) {\n        l.Info("The invoice could not be approved because the retry budget was exhausted.");\n        l.Info("Order {0} failed after {1} attempts: see https://example.com/help/orders");\n        l.Info($"Checkout.{Name} done");\n        var f = "Elapsed time: {0:N2}ms";\n    }\n}\n',
};

const kinds = (graph) => Object.fromEntries(graph.nodes('constant').map((n) => [n.name, n.attrs.subkind]));

async function mapped(files = FILES, config = K.cfg({ mode: 'plan' })) {
  const p = K.makeProject({ files });
  await mapRepository(p.ctx, { config, configDigest: 'd', history: false });
  return { p, config, graph: Graph.fromStore(p.ctx.store) };
}

test('a metric name, a config key, a route and a role become constant nodes with inferred sub-kinds', async () => {
  const { graph } = await mapped();
  assert.deepEqual(kinds(graph), {
    'orders.checkout.latency': 'metric',
    'Invoices:RetryCount': 'config_key',
    '/api/orders/{id}': 'route',
    'invoice-approver': 'role',
  });
  const n = graph.node('constant:orders.checkout.latency');
  assert.equal(n.attrs.subkind_basis, 'inferred');
  assert.match(n.attrs.subkind_evidence, /Metrics\.cs:3|Reports\.cs:4/);
});

test('prose, log messages and format strings are not indexed', async () => {
  const { graph } = await mapped();
  const names = graph.nodes('constant').map((n) => n.name);
  assert.ok(!names.some((x) => /\s/.test(x)), names.join('|'));
  for (const s of ['Order {0} failed after {1} attempts: see https://example.com/help/orders', 'Elapsed time: {0:N2}ms', 'The invoice could not be approved because the retry budget was exhausted.']) assert.ok(!names.includes(s));
  assert.equal(adapter.extract({ path: 'a.cs', kind: 'source' }, 'var s = "A long message, with prose: it never ends. Really not an id.";').length, 0);
  for (const s of ['two words', 'https://example.com/a/b', 'application/json', 'appsettings.json', '{0}.{1}', '%s.%d', 'ab', 'x'.repeat(121), 'plainword', 'Total: 5', '12.5.1', '1f0e8c2a-9b1d-4c1e-8a50-2c3d4e5f6a7b', 'ATiO0tnu-7qEuOqUSp-WcA5YfzBmXq0kxdfasuKabSULa19w']) assert.equal(isIdentifierLike(s), false, s);
  for (const s of ['orders.checkout.latency', 'Invoices:RetryCount', '/api/orders/{id}', 'invoice-approver', 'orders_queue', 'api/orders/{id:int}']) assert.equal(isIdentifierLike(s), true, s);
});

test('a constant defined once and used from two classes has the definition and both usage links', async () => {
  const { graph } = await mapped();
  const id = 'constant:orders.checkout.latency';
  assert.deepEqual(graph.in(id, 'DEFINES').map((e) => e.from), ['module:src/orders/Metrics.cs']);
  assert.deepEqual(graph.in(id, 'REFERENCES').map((e) => e.from).sort(), ['module:src/orders/Checkout.cs', 'module:src/orders/Reports.cs']);
  const via = graph.in(id, 'REFERENCES').find((e) => e.from === 'module:src/orders/Checkout.cs');
  assert.equal(via.attrs.via, 'CheckoutLatency');
});

test('subkind inference reads the surroundings', () => {
  const sk = (v, l, o) => subkindOf(v, l, o).subkind;
  assert.equal(sk('orders.queue.paid', 'bus.Publish("orders.queue.paid")'), 'queue');
  assert.equal(sk('orders.paid', 'statsd.increment("orders.paid")'), 'metric');
  assert.equal(sk('orders.paid', 'x = "orders.paid"'), 'other');
  assert.equal(sk('orders.paid', 'v = cfg.get("orders.paid")'), 'other');
  assert.equal(sk('orders/list', 'router.get("orders/list", h)'), 'route');
  assert.equal(sk('orders.paid', 'x["Total counter is high"] = "orders.paid"'), 'other');
  assert.equal(sk('Orders.AlreadySubscribed', '@T("Orders.AlreadySubscribed")'), 'other');
  assert.equal(sk('Security.Permission.Orders', '["Security.Permission.Orders"] = "Admin area"'), 'other');
  assert.equal(sk('orders.paid', 'x', { fileKind: 'config' }), 'config_key');
  assert.equal(sk('orders/{id}', 'app.MapGet("orders/{id}")'), 'route');
  assert.equal(sk('billing.approve', 'if (user.IsInRole("billing.approve"))'), 'role');
});

test('markup does not index CSS classes, but resource keys in it are uses', () => {
  const f = adapter.extract({ path: 'Views/Cart.cshtml', kind: 'source' }, '<div class="col-sm-9">@T("Cart.Empty.Title")</div>\n');
  assert.deepEqual(f.map((x) => x.to), ['constant:Cart.Empty.Title']);
});

test('config files contribute their nested keys as Section:Key', async () => {
  const { graph } = await mapped({
    'src/App.cs': 'namespace A;\npublic class App { }\n',
    'src/appsettings.json': '{\n  "Invoices": {\n    "RetryCount": 3,\n    "Queue": { "Name": "invoice-approvals" }\n  }\n}\n',
  });
  assert.equal(graph.node('constant:Invoices:RetryCount')?.attrs.subkind, 'config_key');
  assert.ok(graph.node('constant:Invoices:Queue:Name'));
  assert.equal(graph.in('constant:Invoices:RetryCount', 'DEFINES').length, 1);
});

test('caps bound the volume and say so', async () => {
  const body = Array.from({ length: 30 }, (_, i) => `    public const string K${i} = "app.key_${i}";`).join('\n');
  const config = K.cfg({ mode: 'plan', adapters: { literals: { max_per_file: 10, max_per_repo: 8 } } });
  const p = K.makeProject({ files: { 'src/A.cs': `namespace A;\npublic class A {\n${body}\n}\n`, 'src/B.cs': 'namespace A;\npublic class B { string s = "app.key_3"; }\n' } });
  const summary = await mapRepository(p.ctx, { config, configDigest: 'd', history: false });
  assert.equal(summary.constants.nodes, 8);
  assert.equal(summary.constants.files_capped, 1);
  assert.equal(summary.constants.dropped_by_repo_cap, 2);
  assert.ok(summary.notices.some((n) => /literals\.max_per_repo 8/.test(n)));
  assert.ok(summary.notices.some((n) => /literals\.max_per_file/.test(n)));
  assert.equal(Graph.fromStore(p.ctx.store).nodes('constant').length, 8);
  assert.equal(p.ctx.store.all("SELECT 1 FROM nodes WHERE type = 'constant' AND json_extract(attrs, '$.placeholder')").length, 0);
});

test('search: exact string answers from the graph with definition and usage sites; prefix too; others scan', async () => {
  const { p, config, graph } = await mapped();
  const a = { config, graph, store: p.ctx.store };
  const r = searchText(p.dir, { ...a, text: 'orders.checkout.latency' });
  assert.equal(r.answered_by, 'graph');
  assert.deepEqual(r.definitions.map((h) => [h.path, h.line, h.definition.name]), [['src/orders/Metrics.cs', 3, 'CheckoutLatency']]);
  assert.deepEqual(r.uses.map((h) => h.path), ['src/orders/Reports.cs']);
  assert.deepEqual(r.via_constants.map((h) => h.path).sort(), ['src/orders/Checkout.cs', 'src/orders/Reports.cs']);
  assert.equal(r.constants[0].subkind, 'metric');
  assert.equal(r.constants[0].subkind_basis, 'inferred');
  const prefix = searchText(p.dir, { ...a, text: 'Invoices:' });
  assert.equal(prefix.answered_by, 'graph');
  assert.equal(prefix.constants[0].value, 'Invoices:RetryCount');
  assert.equal(searchText(p.dir, { ...a, text: 'invoice-approver' }).answered_by, 'graph');
  assert.equal(searchText(p.dir, { ...a, text: '/api/orders/{id}' }).constants[0].subkind, 'route');
  const miss = searchText(p.dir, { ...a, text: 'The invoice could not' });
  assert.equal(miss.answered_by, 'scan');
  assert.equal(miss.counts.hits, 1);
  assert.equal(searchText(p.dir, { ...a, text: 'orders.checkout.latency', scan: true }).answered_by, 'scan');
  assert.equal(searchText(p.dir, { ...a, text: 'orders.checkout', regex: true }).answered_by, 'scan');
  assert.equal(searchText(p.dir, { config, text: 'orders.checkout.latency' }).answered_by, 'scan');
  const tool = TOOLS.search_text.run(p.ctx, { text: 'Invoices:RetryCount' });
  assert.equal(tool.answered_by, 'graph');
});

test('status reports the constant nodes and their sub-kinds', async () => {
  const { p } = await mapped();
  const c = JSON.parse(p.ctx.store.meta('constants'));
  assert.equal(c.nodes, 4);
  assert.deepEqual(c.by_subkind, { metric: 1, config_key: 1, route: 1, role: 1, queue: 0, other: 0 });
  const out = await new Promise((resolve) => {
    const w = process.stdout.write;
    let buf = '';
    process.stdout.write = (c) => ((buf += c), true);
    runStatus({ positional: [], flags: { cwd: p.dir } }).finally(() => {
      process.stdout.write = w;
      resolve(buf);
    });
  });
  assert.match(out, /Constants: 4 identifier-like string nodes \(metric 1, config_key 1, route 1, role 1; sub-kinds inferred\)/);
  assert.equal(p.ctx.store.get("SELECT label FROM nodes WHERE id = 'constant:invoice-approver'").label, 'inferred');
});

test('unknot graph nodes constant --name lists constants by prefix', async () => {
  const { p } = await mapped();
  p.ctx.store.close();
  const bin = fileURLToPath(new URL('../../../../bin/unknot', import.meta.url));
  const r = spawnSync(process.execPath, [bin, 'graph', 'nodes', 'constant', '--name', 'Invoices:', '--json', '--cwd', p.dir], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).nodes.map((n) => n.id), ['constant:Invoices:RetryCount']);
});
