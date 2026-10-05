CREATE TABLE customers (id bigint PRIMARY KEY, email text NOT NULL);
CREATE TABLE orders (
  id bigint PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers (id),
  warehouse_id bigint,
  total integer NOT NULL,
  status text,
  legacy text
);
CREATE TABLE order_items (id bigint PRIMARY KEY, order_id bigint NOT NULL, sku text);
CREATE TABLE warehouses (id bigint PRIMARY KEY, name text);
CREATE INDEX orders_customer_idx ON orders (customer_id);
CREATE INDEX orders_customer_status_idx ON orders (customer_id, status);
