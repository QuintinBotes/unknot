// Golden repository (b): healthy modular monolith. The point is the EXPECTED NON-FINDINGS.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, kinds } from './_harness.mjs';

const r = await analyse('modular-monolith');

test('modular monolith: map is complete and detectors run cleanly', () => {
  assert.equal(r.mapped.status, 'complete');
  assert.deepEqual(r.errors, []);
});

test('modular monolith: no structural findings', () => {
  const have = kinds(r.findings);
  for (const k of ['module.dependency-cycle', 'module.package-cycle', 'code.large-class', 'code.duplicated-code', 'module.hub-module', 'module.layer-bypass', 'code.complex-function', 'code.long-function', 'code.deep-nesting']) {
    assert.ok(!have.includes(k), `unexpected ${k}`);
  }
  assert.ok(!have.some((k) => /^(database|infrastructure|service|decomposition|frontend)\./.test(k)), `unexpected ${have.join(', ')}`);
});

test('modular monolith: nothing above low-severity noise', () => {
  for (const f of r.findings) {
    assert.equal(f.risk, 'low', `${f.kind} must not exceed low risk`);
    assert.ok(f.priority.score < 1, `${f.kind} priority ${f.priority.score} is not noise`);
  }
});

// A function passed by reference (`lines.map(lineTotal)`) is a use. The dead-code detector
// counts only calls and CALLS/REFERENCES edges, so it reports lineTotal as having no callers.
test('modular monolith: no dead-code findings', {}, () => {
  assert.ok(!kinds(r.findings).includes('code.dead-code'), JSON.stringify(r.findings.filter((f) => f.kind === 'code.dead-code').map((f) => f.title)));
});
