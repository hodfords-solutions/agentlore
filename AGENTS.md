# Agent instructions

Instructions for AI coding agents working on agentlore (Claude Code reads them through
`CLAUDE.md`). Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Keep the "How it works" drawing in sync

[`docs/how-it-works/how-it-works.html`](docs/how-it-works/how-it-works.html) is the source of
`how-it-works.pdf`, the picture of how agentlore works. When a change makes it wrong, update it in
the same change:

1. Edit the HTML (its inline SVG figures and their captions).
2. Run `pnpm docs:pdf` (needs Chrome or Chromium; set `CHROME_PATH` if it is not found) and
   commit the regenerated PDF with it.
3. Check the PDF still has one figure per page.

It needs updating when any of these change:

- the tools that are indexed, or where their history is read from (`src/adapters/`, `src/app.ts`);
- the indexing steps: reading changes, redaction, chunking (`src/core/indexer.ts`, `redact.ts`,
  `chunk.ts`);
- where or how the index is stored (`src/core/store.ts`, `src/app.ts`);
- the MCP tools, how many hits they return or how much text (`src/mcp/server.ts`,
  `src/core/context.ts`);
- when a search refreshes the index (`src/core/runtime.ts`);
- knowledge mode: the prompt hook, its gates and thresholds, the size of what it adds
  (`src/core/prompt-context.ts`, `src/integrations/`);
- the CLI commands shown (`src/cli/index.ts`);
- the speed figures quoted in the README.

`test/docs/how-it-works.test.ts` fails when the drawing's numbers or tool list no longer match
the code. Update the drawing rather than the test. That test cannot see every change, so check
the list above as well.

## Keep the project memory blueprint in sync

[`docs/project-memory/project-memory.html`](docs/project-memory/project-memory.html) is the source
of `project-memory.pdf`, a blueprint of project memory ([ADR 0004](docs/adr/0004-project-memory.md)).
`pnpm docs:pdf` renders it too. Update it with any change to the notes and their limits
(`src/core/memory.ts`), what sessions get (`src/core/recall.ts`, the hooks in
`src/integrations/`), the MCP memory tools, or consolidation (`src/core/consolidate.ts`,
`src/integrations/claude-cli.ts`). `test/docs/how-it-works.test.ts` checks its numbers.

## Other rules

- Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before you finish.
- Code, comments and docs are in English. Words of a specific language belong in
  `src/core/languages/`.
- Never commit real transcripts or anything taken from `~/.agentlore`; test data is synthetic.
- User-facing changes need a changeset (`pnpm changeset`).
