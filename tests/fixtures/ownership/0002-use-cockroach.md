# 2. Use CockroachDB for orders

Date: 2024-06-01

## Status

Accepted

Supersedes [1. Use Postgres for orders](0001-use-postgres.md)

## Context

Multi-region writes are required for `services/checkout`.

## Decision

Orders move to CockroachDB.
