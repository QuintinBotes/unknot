from shop.orders.models import Order
from shop.orders.ports import InvoiceGateway


class PdfInvoiceGateway(InvoiceGateway):
    def issue(self, order: Order) -> None:
        pass
