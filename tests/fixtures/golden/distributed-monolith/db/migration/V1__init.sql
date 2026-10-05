CREATE TABLE orders (
  id bigint PRIMARY KEY,
  customer_id bigint NOT NULL,
  status text NOT NULL,
  paid boolean NOT NULL DEFAULT false,
  shipped boolean NOT NULL DEFAULT false
);

CREATE TABLE customers (
  id bigint PRIMARY KEY,
  email text NOT NULL
);
