# Roadmap

## v1 — implemented

| Milestone | Delivered behavior |
| --- | --- |
| 0. Foundation | Go, PostgreSQL, React, Docker, CI, readiness/liveness and graceful shutdown |
| 1. Destinations and protection | Admin and ingestion tokens, browser sessions, Goose schema, sqlc reads, encrypted secrets, URL/DNS controls and explicit private-network policy |
| 2. Receive and persist | Bounded JSON, atomic event/delivery transaction, stable IDs, exact-content idempotency and conflict handling |
| 3. Deliver and retry | Concurrent leased PostgreSQL claims, HMAC signatures, deadlines, attempt history, retry scheduling, crash recovery and stale-worker fencing |
| 4. Inspect and replay | Cursor-paginated metadata, attempt details, filtered histories, idempotent terminal replay, cancellation, redaction and retention |
| 5. Management UI | Session login, live overview, destinations, event composer/inspection, filtered deliveries, attempt history, replay and integration guidance |

Additional v1 operations include protected Prometheus metrics, setup-time secret
generation, a signature-verifying example receiver, OpenAPI documentation,
PostgreSQL concurrency tests, Docker end-to-end tests, and deployment/backup/
upgrade guidance. See [architecture](architecture.md) for exact invariants and
[operations](operations.md) for configuration and limitations.

## Boundaries

- One trusted team and shared admin identity per installation; no RBAC or user accounts.
- At-least-once delivery, finite retries, no ordering or exactly-once guarantee.
- One destination per accepted event; producers fan out explicitly when needed.
- JSON payloads; no arbitrary custom outbound headers or receiver response bodies.
- Individual replay and cancellation; no bulk replay job scheduler.
- Counts reflect retained history; no long-term analytics warehouse.
- No throughput SLA: validate your receiver latency, database/storage limits,
  traffic patterns, backup restore and egress policy before production use.

## Candidate follow-ups

These are intentionally not represented as current capabilities: scoped and
revocable per-producer tokens, user accounts/SSO and audit actors, per-destination
rate limits/fair scheduling, fan-out subscriptions, bulk replay jobs with progress,
archive export, retention legal holds, zero-downtime master-key rotation, and
measured capacity profiles. Multi-tenant SaaS and billing remain outside scope.
