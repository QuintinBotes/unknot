// The api-compatibility check: a removed public member that the graph marks declared-only
// (unused anywhere in the repository) passes with a note; any other removed symbol fails.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHECKS } from '../../../runtime/verify/checks.mjs';
import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { Graph } from '../../../runtime/graph/graph.mjs';

const P = prov({ source_type: 'ast', source_ref: 't.cs:1', extractor: 'test@0.0.1', confidence: 'high' });
const mod = (path, attrs = {}) => nodeFact('module', path, { name: path, path, attrs: { language: 'csharp', ...attrs } }, P);
const imp = (a, b, attrs = {}) => edgeFact('IMPORTS', `module:${a}`, `module:${b}`, attrs, P);
const unused = (member, member_visibility = 'public') => ({ declared_only: true, unused_member: member, member_visibility });

const run = (before, after, path = 'S/Host.cs') => CHECKS.api({ pair: { before: Graph.fromFacts(before), after: Graph.fromFacts(after) }, changes: [{ path, status: 'M' }] });

test('api: removing a public member the graph marks declared-only passes with a note', () => {
  const before = [mod('S/Host.cs', { public_members: ['Ledger'] }), mod('S/Ledger.cs'), imp('S/Host.cs', 'S/Ledger.cs', unused('Ledger'))];
  const after = [mod('S/Host.cs'), mod('S/Ledger.cs')];
  const r = run(before, after);
  assert.equal(r.verdict, 'pass');
  assert.match(r.data.note, /Ledger/);
  assert.match(r.data.note, /public but unused in this repository; consumers outside it are not visible/);
  assert.deepEqual(r.data.unused_public, ['S/Host.cs: member Ledger']);
});

test('api: a removed public member that is used (ordinary edge) still fails', () => {
  const before = [mod('S/Host.cs', { public_members: ['Ledger'] }), mod('S/Ledger.cs'), imp('S/Host.cs', 'S/Ledger.cs')];
  const r = run(before, [mod('S/Host.cs'), mod('S/Ledger.cs')]);
  assert.equal(r.verdict, 'fail');
  assert.match(r.detail, /member Ledger/);
});

test('api: any other removed symbol fails even next to an unused one', () => {
  const before = [mod('S/Host.cs', { public_members: ['Ledger'], exports: [{ name: 'Run' }] }), mod('S/Ledger.cs'), imp('S/Host.cs', 'S/Ledger.cs', unused('Ledger'))];
  const r = run(before, [mod('S/Host.cs'), mod('S/Ledger.cs')]);
  assert.equal(r.verdict, 'fail');
  assert.match(r.detail, /export Run/);
  assert.deepEqual(r.data.removed, ['S/Host.cs: export Run']);
});

test('api: an unchanged public surface still passes without a note', () => {
  const f = [mod('S/Host.cs', { public_members: ['Ledger'] })];
  const r = run(f, f);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.data.note, undefined);
});
