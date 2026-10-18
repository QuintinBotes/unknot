from abc import ABC, abstractmethod

from shop.orders.models import Order


class InvoiceGateway(ABC):
    @abstractmethod
    def issue(self, order: Order) -> None:
        ...
