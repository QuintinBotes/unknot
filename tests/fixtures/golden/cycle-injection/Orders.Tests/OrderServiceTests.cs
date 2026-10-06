using Shop.Orders;

namespace Shop.Orders.Tests
{
    public class OrderServiceTests
    {
        private readonly OrderService _orders;
        public OrderServiceTests(OrderService orders) { _orders = orders; }
        public void Places() { _orders.Place(); }
    }
}
