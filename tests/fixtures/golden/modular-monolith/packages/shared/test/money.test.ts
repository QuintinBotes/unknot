import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, addMoney } from '../src/index.ts';

test('adds money', () => {
  assert.equal(addMoney(money(100), money(250)).cents, 350);
});
