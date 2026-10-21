# agentlore documentation

User documentation lives in the [README](../README.md). This folder holds the reasoning behind
the code.

## How it works

- [How it works (PDF)](how-it-works/how-it-works.pdf): three drawings of the data flow, a
  search, and knowledge mode. Source: [how-it-works.html](how-it-works/how-it-works.html);
  regenerate with `pnpm docs:pdf` and keep it in sync with the code (see
  [AGENTS.md](../AGENTS.md)).

## Architecture decision records

Decisions that shape the code and are expensive to reverse. Add one for any change of that
kind (copy an existing record; number them in order).

- [ADR 0001: The index is a rebuildable cache](adr/0001-index-is-a-rebuildable-cache.md)

## Design

- [agentlore design](internal/plans/2026-10-16-agentlore-design.md): goals, architecture,
  adapters, privacy and the roadmap.

## Internal working notes

Plans written while building agentlore. They record intent at the time and may be out of date;
the code, the README and the ADRs win where they differ.

- [v0.1 implementation plan](internal/plans/2026-10-16-agentlore-v0.1.md)

## For contributors and maintainers

- [CONTRIBUTING](../CONTRIBUTING.md): setup, checks, coverage, writing an adapter
- [RELEASING](../RELEASING.md): changesets, npm trusted publishing
- [SECURITY](../SECURITY.md): reporting vulnerabilities, scope
