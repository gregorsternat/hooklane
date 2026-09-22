# Working on Hooklane

## Context
- Hooklane is an Apache-2.0, self-hosted webhook delivery and replay project.
- The v1 delivery path runs. Preserve the documented at-least-once guarantees and explicit limitations.
- Read [architecture](docs/architecture.md) for design decisions and [roadmap](docs/roadmap.md) for scope.
- Code, documentation, UI text, commits, and PRs are in English.

## Repository map
- `cmd/api`: process wiring, signals, HTTP lifecycle, and PostgreSQL pool.
- `internal/config`: environment validation; `internal/httpserver`: HTTP boundary.
- `web`: React application, frontend tooling, and colocated tests.
- `scripts/smoke.sh`: isolated Docker integration checks.
- `Makefile`: canonical developer/CI commands and pinned Go tool versions.

## Commands
- Setup: `make setup`, then `make install`; setup preserves existing configuration and generates only missing secrets.
- Local development: `make dev-db`, then `make dev-api` and `make dev-web` in separate terminals.
- Complete containerized app: `make up`; stop with `make down` (preserves data).
- Format: `make fmt`. Verify: `make check`. Compile: `make build`.
- Integration: `make smoke`; it creates and deletes only its own isolated test volume.
- Focused tests: `go test ./internal/httpserver` or `pnpm --dir web test`.
- Use versions in `go.mod`, `.node-version`, and `web/package.json`.

## Implementation rules
- Keep Go entrypoints thin and packages organized around concrete responsibilities.
- Use standard `net/http`, contextual operations, wrapped errors, and structured `slog` logs.
- Introduce interfaces at consumers only when a real boundary or test needs one.
- Keep PostgreSQL as the source of truth; use embedded Goose migrations and regenerate checked-in sqlc queries with `make generate`.
- Do not add empty layers, a generic repository framework, placeholder workers, or unused dependencies.
- Keep TypeScript strict. Validate untrusted API responses; do not hide uncertainty with `any`.
- Keep React state local until actual sharing is needed. Cancel requests on unmount.
- Never expose credentials, connection strings, signing secrets, or event payloads in logs or the UI.
- Never put secrets in `VITE_*` variables; these are public browser configuration.
- Preserve readiness/liveness separation and bounded network operations.
- Follow [delivery invariants](docs/architecture.md#future-delivery-invariants) when implementing the engine.

## Verification and changes
- Test meaningful behavior and failure paths; avoid tests that only mirror implementation.
- Run affected checks while iterating, then `make check` and `make build` before handoff.
- Run `make smoke` after HTTP, PostgreSQL, container, or startup/shutdown changes.
- Report which checks passed and which were blocked; do not equate compilation with runtime validation.
- Commit lockfiles. Checks/builds must not rewrite tracked files or add generated artifacts.
- Keep documentation synchronized with commands and actual behavior; link rather than duplicate.
- Document consequential architecture changes; avoid adding an ADR for routine code choices.
- Use scoped Conventional Commits, e.g. `feat(delivery): add retry scheduling`.
- Keep changes focused and preserve unrelated work. See [contribution guide](CONTRIBUTING.md).
