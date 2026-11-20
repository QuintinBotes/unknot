import { Injectable } from '@nestjs/common';
import { InvoiceGateway } from '../orders/invoice-gateway';
import { Order } from '../orders/order.entity';

@Injectable()
export class PdfInvoiceGateway extends InvoiceGateway {
  issue(order: Order): void {}
}
