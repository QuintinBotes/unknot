from fastapi import APIRouter

from shop.orders.service import OrderService

router = APIRouter(prefix="/orders")


def build_routes(service: OrderService) -> APIRouter:
    @router.get("/{order_id}")
    def get_order(order_id: int):
        return service.find(order_id)

    return router
