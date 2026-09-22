# Architecture

## Current implementation

Hooklane is a single Go module with a React application in the same repository.
The Go process owns configuration, the HTTP server, and a bounded pgx connection
pool. PostgreSQL is currently used only by the readiness probe; there are no
business tables or delivery workers.

In local development, Vite serves the frontend and proxies requests to Go. In
Docker, Go serves the compiled static files, so self-hosting needs only an
application container and PostgreSQL. There is no authentication yet; Compose
publishes ports on loopback and is a local foundation, not a public deployment.

| Interface | Behavior |
| --- | --- |
| `GET /healthz` | `200 {"status":"ok"}` while HTTP is serving; never probes the database |
| `GET /readyz` | `200 {"status":"ok"}` if PostgreSQL responds within the configured deadline; otherwise `503 {"status":"unavailable"}` |
| `GET /` | Compiled frontend when `WEB_DIR` is configured |

Health responses are not cached and do not expose driver errors. Unknown paths
return 404 rather than silently serving the frontend. No business API exists yet.
On SIGINT/SIGTERM, the server drains HTTP requests before closing the database
pool. Startup does not require a live database connection, allowing readiness to
recover without a process restart.

## Decisions

- **Go standard library for HTTP and logging.** Add libraries only for demonstrated
  needs. Keep packages small and responsibility-oriented, without generic layers.
- **PostgreSQL for durable state and the future work queue.** It enables atomic
  event/delivery persistence without coordinating a separate broker. Queue design
  and throughput must be validated when delivery is implemented.
- **SQL-first persistence.** Introduce Goose migrations and sqlc-generated pgx
  queries with the first business schema. Do not add placeholder migrations.
- **React + strict TypeScript + Vite.** The management UI does not need server-side
  rendering. Add routing and a server-state library when real screens require them.
- **One deployable application image.** Multi-stage Docker builds keep build tools
  out of the non-root runtime; PostgreSQL data lives in a named volume.
- **Reproducible checks.** Make is the local and CI entrypoint. Runtime versions,
  tools, package versions, and dependency lockfiles are recorded in the repository.

## Target responsibilities

The API will authenticate callers, validate destinations/events, and persist
accepted work. A worker will claim due deliveries, make bounded HTTP requests,
and record results. Both will share PostgreSQL. A separate worker command can be
introduced when needed; there is intentionally no empty process today.

The initial product serves one team per installation with multiple destinations.
Organizations, multi-tenant isolation, billing, and managed SaaS infrastructure are
outside the initial scope. API contracts will be documented alongside their first
implementation; no speculative business endpoints are promised here.

## Future delivery invariants

These are requirements for the delivery engine, **not current guarantees**:

- A successful ingestion response means the event and its initial delivery work
  are committed atomically in PostgreSQL.
- Delivery is **at least once**, not exactly once. A crash after the receiver
  accepts a request can cause a duplicate. Stable event identifiers and receiver
  idempotency are necessary.
- Workers must claim work safely under concurrency. Do not hold a database
  transaction open during a network request; use recoverable claims/leases.
- A crash must not leave work permanently stranded. Claims expire and stale
  attempts must not overwrite the state owned by a newer claim.
- Persist attempts and retry schedules; use bounded timeouts and backoff with
  jitter. Do not promise indefinite retries or delivery order without an explicit
  product decision.
- Replay creates new delivery work and preserves original event/attempt history.

Before real delivery or public exposure, implement API authentication, signed
outbound requests, payload size limits, retention rules, and destination controls
against SSRF (including redirects and DNS changes). Never log payloads or secrets
by default. Private-network destinations need an explicit self-hosting policy.

## References

- [Go module organization](https://go.dev/doc/modules/layout)
- [React with a build tool](https://react.dev/learn/build-a-react-app-from-scratch)
- [PostgreSQL locking and SKIP LOCKED](https://www.postgresql.org/docs/18/sql-select.html)
- [Agent instruction format](https://agents.md/)
