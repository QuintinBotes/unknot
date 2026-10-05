// Unreachable statements via extract.py. The lexical reader does not track control flow,
// so it reports none (documented limitation).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { all, extractFixture, find, hasPython, nodes, realExec, unsupportedExec } from './helpers.mjs';

test('python3: statements after return/raise/continue/break in the same body', { skip: !hasPython && 'python3 not available' }, async () => {
  const facts = all(await extractFixture('unreachable', realExec));
  const u = (name) => find(facts, `function:src/mod.py#${name}`).attrs.unreachable;
  assert.deepEqual(u('after_return'), [{ line: 3, after: 'return' }]);
  assert.deepEqual(u('after_raise'), [{ line: 9, after: 'raise' }]);
  assert.deepEqual(u('loop'), [{ line: 17, after: 'continue' }, { line: 19, after: 'break' }]);
  for (const name of ['raise_then_else', 'early', 'outer', 'outer.inner', 'cleanup']) assert.deepEqual(u(name), [], name);
});

test('lexical fallback reports no unreachable code', async () => {
  const facts = all(await extractFixture('unreachable', unsupportedExec));
  const fns = nodes(facts, 'function');
  assert.ok(fns.length > 0);
  for (const f of fns) assert.deepEqual(f.attrs.unreachable, []);
});
