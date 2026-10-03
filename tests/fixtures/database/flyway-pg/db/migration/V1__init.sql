-- Baseline schema for the orders service.
CREATE TABLE public.customers (
  id bigserial PRIMARY KEY,
  email varchar(200) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.orders (
  id bigserial PRIMARY KEY,
  customer_id bigint NOT NULL,
  total integer NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'new',
  CONSTRAINT orders_total_check CHECK (total >= 0)
);

CREATE VIEW public.big_orders AS
  SELECT o.id, c.email FROM public.orders o JOIN public.customers c ON c.id = o.customer_id WHERE o.total > 1000;

GRANT SELECT, INSERT, UPDATE ON TABLE public.orders TO app_rw;
