// Golden repository (h): deliberate anti-patterns AND legitimate complexity.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, assertKinds, assertWellFormed, ofKind } from './_harness.mjs';

const r = await analyse('essential-and-accidental');

test('essential/accidental: map is complete and detectors run cleanly', () => {
  assert.equal(r.mapped.status, 'complete');
  assert.deepEqual(r.errors, []);
});

test('essential/accidental: anti-patterns are found', () => {
  assertKinds(r.findings, ['code.deep-nesting', 'code.long-parameter-list', 'code.complex-function']);
  assert.ok(ofKind(r.findings, 'code.deep-nesting').some((f) => f.scope.includes('src/report.js')));
  assert.ok(ofKind(r.findings, 'code.long-parameter-list').some((f) => f.scope.includes('src/report.js')));
});

test('essential/accidental: the well-tested documented parser carries essential considerations and offers retain', () => {
  const parser = r.findings.filter((f) => f.scope.includes('src/parser.js'));
  assert.ok(parser.length > 0, 'the parser is measured');
  for (const f of parser) {
    assert.ok(f.essential_considerations.length > 0, `${f.kind} states what may be essential`);
    assert.ok(f.alternatives.some((a) => a.id === 'retain'), `${f.kind} offers retain`);
  }
  const complex = parser.find((f) => f.kind === 'code.complex-function');
  assert.ok(complex.measurements['tests.present'] >= 1, 'its test coverage is part of the evidence');
  assert.equal(complex.risk, 'low');
  assert.ok(complex.uncertainties !== undefined);
});

test('essential/accidental: the parser is not mistaken for dead code or a cycle', () => {
  assert.ok(!r.findings.some((f) => f.scope.includes('src/parser.js') && ['code.dead-code', 'module.dependency-cycle', 'code.duplicated-code'].includes(f.kind)));
  assert.ok(!r.findings.some((f) => f.scope.includes('test/parser.test.js')), 'tests are not analysed as production code');
});

test('essential/accidental: evidence provenance, retain alternative and risk sanity', () => {
  assertWellFormed(r.findings);
  for (const f of r.findings) assert.equal(f.risk, 'low');
});
