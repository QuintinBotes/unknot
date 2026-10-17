namespace Shop.Orders;

public interface InvoiceGateway
{
    void Issue(Order order);
}
