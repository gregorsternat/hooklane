# Development harness

Owner: maintainers
Last reviewed: 2026-09-28

## Isolated app per checkout

Requirements: Docker Compose 2.24.4 or newer (supports `!override`), Python 3 and
Make. Use the repository's Go, Node and pnpm versions for host-side checks.

```sh
make harness-up
make harness-status
make harness-logs
make harness-metrics
make harness-down
```

`harness-up` builds this checkout and starts app, PostgreSQL and the signed
receiver. Its project name hashes the checkout's real path; another worktree gets
a different network and volume. Docker assigns free loopback ports. Status prints
the console URL, database address and health/readiness results. Rebuild after code
changes; this runtime serves the production frontend bundle.

Random credentials persist in ignored, mode-0600 `.harness/config.json`. Existing
keys are preserved. The harness does not load `.env`; its Compose override fixes
the runtime configuration and uses only these local credentials. Never copy real
events, credentials or databases into this instance. Private-network HTTP is
enabled solely to reach its development receiver.

`harness-down` deletes **this checkout's harness volume** and containers. It keeps
the local key file for subsequent starts. It does not operate on the ordinary
`make up` installation. Stop the harness before moving or deleting the checkout,
since the project identity depends on its path. On a failed startup, inspect
`make harness-logs`, correct the cause and retry, or clean up with `harness-down`.
Do not delete or regenerate the key file while retaining its database volume.

## Observe a change

1. Launch the runtime and use the console URL from `make harness-status`.
2. Sign in with its local admin token. Keep it out of screenshots and transcripts.
3. Create a destination with `http://receiver:8099/webhook` and the harness's
   local `SIGNING_SECRET`. Use a small synthetic event through the composer.
4. Inspect the first 503 and subsequent 204 attempt, then replay the terminal
   delivery and inspect the new delivery's lineage and receiver deduplication.
5. Query `make harness-logs` for safe delivery IDs, attempts, status and elapsed
   time. Query `make harness-metrics` for authenticated retained-state gauges.
   The command supplies credentials internally without printing them.
6. For UI changes, exercise the affected journey in a real browser, including
   errors and narrow layout. Save sanitized screenshots under ignored
   `output/playwright/`; record the action and result in the plan or PR.

The receiver's first-failure/deduplication memory resets when its process restarts.
Use a new synthetic event for a fresh retry scenario. Metrics can decrease after
retention and are not throughput counters; see [operations](operations.md).

## Automated feedback

- `make harness-check`: documentation policy, Go dependency/logging boundaries,
  and standard-library checker/isolation regression tests.
- `make check`: harness checks plus existing format, lint, type, race, frontend
  and vulnerability checks. ESLint keeps browser fetch in the validating client.
- `make build`: production binaries/assets; no claim of runtime correctness.
- `make smoke`: creates its own disposable project, uses automatically assigned
  loopback ports, verifies signed receipt/retry/replay and lifecycle, then cleans
  up. Optional `SMOKE_APP_PORT` / `SMOKE_POSTGRES_PORT` fix host ports when needed.
- `make integration`: real PostgreSQL invariant tests, requiring a disposable
  `HOOKLANE_TEST_DATABASE_URL`; do not point it at an existing installation.

## Coverage and limits

| Article practice | Hooklane implementation |
| --- | --- |
| Short map and repository knowledge | AGENTS, indexed docs, owners and review dates |
| Plans, decisions and debt in Git | Active/completed plan lifecycle, quality and debt tables |
| Mechanical architecture constraints | Go AST import/logging checks, frontend ESLint boundaries |
| Legible isolated runtime | Worktree project, free ports, JSON logs, protected metrics, signed receiver |
| Continuous cleanup feedback | Required repository checks in CI; maintenance procedure in the docs index |
| Behavioral verification | Unit, component, real PostgreSQL and container smoke tests |

The documentation checker supports inline Markdown links and ATX headings outside
fenced examples; use that subset in maintained docs. It verifies local structure
and review dates, not external website availability or semantic correctness.
Architecture checks do not prove every log field is safe; review new fields and
retain leak tests. Real-browser CI, historical telemetry and measured capacity
remain explicit [quality gaps](exec-plans/tech-debt-tracker.md). No unattended
merge or background agent service is configured by these files.
