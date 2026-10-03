import { priceWithTax, Discount } from '@acme/pricing';
import type { Price } from '@acme/pricing';
import { addItem, type Cart } from '@app/cart';
import { total } from './totals.js';
import pad from 'left-pad';
import { readFileSync } from 'node:fs';
import missing from './missing';

export function checkout(cart: Cart, region: string): Price {
  const discount = new Discount(10);
  const base = priceWithTax(total(addItem(cart, pad('x', 3))), region);
  return discount.apply(base);
}

export class Checkout extends Discount implements Runnable {
  run() {
    return this.helper();
  }

  helper() {
    return readFileSync('x') && missing;
  }
}
