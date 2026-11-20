import { Controller, Get, Param } from '@nestjs/common';
import { Order } from '../orders/order.entity';
import { OrderService } from '../orders/order.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrderService) {}

  @Get(':id')
  get(@Param('id') id: string): Order {
    return this.service.find(Number(id));
  }
}
