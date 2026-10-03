package com.acme.shop;

import javax.persistence.Entity;
import javax.persistence.Table;

@Entity
@Table(name = "orders")
public class Order {
    private long id;

    public long getId() {
        return id;
    }
}
