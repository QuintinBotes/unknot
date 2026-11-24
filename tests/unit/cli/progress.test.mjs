// Progress on stderr for map and decompose: off by default off a terminal, forced by --progress,
// never on stdout (so --json stays parseable).

import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { analyse } from '../../golden/_harness.mjs';

const { progressFor } = await import('../../../runtime/cli/progress.mjs');
const { run: runMap } = await import('../../../runtime/cli/commands/map.mjs');
const { run: runDecompose } = await import('../../../runtime/cli/commands/decompose.mjs');
const { parseArgs } = await import('../../../runtime/cli/util.mjs');

async function cliIn(run, dir, ...argv) {
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

const r = await analyse('modular-monolith', { skipDiagnose: true });

describe('progressFor', () => {
  test('a stream that is not a terminal gets nothing by default', () => {
    assert.equal(progressFor({}, { stream: { isTTY: false, write() {} } }), null);
  });

  test('on a terminal it waits 5 s, then prints at most one line per 5 s, never with a carriage return', () => {
    let t = 0;
    const lines = [];
    const p = progressFor({}, { stream: { isTTY: true, write: (s) => lines.push(s) }, now: () => t });
    p(1, 10, 'map');
    t = 4999; p(2, 10, 'map');
    assert.equal(lines.length, 0);
    t = 5000; p(3, 10, 'map');
    t = 6000; p(4, 10, 'map');
    t = 10000; p(5, 10, 'map');
    assert.deepEqual(lines, ['unknot: map: 3 of 10, 5 s\n', 'unknot: map: 5 of 10, 10 s\n']);
  });

  test('--progress forces it off a terminal, from the first update', () => {
    const lines = [];
    const p = progressFor({ progress: true }, { stream: { isTTY: false, write: (s) => lines.push(s) }, now: () => 0 });
    p(1, 2, 'decompose');
    assert.equal(lines.length, 1);
  });
});

describe('map and decompose progress', () => {
  test('without the flag, stderr carries no progress (not a terminal)', async () => {
    assert.doesNotMatch((await cliIn(runMap, r.dir)).err, / of \d+, \d+ s/);
    assert.doesNotMatch((await cliIn(runDecompose, r.dir, '--dry-run')).err, / of \d+, \d+ s/);
  });

  test('--progress prints the phase and counts on stderr, and --json stdout stays JSON', async () => {
    // An unchanged tree is answered from the last map without work (#88): change a file so there is some.
    appendFileSync(join(r.dir, 'package.json'), ' ');
    const m = await cliIn(runMap, r.dir, '--progress', '--json');
    assert.match(m.err, /unknot: .*: \d+ of \d+, \d+ s\n/);
    assert.ok(!m.err.includes('\r'));
    assert.equal(JSON.parse(m.out).files > 0, true);
    const d = await cliIn(runDecompose, r.dir, '--progress', '--json', '--dry-run');
    assert.match(d.err, /unknot: .*: \d+ of \d+, \d+ s\n/);
    assert.ok(Array.isArray(JSON.parse(d.out).recommendations));
  });
});
