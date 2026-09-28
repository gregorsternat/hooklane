# Quality baseline

Owner: maintainers
Last reviewed: 2026-09-28

This is a coverage assessment, not a production certification. **Covered** means
an executable behavior check exists; **partial** means an important gap remains.
Dates and actual executions belong in [verification](verification.md).

| Domain | Assessment | Evidence | Remaining gap |
| --- | --- | --- | --- |
| Configuration and lifecycle | Covered | [Config tests](../internal/config/config_test.go), [health tests](../internal/httpserver/handler_test.go), [smoke](../scripts/smoke.sh) | Deployment-specific restore and capacity, H-002 |
| HTTP boundary and authentication | Covered | [API tests](../internal/httpserver/api_test.go), [contract](openapi.json) | Contract drift still requires semantic review |
| Persistence and queue | Covered | [Real PostgreSQL tests](../internal/store/store_test.go), CI integration and generated-query drift checks | No measured scale profile, H-002 |
| Delivery, retry and replay | Covered | [Worker tests](../internal/delivery/worker_test.go), [network-policy tests](../internal/delivery/policy_test.go), signed receiver smoke | No throughput or fairness SLA |
| Browser workflows | Partial | [Component tests](../web/src/App.test.tsx), [decoder tests](../web/src/api.test.ts), historical browser evidence | Real-browser CI, H-001 |
| Repository architecture and knowledge | Covered | [Go boundaries](../scripts/architecture_test.go), [documentation checker](../scripts/check_docs.py), ESLint | Semantics and privacy still require review |
| Runtime diagnostics | Partial | JSON logs, authenticated metrics, [isolated harness](harness.md) | Historical observability/tracing, H-003 |

Review this table when changing a domain. Link a regression to its test, promote
repeatable review feedback to an executable check, and track unresolved gaps in
the [debt tracker](exec-plans/tech-debt-tracker.md).
