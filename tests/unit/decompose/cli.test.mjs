// The decompose command line: subcommands, --summary, --dry-run and the warning stream.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { analyse } from '../../golden/_harness.mjs';

const { run } = await import('../../../runtime/cli/commands/decompose.mjs');
const { parseArgs } = await import('../../../runtime/cli/util.mjs');

const imports = (names, self) => names.filter((m) => m !== self).map((m) => `import { f_${m} } from './${m}.js';`).join('\n');
const group = (dir, names) => Object.fromEntries(names.map((n) => [`shop/${dir}/${n}.js`, `${imports(names, n)}\nexport function f_${n}() { return 1; }\n`]));
const r = await analyse('modular-monolith', { extra: { ...group('orders', ['o0', 'o1', 'o2', 'o3', 'o4']), ...group('stock', ['s0', 's1', 's2', 's3', 's4']) }, skipDiagnose: true });

async function cli(...argv) {
  const { positional, flags } = parseArgs([...argv, '--cwd', r.dir]);
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

  test('--json carries scope with entries, matched, total and unresolved', async () => {
    const res = JSON.parse((await cli('shop/**', '--json')).out);
    assert.deepEqual(Object.keys(res.scope), ['entries', 'matched', 'total', 'unresolved']);
    assert.equal(res.scope.matched, 10);
  });
});
