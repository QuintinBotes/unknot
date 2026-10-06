// The decompose command line: subcommands, --summary, --dry-run and the warning stream.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { analyse } from '../../golden/_harness.mjs';

const { run } = await import('../../../runtime/cli/commands/decompose.mjs');
const { parseArgs } = await import('../../../runtime/cli/util.mjs');

const imports = (names, self) => names.filter((m) => m !== self).map((m) => `import { f_${m} } from './${m}.js';`).join('\n');
const group = (dir, names) => Object.fromEntries(names.map((n) => [`shop/${dir}/${n}.js`, `${imports(names, n)}\nexport function f_${n}() { return 1; }\n`]));
const r = await analyse('modular-monolith', { extra: { ...group('orders', ['o0', 'o1', 'o2', 'o3', 'o4']), ...group('stock', ['s0', 's1', 's2', 's3', 's4']) }, skipDiagnose: true });

async function cliIn(dir, ...argv) {
  const { positional, flags } = parseArgs([...argv, '--cwd', dir]);
  let out = '';
  let err = '';
  const o = process.stdout.write;
  const e = process.stderr.write;
  process.stdout.write = (c) => { out += c; return true; };
  process.stderr.write = (c) => { err += c; return true; };
  try {
    await run({ positional, flags });
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return { out, err };
}
const cli = (...argv) => cliIn(r.dir, ...argv);

describe('decompose CLI', () => {
  test('--dry-run --summary prints one line per candidate and writes nothing', async () => {
    const { out } = await cli('--dry-run', '--summary', 'shop/**');
    assert.match(out, /^new {2}/m);
    assert.ok(!existsSync(join(r.dir, '.unknot/decompositions')));
  });

  test('--summary --json is an array of lines', async () => {
    const { out } = await cli('--summary', '--json', 'shop/**');
    const rows = JSON.parse(out);
    assert.ok(Array.isArray(rows) && rows.length >= 1);
    for (const l of rows) assert.deepEqual(Object.keys(l), ['id', 'name', 'size', 'treatment', 'confidence', 'next_rejected']);
  });

  test('a scope that selects nothing warns on stderr and in the text, and writes no record', async () => {
    const { out, err } = await cli('nowhere/**');
    assert.match(err, /scope "nowhere\/\*\*" matched 0 of \d+ modules/);
    assert.match(out, /matched 0 of \d+ modules/);
  });

  test('list and show work as the first positional', async () => {
    const full = JSON.parse((await cli('shop/**', '--json')).out);
    const id = full.recommendations[0].id;
    assert.match((await cli('list')).out, new RegExp(`${id}\\s`));
    assert.ok(JSON.parse((await cli('list', '--json')).out).some((x) => x.id === id));
    const text = (await cli('show', id)).out;
    assert.match(text, new RegExp(`^${id}`));
    assert.match(text, /Readiness/);
    assert.equal(JSON.parse((await cli('show', id, '--json')).out).id, id);
    await assert.rejects(cli('show'), { code: 'UK_SCHEMA_INVALID' });
  });

  test('--driver-source and --driver-quote record provenance per driver, repeatable, and a rerun keeps it', async () => {
    const url = 'https://example.com/plan?a=b';
    const args = ['--json', '--full', 'shop/**', '--driver', 'team_autonomy', '--driver', 'build_time'];
    const first = JSON.parse((await cli(...args, '--driver-source', `team_autonomy=${url}`, '--driver-quote', 'team_autonomy=Teams ship alone.', '--driver-quote', 'build_time=Builds take too long.')).out);
    const expected = [
      { driver: 'team_autonomy', source: url, quote: 'Teams ship alone.' },
      { driver: 'build_time', source: null, quote: 'Builds take too long.' },
    ];
    assert.deepEqual(first.details[0].driver_provenance, expected);
    assert.deepEqual(first.driver_provenance_missing, []);
    const rerun = JSON.parse((await cli(...args)).out);
    assert.deepEqual(rerun.details[0].driver_provenance, expected);
    assert.deepEqual(rerun.driver_provenance_missing, []);
    await assert.rejects(cli('shop/**', '--driver', 'team_autonomy', '--driver-source', 'security_isolation=https://example.com/x'), { code: 'UK_SCHEMA_INVALID' });
  });

  test('--drivers-file gives drivers with their sources and quotes; flags override it', async () => {
    const file = join(r.dir, 'drivers.json');
    writeFileSync(file, JSON.stringify([{ driver: 'independent_scale', source: 'docs/plan.md', quote: 'Billing must scale alone.' }, { driver: 'security_isolation', quote: 'Card data stays apart.' }]));
    const res = JSON.parse((await cli('--json', '--full', '--dry-run', 'shop/**', '--drivers-file', file, '--driver-source', 'security_isolation=docs/sec.md')).out);
    assert.deepEqual(res.drivers, ['independent_scale', 'security_isolation']);
    assert.deepEqual(res.details[0].driver_provenance, [
      { driver: 'independent_scale', source: 'docs/plan.md', quote: 'Billing must scale alone.' },
      { driver: 'security_isolation', source: 'docs/sec.md', quote: 'Card data stays apart.' },
    ]);
    writeFileSync(file, '{ nope');
    await assert.rejects(cli('shop/**', '--drivers-file', file), { code: 'UK_SCHEMA_INVALID' });
  });

  test('drivers without any provenance, and none to carry, are named at the top of the output', async () => {
    const { out } = await cli('shop/**', '--driver', 'technology_divergence', '--driver', 'availability_isolation');
    assert.match(out.split('\n')[0], /^Notice: no source or quote is recorded for drivers technology_divergence, availability_isolation, and none could be carried/);
    const summary = (await cli('shop/**', '--driver', 'technology_divergence', '--summary')).out;
    assert.match(summary.split('\n')[0], /^Notice: no source or quote is recorded for driver technology_divergence/);
    const given = (await cli('shop/**', '--driver', 'technology_divergence', '--driver-quote', 'technology_divergence=We want another stack.')).out;
    assert.doesNotMatch(given, /Notice:/);
    assert.doesNotMatch((await cli('shop/**')).out, /Notice:/);
  });

  test('--json carries scope with entries, matched, total and unresolved', async () => {
    const res = JSON.parse((await cli('shop/**', '--json')).out);
    assert.deepEqual(Object.keys(res.scope), ['entries', 'matched', 'total', 'unresolved']);
    assert.equal(res.scope.matched, 10);
  });

  test('text show lists the contract routes with their client interfaces, and says when none were looked for', async () => {
    const src = join(process.cwd(), 'tests/fixtures/clients/orders-client/src');
    const own = await analyse('modular-monolith', { extra: { ...group('orders', ['o0', 'o1', 'o2', 'o3', 'o4']), 'shop/orders/IOrdersApi.cs': readFileSync(join(src, 'Clients/IOrdersApi.cs'), 'utf8'), 'shop/orders/OrderService.cs': readFileSync(join(src, 'Orders/OrderService.cs'), 'utf8') }, skipDiagnose: true });
    const rows = JSON.parse((await cliIn(own.dir, 'shop/**', '--json')).out).recommendations;
    const text = (await cliIn(own.dir, 'show', rows[0].id)).out;
    assert.match(text, /^Contracts: contracts\.present 1, clients\.count 1/m);
    assert.match(text, /^ {2}GET \/v1\/orders\/: {2}\[client\] {2}1 client: IOrdersApi/m);
    assert.match(text, /^ {2}POST \/v1\/orders /m);
    const plain = (await cli('show', JSON.parse((await cli('shop/**', '--json')).out).recommendations[0].id)).out;
    assert.match(plain, /^Contracts: contracts\.present unmeasured, clients\.count unmeasured.*no route found/m);
  });

  test('the missing-provenance notice prints in the text and lists every driver', async () => {
    const { out } = await cli('shop/**', '--dry-run', '--driver', 'security_isolation', '--driver', 'independent_scale');
    assert.match(out, /^Notice: no source or quote is recorded for drivers security_isolation, independent_scale/m);
    assert.deepEqual(JSON.parse((await cli('shop/**', '--dry-run', '--json', '--driver', 'security_isolation', '--driver', 'independent_scale')).out).driver_provenance_missing, ['security_isolation', 'independent_scale']);
  });
});
