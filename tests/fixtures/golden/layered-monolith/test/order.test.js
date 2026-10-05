import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeOrder } from '../src/services/orderService.js';

test('rejects empty', () => {
  assert.throws(() => placeOrder(null));
});
