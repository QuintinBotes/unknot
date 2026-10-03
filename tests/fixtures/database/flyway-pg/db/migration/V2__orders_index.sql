-- Hazard: plain CREATE INDEX takes a SHARE lock and blocks writes.
CREATE INDEX idx_orders_customer ON public.orders (customer_id);
