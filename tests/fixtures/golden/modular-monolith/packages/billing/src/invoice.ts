import { orderTotal } from '@shop/orders';
import type { Order } from '@shop/orders';
import type { Money } from '@shop/shared';

export interface Invoice {
  orderId: string;
  due: Money;
}

export function invoiceFor(order: Order): Invoice {
  return { orderId: order.id, due: orderTotal(order.lines) };
}
