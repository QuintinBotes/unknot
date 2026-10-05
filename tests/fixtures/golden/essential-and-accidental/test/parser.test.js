import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/parser.js';

test('numbers and strings', () => {
  assert.deepEqual(tokenize('12.5 "hi"'), [{ type: 'num', value: 12.5 }, { type: 'str', value: 'hi' }]);
});

test('every operator', () => {
  for (const op of ["+","-","*","/","%","^","==","!=","<",">","<=",">=","&&","||"]) {
    assert.equal(tokenize('1 ' + op + ' 2')[1].value, op);
  }
});

test('error paths', () => {
  assert.throws(() => tokenize('"open'), /unterminated/);
  assert.throws(() => tokenize('#'), /unexpected/);
});
