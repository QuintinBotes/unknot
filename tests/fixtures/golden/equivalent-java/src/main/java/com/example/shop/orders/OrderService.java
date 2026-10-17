package com.example.shop.orders;

public class OrderService {
    private final InvoiceGateway invoices;

    public OrderService(InvoiceGateway invoices) {
        this.invoices = invoices;
    }

    public Order find(Long id) {
        Order order = new Order();
        order.setId(id);
        invoices.issue(order);
        return order;
    }
}
