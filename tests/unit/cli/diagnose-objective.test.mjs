// `unknot diagnose --objective decompose` puts the cycle and the unused dependency that closes it
// first and folds the generic code-style findings into one count; without it nothing changes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'uk-diagobj-home-'));
const proj = mkdtempSync(join(tmpdir(), 'uk-diagobj-proj-'));
process.env.UNKNOT_HOME = home;

const { openProject } = await import('../../../runtime/context.mjs');
const { project } = await import('../../../runtime/graph/builder.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');
const { applyObjective, relevance } = await import('../../../runtime/diagnose/objectives.mjs');

const p = prov({ source_type: 'ast', source_ref: 'x:1', extractor: 'test' });
const mod = (path) => nodeFact('module', path, { name: path.split('/').pop(), path, attrs: { language: 'cs', loc: 300, sloc: 200, is_test: false, parse_quality: 'ast' } }, p);
const imp = (a, b, attrs = {}) => edgeFact('IMPORTS', `module:${a}`, `module:${b}`, attrs, p);
const LONG = 12;
const fn = (name) => nodeFact('function', `src/a.cs#${name}`, {
  name, path: 'src/a.cs',
  attrs: { start_line: 10, end_line: 149, lines: 140, params: 1, cyclomatic: 1, cognitive: 1, max_nesting: 1, exported: true, kind: 'function' },
}, p);

before(() => {
  const ctx = openProject(proj, { create: true });
  const names = Array.from({ length: LONG }, (_, i) => `longFn${i}`);
  project(
    ctx,
    [
      mod('src/a.cs'), mod('src/b.cs'),
      imp('src/a.cs', 'src/b.cs'),
      imp('src/b.cs', 'src/a.cs', { declared_only: true, unused_member: 'Ledger', member_visibility: 'public', line: 7 }),
      ...names.map(fn),
      ...names.map((n) => edgeFact('CONTAINS', 'module:src/a.cs', `function:src/a.cs#${n}`, {}, p)),
    ],
    { commit: 'abc123', observedAt: '2026-01-01T00:00:00Z' },
  );
  ctx.store.close();
});

const diagnose = (...args) => {
  const r = spawnSync(process.execPath, [BIN, 'diagnose', ...args, '--cwd', proj], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const json = (...args) => JSON.parse(diagnose(...args, '--json', '--limit', '100'));

test('decompose: the cycle and the unused dependency come first, long functions are one folded count', () => {
  const res = json('--objective', 'decompose');
  assert.equal(res.objective, 'decompose');
  assert.equal(res.hidden, LONG);
  assert.deepEqual(res.hidden_kinds, { 'code.long-function': LONG });
  const kinds = res.findings.map((f) => f.kind);
  assert.equal(kinds[0], 'module.dependency-cycle');
  assert.ok(kinds.includes('code.unused-injected-member'), 'the unused dependency closing the cycle stays');
  assert.ok(!kinds.includes('code.long-function'));
  const text = diagnose('--objective', 'decompose');
  assert.match(text, new RegExp(`${LONG} code-style findings hidden \\(--all to show\\)`));
  assert.doesNotMatch(text, /code\.long-function/);
});

test('decompose --all lists the folded findings after the relevant ones', () => {
  const res = json('--objective', 'decompose', '--all');
  assert.equal(res.hidden, 0);
  assert.deepEqual(res.hidden_kinds, {});
  const kinds = res.findings.map((f) => f.kind);
  assert.equal(kinds.filter((k) => k === 'code.long-function').length, LONG);
  assert.equal(kinds[0], 'module.dependency-cycle');
  assert.ok(kinds.lastIndexOf('code.unused-injected-member') < kinds.indexOf('code.long-function'));
  assert.doesNotMatch(diagnose('--objective', 'decompose', '--all'), /hidden/);
});

test('without --objective the output is the previous output; free-text objectives are untouched', () => {
  const res = json();
  assert.equal(res.objective, undefined);
  assert.equal(res.hidden, undefined);
  assert.equal(res.hidden_kinds, undefined);
  assert.equal(res.findings.filter((f) => f.kind === 'code.long-function').length, LONG);
  assert.doesNotMatch(diagnose(), /hidden/);
  const free = json('--objective', 'reduce deployment coupling');
  assert.equal(free.hidden, undefined);
  assert.equal(free.findings.length, res.findings.length);
});

test('simplify keeps the current order; security ranks security kinds first', () => {
  assert.deepEqual(json('--objective', 'simplify').findings.map((f) => f.id), json().findings.map((f) => f.id));
  assert.equal(json('--objective', 'simplify').hidden, 0);
  const items = [{ kind: 'code.long-function' }, { kind: 'security.secret-exposure' }, { kind: 'delivery.broad-ci-permissions' }];
  assert.deepEqual(applyObjective(items, 'security').findings.map((f) => f.kind), ['security.secret-exposure', 'delivery.broad-ci-permissions', 'code.long-function']);
  assert.equal(applyObjective(items, 'free text'), null);
  assert.equal(relevance('decompose', 'code.large-module'), 'related');
  assert.equal(relevance('decompose', 'code.large-class'), 'folded');
});
