// Every strongly connected component the runtime view holds yields exactly one cycle finding: its
// members, the edges that would break it (declared-only ones named, an ordering heuristic past the
// exact-search size), ranked first under `--objective decompose`, shown by a scope holding any member.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'uk-cyc-home-'));
process.env.UNKNOT_HOME = home;

const { openProject } = await import('../../../runtime/context.mjs');
const { project } = await import('../../../runtime/graph/builder.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');

const p = prov({ source_type: 'ast', source_ref: 'x:1', extractor: 'test' });
const path = (i) => `d${i % 3}/m${i}.go`;
const mod = (file) => nodeFact('module', file, { name: file.split('/').pop(), path: file, attrs: { language: 'go', loc: 300, sloc: 200, is_test: false, parse_quality: 'ast' } }, p);
const imp = (a, b, attrs = {}) => edgeFact('IMPORTS', `module:${a}`, `module:${b}`, attrs, p);

/** A project whose modules 0..n-1 import their successor in a ring, plus `chords` extra imports each. */
function ring(n, { chords = 0, closing = {} } = {}) {
  const proj = mkdtempSync(join(tmpdir(), 'uk-cyc-proj-'));
  const facts = [];
  for (let i = 0; i < n; i++) facts.push(mod(path(i)));
  for (let i = 0; i < n; i++) {
    facts.push(imp(path(i), path((i + 1) % n), i === n - 1 ? closing : {}));
    for (let k = 2; k <= chords + 1; k++) facts.push(imp(path(i), path((i + k) % n)));
  }
  const ctx = openProject(proj, { create: true });
  project(ctx, facts, { commit: 'abc123', observedAt: '2026-01-01T00:00:00Z' });
  ctx.store.close();
  return proj;
}

const diagnose = (proj, ...args) => {
  const r = spawnSync(process.execPath, [BIN, 'diagnose', ...args, '--json', '--limit', '200', '--cwd', proj], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const cycles = (res) => res.findings.filter((f) => f.kind === 'module.dependency-cycle');
const cutLines = (f) => f.evidence.filter((e) => e.summary.startsWith('cut: '));

test('a 13-module cycle gives exactly one finding naming every member and the cut edge', () => {
  const proj = ring(13);
  const res = diagnose(proj, '--objective', 'decompose', '--all');
  const found = cycles(res);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].scope, Array.from({ length: 13 }, (_, i) => path(i)).sort());
  assert.equal(found[0].measurements['cycle.size'], 13);
  assert.equal(found[0].measurements['cycle.cut_edges'], 1);
  assert.equal(found[0].measurements['cycle.cut_heuristic'], undefined);
  assert.equal(cutLines(found[0]).length, 1);
});

test('a cut edge held only by an unused member is named declared-only', () => {
  const proj = ring(13, { closing: { declared_only: true, unused_member: 'Ledger', line: 7 } });
  const [f] = cycles(diagnose(proj, '--objective', 'decompose', '--all'));
  assert.equal(f.measurements['cycle.cut_declared_only'], 1);
  assert.match(cutLines(f)[0].summary, /declared-only: unused member Ledger/);
});

test('a component past the exact-search size gives one finding marked cut_heuristic', () => {
  const proj = ring(60, { chords: 2 });
  const found = cycles(diagnose(proj, '--objective', 'decompose', '--all'));
  assert.equal(found.length, 1);
  assert.equal(found[0].scope.length, 60, 'every member is in scope, not the first 50');
  assert.equal(found[0].measurements['cycle.cut_heuristic'], true);
  assert.ok(found[0].measurements['cycle.cut_edges'] > 0);
  assert.ok(cutLines(found[0]).length > 0);
});

test('a component closing only through a type-only import gives no finding, and graph cycles says why', () => {
  const proj = ring(13, { closing: { type_only: true } });
  assert.equal(cycles(diagnose(proj, '--objective', 'decompose', '--all')).length, 0);
  const r = spawnSync(process.execPath, [BIN, 'graph', 'cycles', '--cwd', proj], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no finding: closes only through lazy or type-only imports/);
});

test('a scope holding one member shows the finding and names the members outside it', () => {
  const proj = ring(60, { chords: 2 });
  for (const member of [path(0), path(59)]) {
    const [f] = cycles(diagnose(proj, member));
    assert.ok(f, `scope ${member}`);
    assert.equal(f.measurements['cycle.outside_scope'], 59);
    assert.ok(f.evidence.some((e) => /59 members outside the scope close this cycle/.test(e.summary)));
  }
});

test('--objective decompose lists the cycle before every non-cycle finding', () => {
  const proj = ring(13);
  const kinds = diagnose(proj, '--objective', 'decompose', '--all').findings.map((f) => f.kind);
  const last = kinds.lastIndexOf('module.dependency-cycle');
  assert.equal(kinds[0], 'module.dependency-cycle');
  assert.ok(kinds.slice(0, last + 1).every((k) => k.endsWith('-cycle')));
});
