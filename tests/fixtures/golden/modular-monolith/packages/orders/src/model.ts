import type { Money } from '@shop/shared';

export interface OrderLine {
  sku: string;
  quantity: number;
  unit: Money;
}

export interface Order {
  id: string;
  lines: OrderLine[];
}
