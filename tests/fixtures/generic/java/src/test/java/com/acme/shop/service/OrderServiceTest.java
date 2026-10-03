package com.acme.shop.service;

import org.junit.jupiter.api.Test;

public class OrderServiceTest {
    @Test
    void findsOrders() {
        new OrderService().find(1L);
    }
}
