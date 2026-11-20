package com.example.shop.app;

import com.example.shop.api.OrdersController;
import com.example.shop.invoices.PdfInvoiceGateway;
import com.example.shop.orders.InvoiceGateway;
import com.example.shop.orders.OrderService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;

@Configuration
@ComponentScan(basePackageClasses = OrdersController.class)
public class AppConfig {
    @Bean
    public InvoiceGateway invoiceGateway() {
        return new PdfInvoiceGateway();
    }

    @Bean
    public OrderService orderService(InvoiceGateway invoices) {
        return new OrderService(invoices);
    }
}
