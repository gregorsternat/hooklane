# Technical debt

Owner: maintainers
Last reviewed: 2026-09-28

Track a specific limitation, its impact, an owner and an observable closure
condition. Product candidates remain in the [roadmap](../roadmap.md).

| ID | Gap and impact | Owner | Closure condition |
| --- | --- | --- | --- |
| H-001 | Browser journeys have component tests and historical manual evidence, but no automated real-browser CI coverage | maintainers | Add a reproducible login, create, retry and replay journey against an isolated receiver; capture failure evidence without credentials or payloads |
| H-002 | Capacity and restore objectives are unmeasured | maintainers | Record a representative load profile and isolated backup restore, with hardware, configuration and results |
| H-003 | JSON logs and current-state metrics are available; no trace store or historical metrics backend | maintainers | Start from a concrete diagnostic question, then add and verify only the instrumentation/backend it needs |

## Resolved

Resolved entries should link their completed plan or change and the evidence
that satisfied the closure condition.
