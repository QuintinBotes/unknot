import { formatOrderResponse } from '../controllers/orderController.js';

const rows = [];

export function saveOrder(order) {
  rows.push(order);
  return formatOrderResponse({ id: rows.length, total: order.lines.length });
}
