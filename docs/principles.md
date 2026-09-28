# Engineering principles

Owner: maintainers
Last reviewed: 2026-09-28

## Boundaries with executable checks

- Keep `cmd/api` as process wiring. Use standard `net/http`, contextual operations,
  wrapped errors and `slog`. Production Go code must not import legacy `log` or
  use built-in `print`/`println`; architecture tests report the file and repair.
- Dependencies point from `cmd/api` to config, HTTP, delivery and store; HTTP and
  delivery may consume store; store may consume generated sqlc; config and sqlc
  cannot depend on other internal packages. Database drivers belong in store and
  process wiring; config may use only `pgxpool.ParseConfig` for validation.
  [Structural tests](../scripts/architecture_test.go) enforce
  these edges, including test imports; new packages need an explicit decision.
- Keep PostgreSQL as the source of truth. Use embedded Goose migrations and
  regenerate checked-in queries with `make generate`. CI checks generation drift.
- Validate untrusted data at the boundary. The browser's network entry point is
  [api.ts](../web/src/api.ts), which decodes responses before returning them.
  ESLint prohibits direct fetch elsewhere and domain imports in generic UI/lib
  components. TypeScript remains strict; do not substitute `any` for validation.
- Keep credentials, connection strings, signing secrets, event payloads and
  receiver bodies out of logs and read APIs. Browser configuration is public:
  never place secrets in `VITE_*`. Tests cover known leak paths; review new fields.

## Design judgment

Introduce interfaces at consumers only for a real boundary or test. Keep React
state local until sharing is needed and abort requests on teardown. Do not add
empty layers, generic repository frameworks, placeholder workers or dependencies
without a concrete use. Preserve bounded network operations and the separation
between liveness and readiness.

The [delivery invariants](architecture.md#future-delivery-invariants) are acceptance
criteria for engine changes. Functional checks do not establish capacity or an
availability SLA. Keep limitations in [operations](operations.md) and the
[roadmap](roadmap.md) aligned with implementation.

## Change loop

1. Identify the outcome, affected boundary and observable failure case.
2. Reproduce or establish the baseline; record a [plan](exec-plans/index.md) for
   work spanning several boundaries or requiring consequential decisions.
3. Implement the smallest complete change and test meaningful failure paths.
4. Run affected checks, then `make check` and `make build`; run `make smoke` for
   HTTP, database, container or lifecycle changes. Use a disposable database.
5. Review the diff for correctness, secrets, dependency direction, generated drift
   and documentation accuracy. Record evidence and unresolved limitations.
6. Keep commits focused and use scoped Conventional Commits in English. Follow
   [CONTRIBUTING.md](../CONTRIBUTING.md) for PRs.

Keep existing merge/review controls. The article's experimental merge policy is
not a reason to waive Hooklane's delivery checks or claim unverified success.
