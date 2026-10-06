import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateFixture, touch } from '../../../scripts/bench.mjs';

const listing = (dir) => {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listing(p).map((x) => `${e.name}/${x}`));
    else out.push(`${e.name}:${statSync(p).size}`);
  }
  return out.sort();
};

test('the multi-language fixture is deterministic and covers five languages with tests', () => {
  const a = mkdtempSync(join(tmpdir(), 'uk-bench-a-'));
  const b = mkdtempSync(join(tmpdir(), 'uk-bench-b-'));
  try {
    const pa = generateFixture(a, 1000);
    generateFixture(b, 1000);
    assert.deepEqual(listing(a), listing(b));
    for (const ext of ['ts', 'py', 'cs', 'java', 'go']) assert.ok(pa.some((p) => p.endsWith(`.${ext}`)), ext);
    assert.ok(pa.some((p) => /Tests\.cs$/.test(p)) && pa.some((p) => /Test\.java$/.test(p)) && pa.some((p) => /_test\.go$/.test(p)));
    const cs = pa.find((p) => p.endsWith('.cs') && !p.endsWith('Tests.cs'));
    assert.match(readFileSync(join(a, cs), 'utf8'), /namespace Bench\.Mod\d+\.Sub\d;/);
    for (const p of pa.filter((x) => /\.(cs|java)$/.test(x)).slice(0, 5)) {
      assert.ok(touch(p, readFileSync(join(a, p), 'utf8')).includes('ouched'));
    }
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
