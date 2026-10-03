package com.acme.shop.service;

import com.acme.shop.Order;
import com.acme.shop.*;

public class OrderService {
    public Order find(long id) {
        return new Order();
    }

    public Order save(Order order) {
        String sql = "INSERT INTO orders (id) VALUES (" + order.getId() + ")";
        return order;
    }
}
