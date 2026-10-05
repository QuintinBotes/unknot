import assert from 'node:assert/strict';
import { test } from 'node:test';

import adapter from '../../../../adapters/language/javascript/index.mjs';
import { extractOne, fnAttrs, runFixture } from './helpers.mjs';

const { facts } = runFixture('unreachable');
const u = (path, name) => fnAttrs(facts, `function:${path}#${name}`).unreachable;

test('adapter version was bumped for cache invalidation', () => {
  assert.equal(adapter.version, '0.1.1');
});

test('the diffHash shape: try/catch/finally that returns, then return finish()', () => {
  // The comment and the nested function declaration are not flagged: only line 12.
  assert.deepEqual(u('src/dead.js', 'diffHash'), [{ line: 12, after: 'return' }]);
  assert.deepEqual(u('src/dead.js', 'diffHash.helper'), []);
});

test('throw, continue/break and if-else with both branches returning', () => {
  assert.deepEqual(u('src/dead.js', 'afterThrow'), [{ line: 22, after: 'throw' }]);
  assert.deepEqual(u('src/dead.js', 'loopJump'), [{ line: 31, after: 'break' }]);
  assert.deepEqual(u('src/dead.js', 'ifElseBoth'), [{ line: 41, after: 'return' }]);
});

test('negatives: switch arms, guard returns, nested blocks, hoisting, type-only, try without catch return', () => {
  for (const name of ['arms', 'guard', 'nested', 'hoisted', 'hoisted.helper', 'typesAfter', 'tryNoCatch', 'callbacks']) {
    assert.deepEqual(u('src/live.ts', name), [], name);
  }
});

test('code after return inside a case arm is flagged, the next arm is not', () => {
  const src = 'export function f(x) {\n  switch (x) {\n    case 1:\n      return 1;\n      log();\n    case 2:\n      return 2;\n    default:\n      return 3;\n  }\n}\n';
  assert.deepEqual(fnAttrs(extractOne('src/a.js', src), 'function:src/a.js#f').unreachable, [{ line: 5, after: 'return' }]);
});

test('cap of 20 entries', () => {
  const body = Array.from({ length: 30 }, (_, i) => `  if (a${i}) {\n    return ${i};\n    dead${i}();\n  }`).join('\n');
  const attrs = fnAttrs(extractOne('src/b.js', `export function g() {\n${body}\n}\n`), 'function:src/b.js#g');
  assert.equal(attrs.unreachable.length, 20);
});
