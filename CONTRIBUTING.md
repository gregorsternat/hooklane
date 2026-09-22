# Contributing

Hooklane v1 implements a single-team webhook delivery service. Start with the
[README](README.md) for setup and the [roadmap](docs/roadmap.md) for boundaries.

## Workflow

1. Describe the problem and expected behavior in an issue or PR. For significant
   design changes, discuss the approach before building a large implementation.
2. Create a focused branch. Implement the smallest complete behavior, including
   relevant failure paths and documentation updates.
3. Run `make fmt`, `make check`, and `make build`. For changes involving HTTP,
   PostgreSQL, containers, or process lifecycle, also run `make smoke`.
4. Open a PR explaining the problem, resulting behavior, validation, and any
   compatibility or migration concerns. State any checks you could not run.

Use English and scoped Conventional Commits, for example:
`fix(api): bound readiness probe duration`. Generated dependency lockfiles belong
in Git; build outputs and secrets do not. New dependencies need a concrete use.

Tests should cover observable behavior and meaningful failures. Go tests live
beside the code and use the standard testing package. Frontend tests use Vitest
and Testing Library. Database changes must run through `make integration` against a disposable real
PostgreSQL database, not only mocks. Set `HOOKLANE_TEST_DATABASE_URL`; tests create
and clean isolated schemas. Run `make generate` after changing SQL queries and
commit the generated files.

## AI-assisted contributions

Coding agents start with [AGENTS.md](AGENTS.md) and follow its links only as needed.
Human contributors remain responsible for understanding, reviewing, and validating
their changes. Keep agent instructions short and specific to this repository.
Do not add duplicate tool-specific instruction files or commit chat transcripts.

## License

Contributions are provided under the project's [Apache-2.0 license](LICENSE).
