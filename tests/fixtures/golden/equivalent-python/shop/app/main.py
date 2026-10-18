from fastapi import FastAPI
from injector import Binder, Injector

from shop.api.routes import build_routes
from shop.invoices.pdf import PdfInvoiceGateway
from shop.orders.ports import InvoiceGateway
from shop.orders.service import OrderService


def configure(binder: Binder) -> None:
    binder.bind(InvoiceGateway, to=PdfInvoiceGateway)


container = Injector([configure])
app = FastAPI()
app.include_router(build_routes(container.get(OrderService)))
