// A large repository must reach extract.py in several small batches: the broker truncates a
// command's output at 16 MiB, and files after the cut used to fall back to the lexical reader.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import adapter, { batches } from '../../../../adapters/language/python/index.mjs';
import { lexicalAnalyze } from '../../../../adapters/language/python/lexical.mjs';

const item = (i, size = 10) => ({ file: { path: `m${i}.py` }, text: 'x'.repeat(size) });

test('batches: bounded by file count and by text size, order kept, nothing lost', () => {
  const many = Array.from({ length: 700 }, (_, i) => item(i));
  const byCount = batches(many);
  assert.ok(byCount.length >= 3);
  assert.ok(byCount.every((b) => b.length <= 300));
  assert.deepEqual(byCount.flat().map((x) => x.file.path), many.map((x) => x.file.path));

  const big = Array.from({ length: 10 }, (_, i) => item(i, 700_000));
  const bySize = batches(big);
  assert.ok(bySize.length >= 5);
  assert.deepEqual(bySize.flat().length, 10);
  // A single file larger than the budget still gets its own batch.
  assert.deepEqual(batches([item(0, 5_000_000)]).map((b) => b.length), [1]);
  assert.deepEqual(batches([]), []);
});

test('extractBatch runs the AST extractor once per batch and every file keeps its AST record', async () => {
  const items = Array.from({ length: 650 }, (_, i) => ({ file: { path: `m${i}.py` }, text: 'x = 1\n' }));
  const sizes = [];
  const exec = async (_argv, { input }) => {
    const sent = JSON.parse(input);
    sizes.push(sent.length);
    const stdout = sent.map((s) => JSON.stringify({ path: s.path, ...lexicalAnalyze(s.path, s.text) })).join('\n');
    return { exitCode: 0, stdout, stderr: '' };
  };
  const notes = [];
  const out = await adapter.extractBatch(items, { exec, notes });
  assert.ok(sizes.length >= 3);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 650);
  assert.equal(out.size, 650);
  for (const facts of out.values()) assert.equal(facts.find((f) => f.type === 'module').attrs.parse_quality, 'ast');
  assert.deepEqual(notes, []);
});
