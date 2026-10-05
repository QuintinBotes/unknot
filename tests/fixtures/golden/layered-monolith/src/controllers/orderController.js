import { placeOrder } from '../services/orderService.js';

export function createOrder(req) {
  return placeOrder(req.body);
}

export function formatOrderResponse(order) {
  return { id: order.id, total: order.total };
}
