import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrder, orderTotal } from '../src/index.ts';

test('totals an order', () => {
  const order = createOrder('o1', [{ sku: 'a', quantity: 2, unit: { cents: 100, currency: 'USD' } }]);
  assert.equal(orderTotal(order.lines).cents, 200);
  assert.throws(() => createOrder('o2', []));
});
