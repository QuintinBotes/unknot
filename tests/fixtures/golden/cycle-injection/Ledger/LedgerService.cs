using Shop.Orders;

namespace Shop.Ledger
{
    public class LedgerService
    {
        [Dependency]
        public OrderService Peer { get; set; }
        public void Post() { }
    }
}
