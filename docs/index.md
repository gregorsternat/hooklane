# Engineering map

Owner: maintainers
Last reviewed: 2026-09-28

Start with the source relevant to the task. Documents describe current behavior
unless they explicitly mark a proposal, historical result, or known gap.

| Need | Source of truth |
| --- | --- |
| Product scope and exclusions | [Roadmap](roadmap.md) |
| Packages, data flow and delivery guarantees | [Architecture](architecture.md) |
| Engineering rules and their enforcement | [Principles](principles.md) |
| API shapes and receiver protocol | [API](api.md) and [OpenAPI](openapi.json) |
| Configuration, security and recovery | [Operations](operations.md) |
| Commands, evidence and test limitations | [Verification](verification.md) |
| Isolated app, logs, metrics and browser checks | [Development harness](harness.md) |
| Domain quality and remaining gaps | [Quality](quality.md) |
| Planning and decision history | [Execution plans](exec-plans/index.md) |
| Concrete maintenance work | [Technical debt](exec-plans/tech-debt-tracker.md) |

Database schema changes live in [embedded migrations](../internal/store/migrations).
Read queries live in [SQL source](../internal/store/queries/read.sql), with
[sqlc configuration](../sqlc.yaml) and [generated types](../internal/store/sqlc/models.go)
checked into Git. Regenerate through `make generate`; avoid a second schema copy.

## Keeping this map useful

Maintainers own this knowledge base; the author of a behavior change updates its
affected pages in the same change. Review the implementation and relevant tests
before advancing a page's `Last reviewed` date. `make docs-check` rejects missing
owners, invalid dates, live documents not reviewed in 90 days, broken local links
and heading anchors, and pages unreachable from [AGENTS.md](../AGENTS.md).
Completed plans are historical evidence and do not expire.

For maintenance, run `make harness-check`, inspect the quality and debt tables,
compare the affected docs with code, and make a focused repair. Promote repeated
review findings into a test or lint with an actionable failure message. Update
quality evidence only after executing the stated check; document blocked checks.

The workflow adapts [OpenAI's harness engineering experience](https://openai.com/index/harness-engineering/)
to this single-service repository. The [harness guide](harness.md#coverage-and-limits)
records what is automated and what still requires review.
