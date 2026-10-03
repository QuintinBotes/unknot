# 1. Use Postgres for orders

Date: 2023-03-14

## Status

Accepted

## Context

The `services/checkout/src` module needs transactional storage. Contact eve@example.com for history.

## Decision

We will use PostgreSQL as the system of record for orders. See https://example.com/docs/pg for details.

## Consequences

Operational burden moves to the platform team.
