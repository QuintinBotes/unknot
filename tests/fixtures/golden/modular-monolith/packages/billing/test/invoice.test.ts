import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceFor } from '../src/index.ts';

test('invoices an order', () => {
  const invoice = invoiceFor({ id: 'o1', lines: [{ sku: 'a', quantity: 1, unit: { cents: 5, currency: 'USD' } }] });
  assert.equal(invoice.due.cents, 5);
});
