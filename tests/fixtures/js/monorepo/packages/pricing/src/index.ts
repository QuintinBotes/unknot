import { vat } from './tax.js';

export interface Price {
  net: number;
  gross: number;
}

export function priceWithTax(net: number, region: string): Price {
  const rate = vat(region);
  return { net, gross: net * (1 + rate) };
}

export class Discount {
  constructor(private pct: number) {}

  apply(price: Price): Price {
    if (this.pct <= 0 || this.pct > 100) {
      return price;
    }
    return { net: price.net * (1 - this.pct / 100), gross: price.gross };
  }
}

export { vat } from './tax.js';
