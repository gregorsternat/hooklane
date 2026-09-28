# Working on Hooklane

Hooklane is an Apache-2.0, self-hosted webhook delivery and replay service.
Preserve its documented at-least-once guarantees and explicit v1 limitations.
Code, documentation, UI text, commits and PRs are in English.

## Start here

- [Engineering map](docs/index.md): choose the source relevant to the task.
- [Architecture](docs/architecture.md): packages, dependency direction and delivery invariants.
- [Roadmap](docs/roadmap.md): implemented scope and explicit exclusions.
- [Principles](docs/principles.md): implementation rules and the change/review loop.
- [Harness](docs/harness.md): isolated runtime, logs, metrics and browser checks.
- [Verification](docs/verification.md): required commands and evidence boundaries.
- [Quality](docs/quality.md): coverage and gaps by domain.
- [Execution plans](docs/exec-plans/index.md): active work, decisions and technical debt.
- [Contributing](CONTRIBUTING.md): contribution and PR requirements.

## Repository map

- `cmd/api`: process wiring, signals, HTTP lifecycle and PostgreSQL pool.
- `internal/config`: configuration validation; `internal/httpserver`: HTTP boundary.
- `internal/store`: transactions, queue, migrations and generated sqlc reads.
- `internal/delivery`: outbound policy, signing, retries and retention.
- `web`: strict React/TypeScript client, local components and colocated tests.
- `scripts`: setup, isolated smoke/harness and repository policy checks.
- `Makefile`: canonical developer/CI commands and pinned Go tools.

## Commands

- Setup: `make setup`, then `make install`; use pinned runtime versions.
- Development: `make dev-db`, then `make dev-api` and `make dev-web`.
- Isolated worktree app: `make harness-up`; inspect with `make harness-status`.
- Format: `make fmt`. Required before handoff: `make check` and `make build`.
- HTTP, database, container or lifecycle changes also require `make smoke`.
- Repository checks: `make harness-check`; SQL changes: `make generate`.
- Focused tests: `go test ./internal/httpserver` or `pnpm --dir web test`.

## Non-negotiable boundaries

- PostgreSQL is the source of truth. Follow the [delivery invariants](docs/architecture.md#future-delivery-invariants).
- Validate untrusted API responses; use strict TypeScript and cancel requests on teardown.
- Never expose credentials, connection strings, signing secrets or event payloads in logs or the UI.
- Never put secrets in `VITE_*` variables; browser configuration is public.
- Preserve readiness/liveness separation and bounded network operations.
- Preserve unrelated work. Checks/builds must not rewrite tracked files.
- Record actual checks and blocked checks; compilation is not runtime validation.
- Keep consequential decisions, plans and current behavior discoverable in Git.
