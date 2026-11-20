import { Order } from './order.entity';

export abstract class InvoiceGateway {
  abstract issue(order: Order): void;
}
