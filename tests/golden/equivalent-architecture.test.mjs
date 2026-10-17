// Golden: one architecture written in five languages gives equivalent graphs (roadmap #16,
// item 1). `orders` owns an entity, a service and the port it calls; `invoices` implements the
// port; `api` exposes GET /orders/{id}; `app` is the composition root that binds the port to its
// implementation. The fixtures differ only in each language's idiom.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse } from './_harness.mjs';

const { Graph } = await import('../../runtime/graph/graph.mjs');
const { sccsOf } = await import('../../runtime/graph/derived.mjs');

const J = 'src/main/java/com/example/shop';
const ROLES = {
  csharp: { entity: 'Orders/Order.cs', port: 'Orders/InvoiceGateway.cs', service: 'Orders/OrderService.cs', adapter: 'Invoices/PdfInvoiceGateway.cs', controller: 'Api/OrdersController.cs' },
  java: { entity: `${J}/orders/Order.java`, port: `${J}/orders/InvoiceGateway.java`, service: `${J}/orders/OrderService.java`, adapter: `${J}/invoices/PdfInvoiceGateway.java`, controller: `${J}/api/OrdersController.java` },
  python: { entity: 'shop/orders/models.py', port: 'shop/orders/ports.py', service: 'shop/orders/service.py', adapter: 'shop/invoices/pdf.py', controller: 'shop/api/routes.py' },
  typescript: { entity: 'src/orders/order.entity.ts', port: 'src/orders/invoice-gateway.ts', service: 'src/orders/order.service.ts', adapter: 'src/invoices/pdf-invoice-gateway.ts', controller: 'src/api/orders.controller.ts' },
  go: { entity: 'orders/order.go', port: 'orders/invoice_gateway.go', service: 'orders/service.go', adapter: 'invoices/pdf.go', controller: 'api/orders.go' },
};
const LANGUAGES = Object.keys(ROLES);
const UNITS = ['orders', 'invoices', 'api', 'app'];
const UNIT_EDGES = ['api->orders', 'app->api', 'app->invoices', 'app->orders', 'invoices->orders'];
// Includes uses of a type from the same package or directory, which need no import.
const FILE_EDGES = [['service', 'entity'], ['service', 'port'], ['port', 'entity'], ['adapter', 'port'], ['adapter', 'entity'], ['controller', 'service']];
const FINDINGS = ['code.one-implementation-interface'];
// What a language's tier cannot see, named so a fix shows up here.
const TIER_GAPS = { go: { 'code.one-implementation-interface': 'Go satisfies interfaces implicitly; the lexical tier sees no implementation' } };
const DDL = { 'db/schema.sql': 'CREATE TABLE orders (id integer primary key);\n' };

const unitOf = (p) => (p ?? '').toLowerCase().split('/').find((s) => UNITS.includes(s)) ?? null;

function summary(r) {
  const g = Graph.fromStore(r.ctx.store);
  const pathOf = (id) => g.node(id)?.path ?? id.replace(/^module:/, '');
  const units = new Set();
  const files = new Set();
  for (const e of [...g.edges('IMPORTS'), ...g.edges('DEPENDS_ON')]) {
    const [a, b] = [unitOf(pathOf(e.from)), unitOf(pathOf(e.to))];
    if (a && b && a !== b) units.add(`${a}->${b}`);
    if (e.type === 'IMPORTS') files.add(`${pathOf(e.from)}->${pathOf(e.to)}`);
  }
  return {
    g,
    units: [...units].sort(),
    files,
    endpoints: g.nodes('endpoint').map((n) => n.name.replace(/:[^/]+|\{[^}]+\}/g, ':param')).sort(),
    tables: g.nodes('table').map((n) => n.id).sort(),
    bindings: g.edges('RESOLVES_TO').map((e) => `${g.node(e.from)?.name}->${g.node(e.to)?.name}`).sort(),
    kinds: [...new Set(r.findings.map((f) => f.kind))].sort(),
  };
}

const runs = Object.fromEntries(await Promise.all(LANGUAGES.map(async (lang) => [lang, summary(await analyse(`equivalent-${lang}`, { extra: DDL }))])));

for (const lang of LANGUAGES) {
  const s = runs[lang];
  const role = (k) => ROLES[lang][k];

  test(`${lang}: the units depend on each other as the architecture says`, () => {
    assert.deepEqual(s.units, UNIT_EDGES);
    assert.deepEqual(sccsOf(s.g), [], 'no cycle');
  });

  test(`${lang}: file dependencies include same-package type uses`, () => {
    for (const [a, b] of FILE_EDGES) assert.ok(s.files.has(`${role(a)}->${role(b)}`), `${role(a)} depends on ${role(b)}`);
  });

  test(`${lang}: one route, one table owned by the entity file, one container binding`, () => {
    assert.deepEqual(s.endpoints, ['GET /orders/:param']);
    assert.deepEqual(s.tables, ['table:public.orders'], 'the ORM mapping and the DDL name one table');
    assert.ok(s.g.edges('OWNS_DATA').some((e) => e.from === `module:${role('entity')}` && e.to === 'table:public.orders'));
    assert.deepEqual(s.bindings, ['InvoiceGateway->PdfInvoiceGateway']);
  });

  test(`${lang}: the same findings, apart from named tier gaps`, () => {
    assert.deepEqual(s.kinds, FINDINGS.filter((k) => !TIER_GAPS[lang]?.[k]));
  });
}

test('with a schema-less engine every language still names the table once, as the DDL does', async () => {
  for (const lang of LANGUAGES) {
    const r = await analyse(`equivalent-${lang}`, { extra: DDL, skipDiagnose: true, config: { adapters: { database: { engine: 'mysql' } } } });
    const g = Graph.fromStore(r.ctx.store);
    assert.deepEqual(g.nodes('table').map((n) => n.id), ['table:orders'], lang);
    assert.ok(g.edges('OWNS_DATA').some((e) => e.from === `module:${ROLES[lang].entity}` && e.to === 'table:orders'), lang);
  }
});
