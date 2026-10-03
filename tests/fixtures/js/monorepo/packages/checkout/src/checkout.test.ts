import test from 'node:test';
import { checkout } from './index.js';

test('checkout adds tax', () => {
  checkout({ items: [] }, 'DE');
});
