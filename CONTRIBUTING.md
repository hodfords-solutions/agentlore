# Contributing to agentlore

Thanks for helping! This guide covers setup, the checks every change must pass, and how to add
support for a new tool.

## Setup

```bash
nvm use          # Node version from .nvmrc (22)
corepack enable  # provides the pnpm version pinned in package.json
pnpm install
```

Try the CLI against your own data without touching your real index:

```bash
pnpm build
AGENTLORE_HOME=$(mktemp -d) node dist/cli/index.js index
```

## Checks

Run before every commit:

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` compiles the CLI once into a temporary folder (see `test/setup/build-cli.ts`) for the
tests that run `lore` as a subprocess; it never touches `dist/`.

CI runs lint, typecheck, test and build on Linux, macOS and Windows with Node 22 and 24, then
packs the package and smoke-tests the installed tarball.

### Coverage

```bash
pnpm test:coverage   # text summary, HTML report in coverage/
```

Coverage is measured in-process with V8 over `src/`, and the run fails below the thresholds in
`vitest.config.ts` (lines 95%, branches 88%). `src/cli/` is excluded: the CLI only runs in
spawned processes, which in-process coverage cannot see, and is covered end to end by
`test/cli/cli.test.ts` and `test/mcp/stdio.test.ts`. When you add code, add tests so the numbers
do not drop.

## The "How it works" drawing

If your change alters what [docs/how-it-works](docs/how-it-works/how-it-works.pdf) shows (the
tools indexed, the indexing steps, the MCP tools, refresh, knowledge mode), edit
`how-it-works.html` and run `pnpm docs:pdf`. [AGENTS.md](AGENTS.md) lists what it covers.

## Commits and changesets

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(adapters): …`, `fix(core): …`, `docs: …`).
- For any user-facing change, run `pnpm changeset` and commit the generated file. It becomes
  the CHANGELOG entry and drives the version bump. Releases are automated from those
  changesets; see [RELEASING.md](RELEASING.md).
- Write a failing test first, then the code that makes it pass.

## Golden rule: never commit real transcripts

Fixtures must be small, hand-written or fully sanitized samples. Never commit real session
files, and never put realistic secrets in tests — build fake keys by string concatenation
(`"sk-ant-" + "x".repeat(30)`), so secret scanners and readers never see a real-looking key.

## Add a language

Copy `src/core/languages/en.ts` to `src/core/languages/<code>.ts` (a BCP 47 code), list the
language's stopwords (function words) and task words (words about the task, not its subject:
"fix", "test", "remember"), lowercase with their diacritics, then the phrases for passwords and
logins (redaction) and for deciding and correcting (the `user decided` and `corrected later?`
labels). Leave out words that are also part of common unrelated words or phrases. Add the pack to `LANGUAGES` in
`src/core/languages/index.ts`. Add a search test with a few real sentences in that language.

## Write your first adapter in 30 minutes

An adapter turns one tool's data into normalized records. See `Adapter` in `src/core/types.ts`.
The reference implementation is [`src/adapters/codex.ts`](src/adapters/codex.ts) (about 60
lines on top of [`src/adapters/jsonl-source.ts`](src/adapters/jsonl-source.ts)); read it first.

1. **Implement `Adapter`** in `src/adapters/<tool>.ts`:
   - `tool` — a short, unique string id such as `"gemini"`.
   - `discover()` — return `{ sources, complete }`: one `{ id, version }` per source (a file,
     a database row…). `version` must change whenever the source changes, for example
     `` `${size}:${mtimeMs}` ``. Set `complete: false` when some sources could not be listed,
     so the indexer does not mistake them for deleted ones.
   - `read(source, checkpoint, { batchSize })` — yield batches of
     `{ records, checkpoint, reset, skipped }`. `records` are `SourceRecord`s
     (`{ kind, tool, sessionId?, title?, role?, project, timestamp, text }`: transcripts use
     `kind: "transcript"` with `sessionId` and `role`; documents use `"note"` or `"code"` with
     a `title`); `checkpoint` is any JSON you need
     to continue next time (it is handed back to you); set `reset: true` on the first batch
     when earlier records of the source are no longer valid; count records you cannot read as
     `skipped`. Validate input with zod and keep only the user's and the assistant's own words.
   - **For JSONL session files**, use `jsonlAdapter({ tool, root, parseLines })` from
     `src/adapters/jsonl-source.ts`: it handles discovery, byte offsets, appended and
     rewritten files. You only write `parseLines(lines, file, state)`, which turns complete
     lines into records; `state` keeps values that appear once per file (for example the
     session id or cwd in a header line) between incremental reads. See
     [`src/adapters/codex.ts`](src/adapters/codex.ts). If most of a file's bytes are lines you ignore (tool output,
     attachments), also pass `skipLine(raw)`: a cheap check on a line's raw bytes that skips it
     before decoding and parsing (see `skipClaudeLine` in `src/adapters/claude.ts`). It must never
     skip a line that would yield a record.
   - **For SQLite databases** another app owns (see [`src/adapters/cursor.ts`](src/adapters/cursor.ts)):
     open them only with `openCursorDb` (read-only, never copied), scan keys by range
     (`key >= 'prefix:' AND key < 'prefix;'`) rather than `LIKE`, and select only the fields you
     index with `json_extract`, so large values never reach JavaScript. Build test databases in
     the test itself (see `test/cursor-fixture.ts`) instead of committing binary files.
   - **For whole documents** (one file is one note), see
     [`src/adapters/antigravity.ts`](src/adapters/antigravity.ts): every read replaces the
     file's earlier content (`reset: true`).
   - Let the root be overridable (`createXAdapter(root = default)`) so tests can point it at
     fixtures.
2. **Add a sanitized fixture** under `test/fixtures/<tool>/`, mirroring the tool's real folder
   layout.
3. **Test it.** Copy [`test/adapters/codex.test.ts`](test/adapters/codex.test.ts) as a template:
   parse the fixture, assert the messages, the skipped count, that noise is dropped, and that
   unknown fields or line types are ignored without being counted as skipped. Run
   `pnpm test:coverage` and keep it above the thresholds.
4. **Register it** in `defaultAdapters()` in `src/app.ts`, with an `AGENTLORE_<TOOL>_DIR`
   override, and add a row to the README's supported sources table and its configuration table.
   Point the new variable at the fixtures in `fixtureSandbox()` (`test/helpers.ts`) too, so the
   CLI and MCP end-to-end tests never read your real transcripts.
5. **Update tool names shown to users and agents** where they list the supported tools: the
   `lore mcp` help text in `src/cli/index.ts`, the package `description` and `keywords`, and the
   MCP tool descriptions and instructions in `src/mcp/server.ts` if they ever name tools (they
   are sent to the agent in every session, so keep them short; `test/mcp/server.test.ts` checks
   their token budget).
6. Add a changeset and open a pull request.

Redaction, chunking, checkpointing, pruning and search are handled by the core — an adapter
only reads and parses.
