import { OrderManager } from './services/OrderManager.js';
import { createOrder } from './controllers/orderController.js';
import { createInvoice } from './controllers/invoiceController.js';

export const manager = new OrderManager();

export function start() {
  return [createOrder, createInvoice];
}
