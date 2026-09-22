# Hooklane

Self-hosted webhook delivery and replay. Hooklane aims to receive events, persist
them, and deliver them to your applications, including after outages.

**Early development:** this repository currently contains the runnable foundation:
a Go HTTP server, PostgreSQL connectivity, a React status page, Docker, and CI.
Event ingestion, delivery, retries, authentication, and replay are **not implemented**.

## Quick start

Prerequisites: Docker with Compose v2 (`--wait` support) and Make. No local Go or
Node installation is required for the containerized application.

```sh
cp .env.example .env
make up
```

Open [localhost:8088](http://localhost:8088). PostgreSQL is exposed on
`127.0.0.1:5438`. Both ports bind to loopback only. The sample credentials are for
local development. This unauthenticated foundation is not a public deployment.

```sh
curl http://127.0.0.1:8088/healthz
curl http://127.0.0.1:8088/readyz
make logs
make down
```

`make down` preserves PostgreSQL data. `docker compose down --volumes` deletes it.
Changing PostgreSQL initialization credentials does not change an existing volume's
database users or passwords.

## Local development

Use Go **1.27.1**, Node **24.21.0 LTS**, and pnpm **11.21.0**. Versions are recorded
in `go.mod`, `.node-version`, and `web/package.json`; CI and Docker use the same
versions. Install pnpm with `npm install --global pnpm@11.21.0` if needed.

```sh
cp .env.example .env # Only if .env does not already exist.
make install
make dev-db
make dev-api
```

In a second terminal, run `make dev-web` and open
[localhost:5173](http://localhost:5173). Stop the complete Docker stack with
`make down` before starting a local API on the same port. Stop local processes with
Ctrl+C. `make dev-api` sources the trusted local `.env` file using the shell;
quote values containing shell metacharacters. The Go executable itself only reads
process environment variables.

Vite proxies health checks and future `/api` requests to Go. Database credentials
stay on the server; never prefix secrets with `VITE_`. The Go process starts during
a database outage and reports readiness as unavailable until PostgreSQL recovers.

## Commands

| Command | Purpose |
| --- | --- |
| `make help` | List commands |
| `make install` | Install locked dependencies and pinned Go tools |
| `make up` / `make down` | Start / stop the full Docker stack |
| `make dev-db` | Start PostgreSQL for local development |
| `make dev-api` / `make dev-web` | Run the API / Vite in separate terminals |
| `make fmt` | Format Go and frontend files |
| `make check` | Formatting, lint, types, race tests, frontend tests, Go vulnerability check |
| `make build` | Build `.bin/hooklane` and `web/dist` |
| `make smoke` | Build and test an isolated Docker stack, then remove its test volume |

After `make build`, run `DATABASE_URL='…' WEB_DIR=web/dist .bin/hooklane` to serve
the built frontend with Go. Omit `WEB_DIR` for API-only local development.
`make smoke` requires curl and uses ports 18088/15438 by default; override with
`SMOKE_APP_PORT` / `SMOKE_POSTGRES_PORT` if needed. It never operates on the regular
`hooklane` Compose project.

## Configuration

| Variable | Default / requirement |
| --- | --- |
| `DATABASE_URL` | Required; PostgreSQL URI or pgx keyword connection string |
| `HTTP_ADDR` | `127.0.0.1:8088` locally; fixed to `0.0.0.0:8088` inside Docker |
| `WEB_DIR` | Empty (static serving disabled); `/app/web` in Docker |
| `LOG_LEVEL` | `info`; also `debug`, `warn`, `error` |
| `READINESS_TIMEOUT` | `2s`; positive and below the HTTP write timeout of `10s` |
| `SHUTDOWN_TIMEOUT` | `10s`; positive; keep below Compose's `30s` stop grace period |
| `API_PROXY_TARGET` | Vite-only: `http://127.0.0.1:8088` |
| `APP_PORT` / `POSTGRES_PORT` | Compose host ports: `8088` / `5438` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Compose database settings; see `.env.example` |

When changing local ports or credentials, also update `DATABASE_URL` and
`API_PROXY_TARGET` in `.env`. Compose constructs its internal connection from the
`POSTGRES_*` settings; it does not use the host's `DATABASE_URL` or `HTTP_ADDR`.
Special characters in a URI password must be percent-encoded.

## Stack and documentation

Go (`net/http`, `slog`, `pgx`), PostgreSQL 18, React, strict TypeScript, Vite, pnpm,
and Docker Compose. No message broker is needed for the initial design.

- [Architecture and delivery guarantees](docs/architecture.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md)
- [Instructions for coding agents](AGENTS.md)

Licensed under [Apache-2.0](LICENSE). Copyright 2026 Hooklane contributors.
