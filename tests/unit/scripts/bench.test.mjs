import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GATES, RELEASE_GATES, gate, generateFixture, touch } from '../../../scripts/bench.mjs';
import { mkTmp } from '../../helpers/tmp.mjs';

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
  const a = mkTmp(join(tmpdir(), 'uk-bench-a-'));
  const b = mkTmp(join(tmpdir(), 'uk-bench-b-'));
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

test('the bench gate checks the ratios of #88 against their bounds', () => {
  assert.deepEqual(GATES, { unchanged_vs_cold: 0.1, changed_vs_unchanged: 2, store_vs_tree: 3 });
  const run = (cold, unchanged, changed, store, tree) => gate({ cold: { wall_ms: cold }, unchanged: { wall_ms: unchanged }, incremental: { wall_ms: changed }, store_bytes: store, tree_bytes: tree });
  assert.deepEqual(run(100, 10, 20, 30, 10), { ratios: { unchanged_vs_cold: 0.1, changed_vs_unchanged: 2, store_vs_tree: 3 }, over: [] }, 'each bound is inclusive');
  assert.deepEqual(run(100, 11, 23, 31, 10).over, ['unchanged_vs_cold', 'changed_vs_unchanged', 'store_vs_tree']);
  assert.deepEqual(run(100, 5, 11, 1, 10).over, ['changed_vs_unchanged']);
});

test('the release gate checks only the bounds main meets: no change and changed against cold', () => {
  assert.deepEqual(RELEASE_GATES, { unchanged_vs_cold: 0.1, changed_vs_cold: 0.5 });
  const run = (cold, unchanged, changed) => gate({ cold: { wall_ms: cold }, unchanged: { wall_ms: unchanged }, incremental: { wall_ms: changed }, store_bytes: 50, tree_bytes: 1 }, RELEASE_GATES);
  assert.deepEqual(run(100, 10, 50), { ratios: { unchanged_vs_cold: 0.1, changed_vs_cold: 0.5 }, over: [] }, 'each bound is inclusive; store size is not gated');
  assert.deepEqual(run(100, 2, 51).over, ['changed_vs_cold']);
  assert.deepEqual(run(100, 11, 20).over, ['unchanged_vs_cold']);
});
