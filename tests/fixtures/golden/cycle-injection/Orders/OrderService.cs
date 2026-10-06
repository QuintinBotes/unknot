using Shop.Invoices;

namespace Shop.Orders
{
    public class OrderService
    {
        private readonly InvoiceService _invoices;
        public OrderService(InvoiceService invoices) { _invoices = invoices; }
        public void Place() { _invoices.Issue(); }
    }
}
