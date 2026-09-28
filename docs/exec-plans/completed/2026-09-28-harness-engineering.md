# Harness engineering adoption

Owner: maintainers
Last reviewed: 2026-09-28
Status: completed

## Outcome

Make Hooklane navigable and verifiable for coding agents: a short instruction
map, versioned plans and debt, executable architecture/documentation constraints,
and an isolated runtime with inspectable logs, metrics and browser access.
Preserve the delivery guarantees and existing application behavior.

## Progress

- [x] Read the source article and inspect current docs, CI, tests and runtime tools.
- [x] Add the knowledge map, quality baseline and executable repository checks.
- [x] Add and exercise an isolated runtime with automatic port allocation.
- [x] Run required checks, review the diff and record evidence.

## Decisions

- Adapt the existing package graph instead of adding generic service layers.
- Keep existing CI/review requirements; the article describes an experiment,
  not a formal compliance standard.
- Reuse JSON logs, authenticated Prometheus metrics and the signed receiver.
  A separate tracing backend is deferred until a concrete diagnostic need.
- Use standard-library tooling and existing ESLint; add no runtime dependencies.

## Validation

Verified locally on 2026-09-28 with Go 1.27.1, Node 24.21.0, pnpm 11.21.0,
Docker Compose 5.1.2 and disposable PostgreSQL 18.4:

- `make check` and `make build` passed; 46 frontend behavior tests, Go race
  tests, architecture checks, nine Python policy/isolation regressions and
  reachable-vulnerability analysis passed.
- Frontend policy fixtures rejected direct/global fetch, domain imports from a
  generic component and console logging; the API client remains allowed to fetch.
- `make smoke` passed signed 503/204 delivery, replay/deduplication, outage
  recovery, persistence, graceful shutdown and encryption-key readiness checks.
- `make harness-up`, `harness-status`, `harness-metrics` and `harness-logs` worked
  while the separate smoke project was running on different assigned ports.
- The existing authenticated API smoke scenarios also passed against the harness
  with its own generated credentials and signing key. `make integration` passed
  against its disposable PostgreSQL instance.
- `make harness-down` removed its containers, network and volume; Docker label
  queries confirmed no harness resources remained. Local credentials are ignored
  by Git and excluded from Docker build context.

CI's first run passed `quality` and found that its older Docker Compose version
does not accept `compose start --wait`. The smoke script now starts PostgreSQL
without that flag and waits for `/readyz` to recover; `make smoke` passed again
locally. The updated remote run is pending.

## Remaining work

See the [debt tracker](../tech-debt-tracker.md) for intentionally deferred work.
