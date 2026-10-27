# 0002: PostgreSQL is the only required data service

- Status: accepted
- Date: 2026-10-27

## Context

Each install should start cheap (around $100 a month on a cloud) and run on a single machine for
the pilot. Every extra service (search cluster, Redis, message broker) adds a monthly minimum,
operations work and another thing to secure.

## Decision

PostgreSQL holds the data, the job queue and the default search index (full-text, trigram and
vector search). Redis, OpenSearch and cloud queues are optional adapters, added only when a
client's load tests show the need. Development and tests use PostgreSQL 16 or later; the Docker
Compose file runs PostgreSQL 18.

## Consequences

- One backup and one restore cover everything.
- Jobs can be enqueued in the same transaction as the change that causes them, so none are lost.
- Search quality and speed must be measured; the OpenSearch adapter is the planned exit for
  catalogs beyond about 250,000 products.
