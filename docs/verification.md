# Verification

The canonical local/CI checks are `make check`, `make build`, `make integration`
and `make smoke`. Runtime versions are pinned in the repository. Normal tests
skip PostgreSQL cases when `HOOKLANE_TEST_DATABASE_URL` is absent; the integration
command refuses to run without it. Always use a disposable database.

## Behavior covered

- API authentication scope, session expiry/tampering/rotation, CSRF/origin checks,
  startup readiness gating, request limits and safe error/metadata responses.
- Outbound public/private address rules, DNS rebinding, mixed DNS answers,
  redirected requests, exact-body signatures, temporary/permanent HTTP failures,
  timeout persistence and retry timing bounds.
- Real PostgreSQL atomic transaction rollback, concurrent idempotency, concurrent
  work claiming, stale-result fencing, lease recovery and final-attempt exhaustion.
- Replay lineage/idempotency, cancellation, paused destinations, archive/finish
  concurrency, payload redaction, encrypted secrets/key validation, retention and
  concurrent replay/retention safety, cursor filters and statistics.
- Frontend runtime response validation, authentication, mutations, failure states
  and aborting requests on teardown.
- Conditional destination revisions and concurrent editors; enabled-only updates
  preserving newer URLs; historical attempt revisions, with unknown legacy values.
- Replay eligibility and race rejections, successful descendant recovery including
  replay of replay, and negative controls for unrelated older successes.
- Due, future, paused and exhausted queue predicates; consistent retained counts
  and oldest eligible queued age, with fixed Prometheus label categories.
- Composer validation recovery and sticky ambiguous submission identity, including
  a lost response followed by a definitive refusal; route filters, cursors, return
  links and direct record lookup.
- Full Docker API-to-receiver path, signature verification, a simulated 503 then 204,
  replay and receiver deduplication, authorization, pagination, redaction, pause,
  cancel, archive, database outage/recovery, graceful shutdown and persistent data.

## Limits of these checks

The suite validates functionality and concurrency invariants. It does not establish
a throughput ceiling, long-duration reliability SLA, backup recovery objectives,
or resilience to every network topology. Before deploying, run a representative
load test with your actual payload sizes, receiver latency, retry volume and
history size, and perform an isolated backup restore exercise. Record hardware,
configuration and observations with any performance claim.

## v1 implementation verification

Verified locally on 2026-09-23 with Go 1.27.1, Node 24.21.0 and PostgreSQL 18.4:

- `make check`: formatting, lint, strict types, Go race tests, 30 frontend tests
  and reachable-vulnerability analysis passed.
- `make build`: Go executable and production frontend compiled successfully.
- `make integration`: real PostgreSQL tests passed, including concurrent claims,
  idempotency, replay/retention and archive/finish races.
- `make generate`: pinned sqlc 1.31.1 output reproduced byte-for-byte.
- `make smoke`: authenticated signed delivery/retry/replay and lifecycle checks
  passed, including readiness/data-access refusal for a wrong encryption key and
  recovery after restoring the correct key.
- Browser verification: sign-in, destination creation, event submission, the
  two-attempt 503/204 history and replay checked against a real local receiver.
Desktop 1440px and mobile 390px layouts inspected with no horizontal page overflow.

These results apply to the local implementation; they do not imply a public
release, production cutover, measured capacity, or external security audit.

## beUI interface verification

The shadcn/beUI migration was checked with strict TypeScript, ESLint, 30 frontend
behavior tests, Go race tests, `make build` and the isolated Docker smoke suite.
Additional UI cases cover selector keyboard navigation, disabled options, modal
focus and busy-state dismissal, event filters and all rows of paginated tables.

The production bundle was exercised against a disposable PostgreSQL instance and
signed receiver: destination creation/editing, event composition with keyboard
selection, 503-to-204 retry history, mobile navigation and event filtering. Desktop
1440px and mobile 390px layouts were inspected. Presence animations were adjusted
to work under the existing strict CSP without injected stylesheets.

## Audit follow-up verification

Verified on 2026-09-23 with the pinned Go 1.27.1, Node 24.21.0, pnpm 11.21.0
and a disposable PostgreSQL 18.4 database. The existing local installation and its
database were not used for test writes.

- `make check`, including 46 frontend behavior/decoder tests, race-enabled Go
  tests, lint, strict types, formatting and vulnerability analysis.
- `make build`, `make generate` reproducibility, real-database `make integration`,
  and `make smoke` covering the signed HTTP path and container lifecycle.
- Real browser navigation through a failed history spanning two pages: browser
  Back, return links and reloading the shared route preserved the filter/page.
  Direct delivery lookup opened paused work with its destination link and budget.
- Destination creation exposed its ID and integration path. Copy ID worked; the
  visible curl example accepted one event, deduplicated its identical retry and
  reached the signature-verifying receiver with HTTP 204.
- A concurrent URL edit caused the open full-edit form to refuse stale changes
  and retain the draft. Pausing from the older view preserved the newer endpoint.
- Redaction disabled replay with a permanent explanation. Failure history linked
  to its successful replay; paused work showed an explicit resume blocker.
- A definitive server validation rejection preserved the composer draft and
  allowed correction, followed by a signed successful delivery. Ambiguous outcomes
  and subsequent rejections are additionally covered by frontend behavior tests.

These are functional and concurrency checks on synthetic local data. They do not
establish a production SLA or long-term analytics coverage.
