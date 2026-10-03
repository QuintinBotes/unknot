CREATE OR REPLACE VIEW public.big_orders AS SELECT id FROM public.orders WHERE total > 1000;
