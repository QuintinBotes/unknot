CREATE TABLE orders (id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users (id));
