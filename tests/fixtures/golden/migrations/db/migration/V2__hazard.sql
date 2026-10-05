ALTER TABLE orders ALTER COLUMN total TYPE numeric(12,2);
CREATE INDEX orders_status_idx ON orders (status);
ALTER TABLE orders DROP COLUMN legacy;
ALTER TABLE orders RENAME COLUMN status TO state;
UPDATE orders SET state = 'migrated';
