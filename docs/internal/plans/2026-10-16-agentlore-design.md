# agentlore — Design

- **Date:** 2026-10-16
- **Status:** Approved (brainstorming); updated to match the v0.1 implementation. Items marked
  *(planned)* are not built yet.
- **License:** MIT
- **Package / CLI:** `agentlore` / `lore`

## Problem

A developer runs many AI coding sessions — Claude Code, Codex, Cursor, Gemini CLI —
across many repos on one machine. Each agent only knows its own folder. Agent A
cannot use what agent B learned in another repo or tool, and most learnings are
never written down.

## Goal

A local-first, tool-agnostic knowledge layer that every agent can query **only when
needed** (token cost matters), plus a toggleable "knowledge mode" that gives the
working agent broad cross-project context.

## Prior art (2026-10)

No single project covers this. Pieces exist: transcript indexing
(obra/episodic-memory, claude-mem — Claude-only), curated notes (Basic Memory),
live inter-session messaging (Claude Code `SendMessage`), agent mail
(mcp_agent_mail), code graphs (graphify). The gap is a cross-tool, cross-project,
cost-gated librarian with automatic capture.

## Decisions

| Topic | Decision |
|---|---|
| Capture | Hybrid: raw indexing by default (free, offline); project memory notes written by agents and by an opt-in LLM pass ([ADR 0004](../../adr/0004-project-memory.md)) |
| Stack | TypeScript (strict), Node ≥ 22, ESM, one npm package |
| Query | `search` (no LLM, 3 short snippets with ids for agents, 5 in the CLI), `context` (one hit in full with its neighbours) and `ask` *(planned)* (cheap LLM synthesis, falls back to `search`) |
| Interface | MCP server (works in all four tools) + CLI |
| Storage | Single SQLite file, FTS5; optional sqlite-vec *(planned)*. The index is a rebuildable cache ([ADR 0001](../../adr/0001-index-is-a-rebuildable-cache.md)) |
| Privacy | Nothing leaves the machine by default |

## Architecture

```
 Sources                  Core (local, one Node process)            Consumers
┌───────────────┐      ┌──────────────────────────────┐      ┌────────────────┐
│ Claude jsonl  │─┐    │  Ingest ─▶ Chunk ─▶ Index    │      │ Claude Code    │
│ Codex sessions│ │    │            │                 │      │ Codex CLI      │
│ Gemini chats  │ ├──▶ │   SQLite: FTS5 + sqlite-vec  │ ◀──▶ │ Cursor         │
│ Cursor DB     │ │    │            │                 │ MCP  │ Gemini CLI     │
│ Any repo      │ │    │  [Distill: optional LLM]     │      │ CLI: `lore`    │
│ Notes folder  │─┘    │  ─▶ lesson notes (.md)       │      └────────────────┘
└───────────────┘      └──────────────────────────────┘
```

1. **Adapters** (`src/adapters/`) — one module per tool implementing `Adapter`
   (`src/core/types.ts`):
   - `discover()` → `{ sources: SourceRef[], complete }`. A `SourceRef` is
     `{ id, version }`: `id` is a path or any stable id (e.g. `cursor:<db>#<id>`),
     `version` changes whenever the source does (e.g. `${size}:${mtimeMs}`).
     `complete: false` means some sources could not be listed, so nothing is archived.
   - `read(source, checkpoint, { batchSize })` → async batches of
     `{ records: SourceRecord[], checkpoint, reset, skipped }`. The checkpoint is opaque
     JSON owned by the adapter; `reset` discards what was indexed from the source
     before.
   - A `SourceRecord` is `{ kind, tool, sessionId?, title?, role?, project, timestamp,
     text }`: `kind` is `transcript`, `note` or `code`; transcripts set `sessionId`
     and `role`, documents set `title`. `tool` is the adapter's own string id. The
     chunker groups consecutive records by kind and session (else title).
   - JSONL tools use the `jsonlAdapter({ tool, root, parseLines })` helper
     (`src/adapters/jsonl-source.ts`): byte-offset checkpoints, a hash of the first
     1 KB to detect rewritten files, and per-file parser state. Claude Code and Codex
     are a `parseLines` function each. New sources (Gemini, Cursor, repos, notes,
     Windsurf, Aider, …) are one file each.
2. **Indexer** (`src/core/indexer.ts`) — generic: for each source whose version
   changed, iterate `read()`, **redact → chunk → save** each batch in one
   transaction with its checkpoint, record the version only once the source is fully
   read, then archive sources that disappeared (docs/adr/0002). A failing source or adapter is counted
   and skipped; a deadline stops at a batch boundary and the next run resumes.
3. **Index** (`src/core/store.ts`) — `~/.agentlore/index.db`: `sources` (id, tool,
   version, checkpoint), `chunks` (kind, source_id, stable `chunk_key`, session,
   project, dates, text) with an FTS5 table, and `meta`. All SQL lives in the store.
   Local embeddings *(planned)*.
4. **Distill** *(planned)* — with an LLM configured (Anthropic, OpenAI, Ollama),
   each new session yields a few lesson notes in `~/.agentlore/notes/` as
   Markdown: human-readable, editable, git-friendly, and indexed.
5. **Interfaces** — MCP tools `search` and `context`; CLI
   `lore index | search | show | status | mcp`. `src/app.ts` is the composition root
   (default adapters, index location) shared by both; `src/core` never imports
   adapters. *(planned: MCP `ask`; CLI `ask | mode | doctor | distill`.)*

## Data flow

**Indexing triggers** (no daemon):
1. Lazy — on each `search` (MCP tool and `lore search`), if the index is older
   than 10 minutes, run an incremental scan first, stopped after about 8 seconds and
   resumed next time. If another indexer holds the lock or the refresh fails, the
   search answers from the existing index with a one-line "may be stale" note.
   Works for tools without hooks. Never runs the first full backfill.
2. Session-end hooks *(planned)* — `lore index --source <tool>` (+ `lore distill`).
3. Manual — `lore index` for the initial backfill.

**Query path (v0.1):**
```
search(q) → stale? incremental scan
          → retrieve: FTS5 candidates containing every term, then any term; within
            each, more exactly-spelled accented terms first, then bm25 (subagent
            chunks weighted down)
          → rank: all-terms matches first, at most 2 per session, no repeated snippet
          → format: 3 (MCP) / 5 (CLI) 32-word snippets, each under a one-line
            "[n] <id> <tool> <project> <date>" label
context(id) → the chunk by id prefix + up to 3 neighbours per side from the same
            session, nearest first, ≤ 6,000 characters
```
There is no recency boost yet: dates are shown, not ranked.

**Planned:**
```
search(q) → … → FTS5 + vector → RRF merge → rank: lesson notes > transcripts > code
ask(q)    → ~20 snippets → cheap LLM → ≤200 words with citations
```

**Knowledge mode** — `lore mode [on|off|reset] [--here]` writes `mode.json` in
`AGENTLORE_HOME` atomically (temp file + rename, 0600): `{ "global": "on"|"off", "paths":
{ "<abs dir>": "on"|"off" } }`. The effective mode for a folder is the deepest rule containing
it (folder boundaries, paths normalized like projects, case-insensitive on Windows), else the
global setting, else off; a missing or corrupt file reads as off (`src/core/mode.ts`).
- *Universal layer (MCP):* the server instructions (sent once, at initialize) and the `search`
  description (re-read from `mode.json` on every tools/list) follow the mode of the server's
  working directory. Off: the gated wording ("call only if … earlier work … stuck after one
  try"). On: "Knowledge mode is ON (enabled by the user): call search at the start of each new
  task with 3–6 keywords from the task, before exploring the repo, then `context` on the most
  relevant hit, and briefly mention any relevant prior work you used. Skip only trivial
  follow-ups." Both tool lists stay within the 370-token budget test. Limitation: clients that
  start MCP servers outside the session's folder get that folder's mode.
- *Hook layer:* `lore hook claude-prompt` is a Claude Code `UserPromptSubmit` hook (installed
  by `lore hooks install claude`, which backs up and edits `settings.json`, identifying its
  entry by ` hook claude-prompt` in the command). It reads the hook JSON (`prompt`, `cwd`,
  `session_id`) from stdin and, when the mode is on for `cwd`, prints
  `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":…}}`.
  `src/core/prompt-context.ts` favours precision: an unrelated excerpt costs tokens on every
  prompt, so adding nothing is the usual outcome. Usable terms are the prompt's search terms
  minus generic task words (English and Vietnamese: fix, add, test, error, sửa, thêm, lỗi, …).
  Key terms are picked greedily (rarest first, each kept if some chunk still contains all kept
  terms); at least `max(2, ⌈0.5 × usable⌉)` are needed, and every key term is required (no OR
  fallback). Nothing is added when the key terms occur together in more than 0.4% of the index
  (at least 10 chunks; a generic topic), and hits under 60% of the best hit's bm25 are dropped
  (`DEFAULT_PROMPT_TUNING`). An absolute bm25 floor (−18) was tried first and rejected: it
  was overfitted to the first prompt sets and dropped relevant login, dark-mode and magic-link
  excerpts. Excluded: the current session, and the session's project: the git root of its
  folder, else the folder itself (nothing for `$HOME` or a filesystem root). Key terms and the
  generic-topic count are computed outside these too: in a live test, prompts asked before in
  the same folder (or the current session, once indexed) held all their terms, so every term
  was kept, then the search excluded the only chunks containing them all and nothing was added.
  Vietnamese words are syllables ("khách hàng"; "đảo" alone also matches "lừa đảo", fraud), so
  two adjacent usable words, one accented, become one FTS phrase when the phrase is in ≥ 30% of
  the rarer word's chunks (most cohesive pairs first). Filler words no longer take up the
  16-term cap, and generic Vietnamese coding words (chuỗi, mảng, kèm, đề xuất, …) are filler.
  Live prompts after this: a data-import question and a realtime-chat question each found the
  right other project, "đảo ngược một chuỗi" → nothing (all three were wrong before). Instruction words
  ("answer only", "dựa vào ngữ cảnh", "trả lời 2 câu") are filler. Tried and reverted: IDF-
  weighted term coverage with required identifiers — it did not make answers appear (the
  answer's words, e.g. a function name, are not in the question) and doubled latency; a
  required-identifier rule alone cut held-out recall from 12/16 to 9/16.
  Field test (2026-10-20, from another project): chatty prompts were injected on one rare word
  among common ones ("wow", "lore"). Fix: at least 2 key terms must each be in ≤ 5% of the index
  (`specificShare`), plus interjections and feedback words in the language packs. Recalibrated on
  57 prompts (the 2 added as generic): tuned half 9/10, 9/14, 0 generic; held-out 14/15, 14/17, 0.
  The footer now also says excerpts are what past sessions said, not checked facts.
  Calibration: 55 labelled real prompts (31 past work, expected projects checked against the
  index; 24 generic), split in half with a fixed seed. Tuned half: injection precision 11/13,
  past-work recall 11/15, generic injected 0/13. Held-out half: 12/12, 12/16, 0/11. At most 3
  hits in ≤ 900 characters (~225 tokens), formatted as untrusted data, then, after a blank
  line and outside the quoted block, the user's directive: call `context` on the most relevant
  id (or `search`) before answering and mention prior work used (a soft "if relevant" line
  was ignored in a live test whenever a generic answer was possible): the hook
  points the agent at agentlore at the right moment rather than answering for it, since
  single-shot lexical excerpts held the answer in only 3–4 of 8 past-work questions (answers
  need embeddings or lesson notes, planned). The best hit comes first as a ~450-character
  passage of its chunk (`src/core/passage.ts`: the window with the most distinct terms, cut at
  sentence/line boundaries, never inside a surrogate pair or before a combining mark), the
  others as one-line snippets while they fit. Held-out eval after these changes: 12/12,
  12/16, 0/11. The index is opened read-only with no
  refresh and no lock; any error prints nothing and exits 0. Measured: ~100 ms per prompt
  including Node start-up (the CLI loads the MCP SDK only for `lore mcp`).
- *Other tools (verified 2026-10):* Cursor's `beforeSubmitPrompt` can only allow/block
  (`continue`, `user_message`); its `sessionStart` `additional_context` is once per chat. Codex
  documents `UserPromptSubmit` with `hookSpecificOutput.additionalContext` (hooks in
  `~/.codex/hooks.json`, trusted via `/hooks`) — a candidate for the same handler, not yet
  installed or tested. Gemini CLI: not verified.

## Error handling and edge cases

- **Format drift** — zod validation per record; bad records skipped and counted;
  adapters and sources isolated from each other (`lore index` lists the first
  failures); `lore doctor` *(planned)* reports per-adapter health;
  sanitized fixtures per adapter. Cursor (`state.vscdb`, undocumented) ships as
  `experimental`, opened read-only, copied to temp if locked.
- **Scale** — streaming reads in bounded batches; per-batch checkpoints; only the
  user's and assistant's text is kept (images, tool calls and tool outputs are
  dropped); ~800-token chunks on message boundaries; resumable backfill with
  progress.
- **Secrets** — rule-based redaction in the core indexer, applied to every adapter's
  records before anything is stored (sources untouched). *(planned: entropy check;
  always skip `auth.json`, `.env`, `*.pem`; exclude list in
  `~/.agentlore/config.toml`; explicit consent before sending data to a remote LLM.)*
- **Concurrency** — SQLite WAL + a file lock; one indexer at a time, readers use
  the existing index.
- **Stale knowledge** — every result carries date and source; deleted sources are
  archived on the next complete scan and stay searchable (docs/adr/0002). *(planned: newer ranks higher; notes may declare
  `supersedes:`.)*
- **LLM failure** *(planned)* — `ask` falls back to `search`; `distill` queues and
  retries.

## Repository and standards

One npm package (`agentlore`, bin `lore`); split into workspaces only if a second
package is ever needed.

```
agentlore/
├─ src/core/        # types, indexer, chunking, redaction, store (all SQL), search, lock
├─ src/adapters/    # claude, codex, the jsonl-source helper (gemini, cursor, repo, notes later)
├─ src/mcp/         # MCP server
├─ src/cli/         # `lore`
├─ src/app.ts       # composition root: default adapters and index location
├─ test/            # unit and integration tests; test/fixtures/ has sanitized samples
└─ docs/            # design, plans, ADRs
```

- pnpm; TypeScript strict; Biome for lint/format; Vitest.
- Tests: adapter tests on fixtures, index→search integration tests, secret
  redaction tests.
- Conventional Commits, SemVer, Changesets for CHANGELOG.
- GitHub Actions: lint, typecheck, test on macOS, Linux, Windows.
- Community files: LICENSE (MIT), README ("your data never leaves your machine"),
  CONTRIBUTING ("write your first adapter in 30 minutes"), CODE_OF_CONDUCT,
  SECURITY.md, issue/PR templates.

## Roadmap

| Version | Scope | Done when |
|---|---|---|
| v0.1 | core + Claude & Codex adapters + FTS5 + MCP `search` + CLI; `lore mode` (MCP wording + Claude Code prompt hook) | An agent in repo A finds knowledge from a Codex session in repo B |
| v0.2 | Gemini, repo, notes adapters; `ask` with LLM | Mode on/off shows a measurable token difference |
| v0.3 | `distill` lesson notes, local embeddings, `lore doctor` | "What did we decide before?" answered without reading transcripts |
| v0.4 | Cursor adapter (experimental), context-injection hooks for more tools (Codex) | All four tools share one knowledge base |

## Out of scope (YAGNI)

- Long-running librarian agent / live agent-to-agent chat
- Cloud sync, multi-user, web UI
- Code knowledge graph (may integrate graphify output later as a source)
