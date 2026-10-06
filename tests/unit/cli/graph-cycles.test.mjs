// Issue #13: the elementary-cycle cap is a flag, hitting it is announced, and every listed cycle
// names its cut candidates, ranked by how many listed cycles each edge is in.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'uk-cyc-home-'));
const proj = mkdtempSync(join(tmpdir(), 'uk-cyc-proj-'));
process.env.UNKNOT_HOME = home;

const { openProject } = await import('../../../runtime/context.mjs');
const { project } = await import('../../../runtime/graph/builder.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');

const p = prov({ source_type: 'ast', source_ref: 'x:1', extractor: 'test' });
const names = ['a', 'b', 'c', 'd', 'e', 'f'];

before(() => {
  // Six modules that all import each other: hundreds of elementary cycles in one component.
  const facts = names.map((n) => nodeFact('module', `src/ledger/${n}.ts`, { name: n, path: `src/ledger/${n}.ts`, attrs: {} }, p));
  for (const x of names) for (const y of names) if (x !== y) facts.push(edgeFact('IMPORTS', `module:src/ledger/${x}.ts`, `module:src/ledger/${y}.ts`, {}, p));
  const ctx = openProject(proj, { create: true });
  project(ctx, facts, { commit: 'abc123', observedAt: '2026-01-01T00:00:00Z' });
  ctx.store.close();
});

const cycles = (...args) => {
  const r = spawnSync(process.execPath, [BIN, 'graph', 'cycles', ...args, '--cwd', proj], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const json = (...args) => JSON.parse(cycles(...args, '--json').out);

test('the default cap is announced when hit, and --max-cycles raises it', () => {
  const [c] = json();
  assert.equal(c.cycles_truncated, true);
  assert.match(cycles().out, /stopped at \d+; more exist: raise --max-cycles, or --max-cycles all/);
  const [more] = json('--max-cycles', '120');
  assert.ok(more.cycles.length > c.cycles.length && more.cycles.length <= 120);
  const [few] = json('--max-cycles', '5');
  assert.equal(few.cycles.length, 5);
  assert.equal(few.cycles_truncated, true);
});

test('every listed cycle names cut candidates, most shared first, deterministically', () => {
  const [c] = json('--max-cycles', '40');
  for (const y of c.cycles) {
    assert.ok(y.cut_candidates.length >= 1);
    const counts = y.cut_candidates.map((e) => e.in_cycles);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  }
  assert.deepEqual(json('--max-cycles', '40'), [c], 'same output on a second run');
  assert.match(cycles('--max-cycles', '3').out, /cut here: src\/ledger\/\w\.ts → src\/ledger\/\w\.ts \(in \d+ of the listed cycles\)/);
});
