import { Injectable } from '@nestjs/common';
import { InvoiceGateway } from './invoice-gateway';
import { Order } from './order.entity';

@Injectable()
export class OrderService {
  constructor(private readonly invoices: InvoiceGateway) {}

  find(id: number): Order {
    const order = new Order();
    order.id = id;
    this.invoices.issue(order);
    return order;
  }
}
