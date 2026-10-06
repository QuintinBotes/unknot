// unknot search: strings a dependency graph does not index, with definitions, uses, uses
// through the constant that holds them, and owners.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as K from '../../helpers/kernel.mjs';
import { mapRepository } from '../../../runtime/graph/builder.mjs';
import { Graph } from '../../../runtime/graph/graph.mjs';
import { definitionOn, searchText, searchTextConcurrent } from '../../../runtime/graph/search.mjs';
import { TOOLS } from '../../../runtime/mcp/tools.mjs';
import { generateFixture } from '../../../scripts/bench.mjs';

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

const treeOf = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/m${i % 10}/F${i}.cs`, `namespace M;\npublic class F${i} { string s = "needle-${i}"; }\n`]));
const ticking = (step) => {
  let t = 0;
  return () => (t += step);
};

test('a scan that runs out of its time budget returns what it has and says how many files it did not scan', async () => {
  const p = K.makeProject({ files: treeOf(200) });
  const config = K.cfg({ mode: 'plan' });
  for (const run of [(o) => searchText(p.dir, o), (o) => searchTextConcurrent(p.dir, { ...o, concurrency: 1 })]) {
    const r = await run({ config, text: 'needle-', scan: true, budgetSeconds: 50, now: ticking(1000) });
    assert.equal(r.partial, true);
    assert.ok(r.files_not_scanned > 0 && r.files_not_scanned < 210, String(r.files_not_scanned));
    assert.match(r.notice, new RegExp(`${r.files_not_scanned} of \\d+ file\\(s\\) were not scanned`));
    assert.ok(r.counts.hits > 0 && r.counts.hits < 200);
    const whole = await run({ config, text: 'needle-', scan: true });
    assert.equal(whole.partial, false);
    assert.equal(whole.counts.hits, 200);
    assert.equal(whole.notice, undefined);
  }
});

test('the concurrent scan finds what the serial scan finds, in the same order, and reads no excluded file', async () => {
  const files = {
    ...treeOf(60),
    'config/alerts.yaml': 'needle-alert: 1\n',
    'src/Gen.cs': '// <auto-generated> DO NOT EDIT\npublic class G { string s = "needle-gen"; }\n',
    'node_modules/x/index.js': 'var s = "needle-vendor";\n',
    'assets/logo.png': 'needle-binary',
    '.env': 'needle-secret=1\n',
    'src/Bin.cs': 'needle-nul\0\0\n',
  };
  const p = K.makeProject({ files });
  const config = K.cfg({ mode: 'plan' });
  const serial = searchText(p.dir, { config, text: 'needle-', scan: true });
  const par = await searchTextConcurrent(p.dir, { config, text: 'needle-', scan: true, concurrency: 8 });
  assert.deepEqual(par.uses.map((h) => [h.path, h.line]), serial.uses.map((h) => [h.path, h.line]));
  assert.equal(par.counts.hits, 61);
  assert.equal(par.files_searched, serial.files_searched);
  assert.ok(!par.uses.some((h) => /Gen\.cs|node_modules|logo|\.env|Bin\.cs/.test(h.path)));
});

test('a slow scan reports progress through the callback, at most once a second after the first three', async () => {
  const p = K.makeProject({ files: treeOf(100) });
  const calls = [];
  await searchTextConcurrent(p.dir, { config: K.cfg({ mode: 'plan' }), text: 'needle-', scan: true, concurrency: 1, now: ticking(400), onProgress: (done, total, phase) => calls.push([done, total, phase]) });
  assert.ok(calls.length >= 3, `${calls.length} progress calls`);
  assert.ok(calls.every(([done, total]) => done > 0 && done <= total));
  assert.equal(calls[0][2], 'scanning');
  assert.ok(calls.length < 100, 'not one per file');
  const quiet = [];
  await searchTextConcurrent(p.dir, { config: K.cfg({ mode: 'plan' }), text: 'needle-', scan: true, onProgress: (...a) => quiet.push(a) });
  assert.deepEqual(quiet, [], 'a fast scan prints nothing');
});

test('unknot search --scan states a partial result in text and JSON, and rejects a bad budget', () => {
  const p = K.makeProject({ files: treeOf(30) });
  const bin = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [bin, 'search', 'needle-', '--scan', ...args], { cwd: p.dir, encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: p.home } });
  assert.match(run('--budget-seconds', '0.0000001').stdout, /Note: partial result: .* \d+ of \d+ file\(s\) were not scanned/);
  const json = JSON.parse(run('--json', '--budget-seconds', '0.0000001').stdout);
  assert.equal(json.partial, true);
  assert.ok(json.files_not_scanned > 0);
  assert.notEqual(run('--budget-seconds', '0').status, 0);
  assert.equal(JSON.parse(run('--json').stdout).partial, false);
});

// A generated 25,000-file tree, scanned in full. Slow to build (about a minute), so it runs only
// when UNKNOT_SLOW_TESTS is set. The scan has the default 60 s budget and must finish in half of it.
test('a scan of a generated 25,000-file tree finishes within the budget', { skip: !process.env.UNKNOT_SLOW_TESTS, timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uk-scan-25k-'));
  try {
    generateFixture(dir, 25_000);
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['add', '-A'], { cwd: dir });
    const t0 = Date.now();
    const r = await searchTextConcurrent(dir, { config: K.cfg({ mode: 'plan' }), text: 'zzzz-not-there', scan: true, budgetSeconds: 60 });
    const ms = Date.now() - t0;
    process.stderr.write(`# 25k-file scan: ${ms} ms over ${r.files_searched} files\n`);
    assert.equal(r.partial, false);
    assert.ok(r.files_searched >= 25_000);
    assert.ok(ms < 30_000, `${ms} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
