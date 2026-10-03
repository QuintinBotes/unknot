-- Hazard: rewrites the whole (large) orders table under ACCESS EXCLUSIVE.
ALTER TABLE public.orders ALTER COLUMN total TYPE bigint;
