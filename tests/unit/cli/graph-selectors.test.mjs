// `graph edges --from/--to` take the selectors `graph nodes` and the scope language take (issue #93).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'uk-selector-home-'));
const proj = mkdtempSync(join(tmpdir(), 'uk-selector-proj-'));
process.env.UNKNOT_HOME = home;

const { openProject } = await import('../../../runtime/context.mjs');
const { project } = await import('../../../runtime/graph/builder.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');

const p = prov({ source_type: 'ast', source_ref: 'x:1', extractor: 'test' });
const mod = (path, extra = {}) => nodeFact('module', path, { name: path.split('/').pop(), path, attrs: extra }, p);
const imp = (a, b) => edgeFact('IMPORTS', `module:${a}`, `module:${b}`, {}, p);

before(() => {
  const ctx = openProject(proj, { create: true });
  project(
    ctx,
    [
      mod('src/Orders/Order.cs', { namespace: 'Shop.Orders' }),
      mod('src/Orders/Line.cs', { namespace: 'Shop.Orders' }),
      mod('src/Billing/Invoice.cs', { namespace: 'Shop.Billing' }),
      imp('src/Orders/Order.cs', 'src/Orders/Line.cs'),
      imp('src/Orders/Order.cs', 'src/Billing/Invoice.cs'),
      imp('src/Orders/Line.cs', 'src/Billing/Invoice.cs'),
      imp('src/Billing/Invoice.cs', 'src/Orders/Order.cs'),
    ],
    { commit: 'abc123', observedAt: '2026-01-01T00:00:00Z' },
  );
  ctx.store.close();
});

const graph = (...args) => {
  const r = spawnSync(process.execPath, [BIN, 'graph', ...args, '--cwd', proj], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const srcs = (...args) => JSON.parse(graph('edges', ...args, '--json').out).map((e) => `${e.src}>${e.dst}`).sort();

const FROM_ORDERS = [
  'module:src/Orders/Line.cs>module:src/Billing/Invoice.cs',
  'module:src/Orders/Order.cs>module:src/Billing/Invoice.cs',
  'module:src/Orders/Order.cs>module:src/Orders/Line.cs',
];

test('1. --from takes a glob, a path and a namespace, as graph nodes matches them', () => {
  assert.deepEqual(srcs('--from', 'src/Orders/**'), FROM_ORDERS);
  assert.deepEqual(srcs('--from', 'src/Orders/Order.cs'), FROM_ORDERS.filter((e) => e.includes('Order.cs>')));
  assert.deepEqual(srcs('--from', 'Shop.Orders'), FROM_ORDERS);
  assert.deepEqual(srcs('--from', 'ns:Shop.Orders'), FROM_ORDERS);
  assert.deepEqual(srcs('--to', 'src/Billing/**'), FROM_ORDERS.filter((e) => e.endsWith('Invoice.cs')));
});

test('2. a selector that matches no node is an error that says so', () => {
  for (const sel of ['src/Nowhere/**', 'Shop.Nothing']) {
    const r = graph('edges', '--from', sel);
    assert.equal(r.code, 1, sel);
    assert.match(r.err, /no node matches/);
  }
});

test('edge: a selector that matches many nodes keeps the row cap and says so', () => {
  const r = graph('edges', '--from', 'src/**', '--limit', '2');
  assert.equal(r.code, 0);
  assert.match(r.out, /first 2 edges shown, more match; raise --limit/);
  const j = graph('edges', '--from', 'src/**', '--limit', '2', '--json');
  assert.equal(JSON.parse(j.out).length, 2);
  assert.match(j.err, /first 2 edges shown/);
});
