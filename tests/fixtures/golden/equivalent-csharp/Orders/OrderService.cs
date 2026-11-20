namespace Shop.Orders;

public class OrderService
{
    private readonly InvoiceGateway _invoices;

    public OrderService(InvoiceGateway invoices)
    {
        _invoices = invoices;
    }

    public Order Find(int id)
    {
        var order = new Order { Id = id };
        _invoices.Issue(order);
        return order;
    }
}
