import { Module } from '@nestjs/common';
import { OrdersController } from '../api/orders.controller';
import { PdfInvoiceGateway } from '../invoices/pdf-invoice-gateway';
import { InvoiceGateway } from '../orders/invoice-gateway';
import { OrderService } from '../orders/order.service';

@Module({
  controllers: [OrdersController],
  providers: [OrderService, { provide: InvoiceGateway, useClass: PdfInvoiceGateway }],
})
export class AppModule {}
