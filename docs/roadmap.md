# Roadmap

Only the foundation is implemented. Each milestone should deliver a reviewable,
tested vertical slice; define its detailed contract when starting that work.

## 0. Foundation — implemented

Go API skeleton, PostgreSQL readiness, React status page, local development,
Docker image/Compose, CI checks, and contributor/agent documentation.

## 1. Destinations and API protection

Protect the management/ingestion boundary, define destination ownership for a
single-team installation, introduce Goose/sqlc and the first schema, and configure
destination URLs and signing secrets. Include destination validation and the
private-network access policy before enabling outbound requests.

## 2. Receive and persist events

Define the ingestion contract, payload limits, identifiers, and idempotency
behavior. Persist the event and initial delivery work atomically. Demonstrate
that failed transactions cannot return successful acceptance.

## 3. Deliver and retry

Implement safe concurrent claiming, signed HTTP delivery, deadlines, persisted
attempts, retry policy, and restart recovery. Test receiver outages, timeouts,
duplicate delivery, expired claims, and multiple workers against PostgreSQL.

## 4. Inspect and replay

Expose paginated event/delivery/attempt history and an authenticated replay
operation that preserves earlier attempts. Define retention and redaction behavior.

## 5. Management UI

Build destination management, event inspection, delivery status, and replay flows
on the implemented API. Introduce routing and server-state tooling as needed.

Before a public release, document deployment, secret handling, upgrades, backups,
retention, and measured operational limits. No multi-tenant SaaS or billing is
planned for this first version.
