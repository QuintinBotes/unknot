from shop.orders.models import Order
from shop.orders.ports import InvoiceGateway


class OrderService:
    def __init__(self, invoices: InvoiceGateway):
        self.invoices = invoices

    def find(self, order_id: int) -> Order:
        order = Order(id=order_id)
        self.invoices.issue(order)
        return order
