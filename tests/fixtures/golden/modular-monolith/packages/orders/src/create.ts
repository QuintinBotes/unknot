import type { Order, OrderLine } from './model.ts';

export function createOrder(id: string, lines: OrderLine[]): Order {
  if (lines.length === 0) {
    throw new Error('an order needs at least one line');
  }
  return { id, lines };
}
