# Hooklane

**Durable webhook delivery, inspection, and replay on your own infrastructure.**
Hooklane accepts JSON events, stores delivery work atomically in PostgreSQL, signs
outbound requests, retries temporary failures, and keeps an inspectable history.
One Go application, one PostgreSQL database, and a React operations console.
Apache-2.0 licensed; no broker or hosted account required.

## What v1 includes

- Protected management API and browser sessions, plus a separate ingestion token.
- Destinations with encrypted signing secrets, pause/resume, rotation, and archive.
- Atomic event acceptance, idempotency keys, bounded JSON payloads and cursor pagination.
- Concurrent PostgreSQL workers, expiring claims, crash recovery, signed delivery,
  timeouts, exponential backoff with jitter, and bounded `Retry-After` handling.
- Event metadata, delivery status, attempt history, cancellation, and idempotent replay.
- Responsive management console, event composer, filters, and integration guidance.
- SSRF controls, payload redaction, automatic retention, protected Prometheus metrics,
  health probes, graceful shutdown, and an example signature-verifying receiver.

The delivery model is **at least once**. A receiver must deduplicate event IDs.
Hooklane does not promise delivery ordering, unlimited retries, or exactly-once
side effects. This version serves one trusted team per installation.

## Quick start

Install Docker with Compose v2, Make, and OpenSSL. Then:

```sh
make setup
make up
```

Open [localhost:8088](http://localhost:8088) and sign in using `ADMIN_TOKEN` from
your local `.env` file. `make setup` creates the file if absent and generates
missing secrets without replacing existing values. Keep `ENCRYPTION_KEY` safe;
existing signing secrets cannot be decrypted without it.

1. Configure your receiver with a random signing secret of at least 32 characters.
2. Add a destination in the console with its HTTPS URL and the same secret.
3. Send an event through the console or [HTTP API](docs/api.md).
4. Inspect delivery attempts, fix a failing receiver, and replay a terminal delivery.

For a local receiver, follow the explicit network opt-in in the
[development receiver guide](examples/receiver/README.md).

Compose binds the application and PostgreSQL to loopback (`8088` and `5438`).
For public access, configure HTTPS and secure cookies using the
[deployment guide](docs/operations.md). Do not expose the database port.

```sh
curl http://127.0.0.1:8088/healthz
curl http://127.0.0.1:8088/readyz
make logs
make down
```

`make down` preserves data. `docker compose down --volumes` deletes it.
Changing PostgreSQL initialization credentials does not update an existing volume.

## Local development

Use Go **1.27.1**, Node **24.21.0 LTS**, and pnpm **11.21.0**, matching the checked-in
version files, Docker, and CI. Install pnpm with
`npm install --global pnpm@11.21.0` if needed.

```sh
make setup
make install
make dev-db
make dev-api
```

Run `make dev-web` in a second terminal and open
[localhost:5173](http://localhost:5173). Stop the Compose application before running
a local API on its port. The Vite proxy sends API/health requests to Go. Secrets
stay on the server and never belong in `VITE_*` variables.

`make dev-api` sources the trusted `.env` file; quote shell metacharacters.
The binary itself reads only environment variables. Embedded Goose migrations
run automatically before the API becomes ready. During database outages, liveness
remains available and readiness reports unavailable; initialization retries.

## Commands

| Command | Purpose |
| --- | --- |
| `make setup` | Create missing local configuration and secrets |
| `make install` | Install locked dependencies and pinned quality tools |
| `make up` / `make down` | Start / stop the full Docker stack |
| `make dev-db` | Start PostgreSQL for local development |
| `make dev-api` / `make dev-web` | Run Go / Vite in separate terminals |
| `make fmt` | Format Go and frontend sources |
| `make check` | Format, lint, types, race tests, UI tests, vulnerability check |
| `make build` | Build `.bin/hooklane` and `web/dist` |
| `make generate` | Regenerate checked-in sqlc queries after SQL changes |
| `make integration` | PostgreSQL behavior tests using `HOOKLANE_TEST_DATABASE_URL` |
| `make smoke` | Isolated Docker end-to-end checks, then cleanup |

`make integration` requires a **disposable** PostgreSQL database and creates isolated
test schemas. `make smoke` requires Python 3 and curl; it uses ports `18088`/`15438`
by default (`SMOKE_APP_PORT` / `SMOKE_POSTGRES_PORT` overrides) and its own temporary
Compose project and volume. It checks a real signature-verifying receiver through
an outage/retry/replay, authorization, persistence, database recovery and shutdown.
Ordinary Go tests skip the PostgreSQL suite when its URL is absent; CI runs it
explicitly against PostgreSQL 18.

## Documentation

- [API and signature verification](docs/api.md) · [OpenAPI](docs/openapi.json)
- [Architecture and delivery invariants](docs/architecture.md)
- [Configuration, deployment, upgrades and backups](docs/operations.md)
- [Roadmap and v1 boundaries](docs/roadmap.md)
- [Example receiver](examples/receiver/README.md)
- [Contributing](CONTRIBUTING.md) · [Agent instructions](AGENTS.md)

Go (`net/http`, `slog`, `pgx`, Goose, sqlc), PostgreSQL 18, React 19, strict
TypeScript, Vite, pnpm and Docker Compose. Copyright 2026 Hooklane contributors.
