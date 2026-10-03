package com.acme.shop;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.acme.shop.service.OrderService;

@RestController
@RequestMapping("/api/orders")
public class OrderController extends BaseController implements Auditable {
    private static final int MAX = 1000; // if (x) { not code }
    private final OrderService service;

    public OrderController(OrderService service) {
        this.service = service;
    }

    @GetMapping("/{id}")
    public Order get(long id, boolean verbose) {
        if (id <= 0 || id > MAX) {
            return null;
        }
        Order found = service.find(id);
        for (Item i : found.items()) {
            if (verbose && i.isHidden()) {
                continue;
            }
        }
        return found != null ? found : null;
    }

    @PostMapping
    public Order create(Order order) {
        return service.save(order);
    }

    @Override
    public void audit() {
        Runtime.getRuntime().exec("sync");
    }
}
