# agentlore

[![CI](https://github.com/hodfords-solutions/agentlore/actions/workflows/ci.yml/badge.svg)](https://github.com/hodfords-solutions/agentlore/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agentlore.svg)](https://www.npmjs.com/package/agentlore)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Your second brain for AI coding agents.** agentlore remembers every session across your repos
and tools, keeps what matters about each project, and every new session starts out knowing what
you know. Works with Claude Code, Codex, Cursor and Antigravity. Local-first.

[![How agentlore remembers: sessions are recorded, what matters is kept as project notes, and new sessions start with them](docs/project-memory/project-memory.png)](docs/project-memory/project-memory.pdf)

## The problem

You work on many projects and repos, or on one project across many sessions: one session digs
into the database, another the code, a third the business rules. You have the whole picture, but
every new AI session starts from zero, and you explain it all again or write memory files by hand.

agentlore records every session on your machine, keeps what matters about each project (decisions
and their reasons, structure, rules) and hands it to the next session. The agent starts out
understanding the project the way you do, including what you worked out in other repos.

It works like memory does:

- **It records every session.** It indexes the transcripts your tools already write, redacts
  secrets, and keeps sessions the tools delete.
- **It keeps what matters.** Agents save decisions and their reasons, schema, rules and pitfalls
  as [project notes](#project-memory). An optional nightly pass catches what they missed.
- **New sessions start out knowing.** They get the project's brief, its topics and related
  projects at start, and look up details with sources when needed.

Notes are Markdown files you can read and edit. They are written by AI, so they can be wrong or
out of date; agents are told to check them against the code. Sessions are primed automatically in
Claude Code; Codex and Cursor reach the same knowledge through MCP tools. Nothing leaves your
machine unless you turn on the nightly pass, which goes through your own Claude Code.

**How it works:** [docs/how-it-works/how-it-works.pdf](docs/how-it-works/how-it-works.pdf) ·
**Project memory blueprint:** [docs/project-memory/project-memory.pdf](docs/project-memory/project-memory.pdf)

## Quick start

Requires Node.js 22 or newer.

```bash
npx agentlore@0.1.0 index                  # one-time backfill of all past sessions
npx agentlore@0.1.0 search "webhook retry" # search across every project and tool
npx agentlore@0.1.0 status                 # what is indexed
```

Or install it globally to get the `lore` command:

```bash
npm install -g agentlore
lore index
lore search webhook retry --limit 3
lore search "migration plan" --project /Users/me/work/billing-service
lore search "queue decision" --since 2026-09-01 --said user   # only what you said, from September
lore show 1a2b3c4d                   # one result in full, with the chunks around it
```

Each result is one line `[n] <id> <tool> <project> <date>` followed by a short snippet; pass the
id to `lore show` (or the MCP `context` tool) to read more. `--project` also matches sessions in
subfolders of the path, and accepts the project exactly as a result shows it: `~/work/api`, or
`…/apps/api` for a long path shortened to its last two folders (matched wherever those folders
appear).

Later runs of `lore index` are incremental: only new lines in changed files are read.

| Command | Options |
| --- | --- |
| `lore index` | `--rebuild` drops the index and rebuilds it from the transcripts (sessions kept from deleted transcripts stay); `--consolidate` then updates [project memory](#project-memory) from new sessions |
| `lore search <query...>` | `-n, --limit <n>` results (default 5, at most 100); `-p, --project <path>` only that project and its subfolders; `--since <date>` / `--until <date>` only chunks started in that range (UTC days, `YYYY-MM-DD`, both inclusive, or ISO 8601 times); `--said user` only chunks where your own words match, `--said decision` only your decisions; `--no-semantic` keywords only |
| `lore forget <id>` | removes a session kept from a deleted transcript, from the index and its archive |
| `lore show <id>` | `-a, --around <n>` neighbouring chunks per side, 0–3 (default 1) |
| `lore status` | what is indexed; never creates or changes the index |
| `lore embed` | sets up [semantic search](#semantic-search-optional) (downloads once); `--remove` turns it off |
| `lore coverage` | sessions (and chunks) indexed per month and tool; `-p, --project <path>` for one project. Read-only |
| `lore schedule install` | runs `lore index` once a day with the OS scheduler (launchd on macOS, a systemd user timer on Linux, Task Scheduler on Windows); `--at <HH:MM>` (default 12:30), `--dry-run` prints what it would write, `--consolidate` also updates [project memory](#project-memory) (uses your Claude quota). `lore schedule status` / `uninstall` |
| `lore memory show [topic]` | a project's notes (`-p, --project <path>`, default: the current folder's); also `lore memory save <topic>` (text from `--text` or stdin, `--by user\|agent`; for sessions whose MCP server predates `remember`), `lore memory list`, `lore memory path` (the folder of Markdown files to edit), `lore memory forget <topic>` |
| `lore group add <name> <paths...>` | links projects that belong together (one customer, one product); also `lore group list`, `lore group remove <name> [paths...]` |
| `lore consolidate` | updates project notes from new sessions with `claude -p`; `-p, --project <path>`, `--max-projects <n>` (default 5), `--max-chars <n>` read per project (default 60000), `--model <model>` (default `sonnet`), `--dry-run` |
| `lore mcp` | runs the MCP server over stdio (see below) |

For scale: on a real machine, 7.9 GB of transcripts (1,167 files) indexed in about 15 seconds
(peak memory ~370 MB) into a ~42 MB index, and searches take 1–90 ms.

### Everyday use

Once the MCP server is registered (below), keep working as usual. Agents call agentlore on their
own when a task involves earlier work or another repo, and you can ask for it directly:

- "How did we fix the Google OAuth `redirect_uri` error last time?"
- "Do the webhook retries the way we did them in billing-service."
- "What did we decide about the scheduler's browser profiles?"

To have every session start with what its project's other sessions learned, and every prompt
with related past work, turn on [knowledge mode](#knowledge-mode) and let sessions build
[project memory](#project-memory).

## Register the MCP server

Run `lore index` once first. After that, the MCP server keeps the index fresh by itself (see
[How it saves tokens](#how-it-saves-tokens)).

The examples pin an exact version (`agentlore@0.1.0`), so `npx` never silently runs a different
release with access to your transcripts. Raise the pin deliberately when you upgrade.

**Claude Code**

```bash
claude mcp add --scope user agentlore -- npx -y agentlore@0.1.0 mcp
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.agentlore]
command = "npx"
args = ["-y", "agentlore@0.1.0", "mcp"]
```

**Cursor** (`~/.cursor/mcp.json`) and **Gemini CLI** (`~/.gemini/settings.json`)

```json
{ "mcpServers": { "agentlore": { "command": "npx", "args": ["-y", "agentlore@0.1.0", "mcp"] } } }
```

Alternatively, install it globally once (`npm i -g agentlore`) and register the `lore` command
with the arguments `["mcp"]` instead of `npx`, for example
`claude mcp add --scope user agentlore -- lore mcp`. It then starts faster and only changes
when you run `npm i -g agentlore` again.

**Windows.** Some clients start the server without a shell and cannot run `npx` (a `.cmd`
script) directly. Wrap the command in `cmd /c`:

```bash
claude mcp add --scope user agentlore -- cmd /c npx -y agentlore@0.1.0 mcp
```

```json
{ "mcpServers": { "agentlore": { "command": "cmd", "args": ["/c", "npx", "-y", "agentlore@0.1.0", "mcp"] } } }
```

The server exposes two tools:

- `search(query, project?, limit?, since?, until?, said?)` returns 3 short snippets by default
  (at most 10), each labelled with an id, tool, project, date and who said it. `since`/`until`
  (`YYYY-MM-DD`) and `said` (`"user"` or `"decision"`) filter like the CLI options.
- `context(id, around?)` returns that result in full, with up to `around` (default 1, at most 3)
  neighbouring chunks of the same session, capped at about 800 tokens plus 700 per `around`
  (about 1,500 tokens by default, 3,000 at most).

Results are introduced as untrusted data and every line of transcript text is quoted, so text in
old transcripts cannot pass for instructions (see [SECURITY.md](SECURITY.md)). If the index
cannot be opened (for example it was written by a newer agentlore), the server still starts and
the tools return the reason.

## How it saves tokens

Calling a tool costs tokens, so agentlore is built to be called rarely and to answer cheaply:

- **Gated tool description.** The tool tells the agent to call it only when the user refers to
  earlier work ("like last time", in any language), the task involves another repo, it needs a
  prior decision or fix, or it is stuck after one attempt — not for questions the current repo
  can answer. Both tools, descriptions and arguments, cost about 415 tokens.
- **Small answers, two steps.** `search` returns 3 one-line labels with 32-word snippets (about
  240 tokens on real data); the agent asks `context` for the full text only when a snippet looks
  right. Results are ranked with BM25 (chunks containing every query term first, chunks with the
  query's exact Vietnamese diacritics before other spellings, subagent transcripts after main
  sessions, sessions written to in the last 30 minutes after older ones, since they are usually
  the asking session echoing the query, and an agent's unverified conclusions and tasks one agent
  gave another after the user's words and answers citing a file), at most two per session,
  without repeated snippets or chunks that mostly repeat a better hit (a prompt pasted into a
  subagent, say). A query word with diacritics matches only the same word or one
  typed without diacritics: `xây` finds `xay` but not `xảy`.
  Each hit says who said its matching part: `user said`, `user decided` (with a word like
  "decided", "go with", "chốt"), `agent cites <file:line>` (every matching sentence cites a
  file), `agent cites <file:line> + unverified claims` (some do not, ranked like a claim),
  `agent claim, unverified` or `agent task`. A cited file is checked on disk: the label adds
  `(file gone now)`, `(line gone now)` or `(file changed since)`. When a later hit corrects a
  claim about the query ("that is wrong…", "thực ra…") in words it shares with an earlier hit,
  the earlier one ranks lower and says `corrected later? see <id>`. No LLM is involved, so these
  are heuristics: the labels ask rather than assert.
- **No daemon, lazy refresh.** When the index is older than 10 minutes, a search (MCP or
  `lore search`) first runs a short incremental refresh (stopped after about 8 seconds and
  resumed next time). If another process is already indexing, or the refresh fails, the search
  answers from the existing index and says the results may be slightly stale. The first full backfill only ever runs through
  `lore index`. Since only searches refresh, `lore schedule install` adds a daily `lore index`
  so new sessions are indexed (and deleted ones kept) even on days nothing searches. A missed
  run (the computer was asleep) runs when it wakes up. Run it again after changing Node.js
  versions, since the job runs the Node.js binary it was installed with.

## Knowledge mode

By default agents call agentlore only when earlier work clearly matters (see above). Knowledge
mode is for when you want every new task to start with what your other projects and tools
already know:

```bash
lore mode                 # effective mode here, and why (global setting or folder rule)
lore mode on              # on everywhere
lore mode off --here      # ...but off in this folder and its subfolders
lore mode reset --here    # remove this folder's rule
```

The state lives in `~/.agentlore/mode.json` (under `AGENTLORE_HOME`): a global setting plus
per-folder rules; the deepest folder rule containing the working directory wins, then the
global setting, else off.

What it changes:

| Layer | Clients | Off (default) | On |
| --- | --- | --- | --- |
| MCP tool description and server instructions | All (Claude Code, Codex, Cursor, Gemini, Antigravity) | Gated: call only for other repos, earlier work, or when stuck | "Knowledge mode is ON (enabled by the user): call search at the start of each new task with 3–6 keywords from the task, before exploring the repo, then `context` on the most relevant hit, and briefly mention any relevant prior work you used" |
| Hooks | Claude Code (`lore hooks install claude`) | Add nothing | At session start: the project's [memory](#project-memory). On each prompt: up to 3 excerpts from other sessions (this project's and others'), only when clearly related. On stop, now and then: asks the agent to save what it learned |

**MCP layer.** The mode is read for the folder the MCP server was started in, again on every
tools/list, so new sessions pick up a change without restarting anything. Clients normally
start MCP servers in the session's working directory; one that starts it elsewhere (some IDEs
use their own folder) gets the mode of that folder, so use `lore mode on` (global) there. Both
variants of the tool list cost about the same (~335 tokens on, ~365 off).

**Claude Code hooks.** `lore hooks install claude` adds `UserPromptSubmit`, `SessionStart`,
`Stop` and `SessionEnd` hooks (the last three are described under
[Project memory](#project-memory)) to
`~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`, or `--settings <path>`),
after backing the file up to `settings.json.agentlore-backup-<time>` (the newest 3 backups are
kept); every other setting and hook is kept, running it again changes nothing, and if the file
changes while agentlore edits it, nothing is written. `lore hooks uninstall claude` removes only
agentlore's entries, and `lore hooks status` shows whether they are installed and warns when the
Node.js or agentlore path in them no longer exists, or when an older install lacks a hook. The
prompt hook runs
`<node> <path to agentlore>/dist/cli/index.js hook claude-prompt` by absolute path (reinstall
after moving or upgrading a non-global install, e.g. one run through `npx`). On each prompt,
when knowledge mode is on for the session's folder, it searches the existing index (read-only,
no refresh, about 100 ms including Node's start-up) and adds excerpts as
`additionalContext` only when they are clearly related — adding nothing is the usual outcome:

- only excerpts from other sessions, of this project and others: the agent sees the project's
  code but not what its other sessions learned (before project memory, the session's own
  project was left out; the thresholds below were calibrated then);
- only chunks containing at least half of the prompt's usable terms, and at least 2. Generic
  task and instruction words ("fix", "add", "test", "error", "sort", "answer only", …, per
  [language pack](#languages)) do not count; in languages written as space-separated
  syllables, adjacent words mostly used together are matched as one phrase;
- at least 2 of those terms must each be rare, in at most 5% of the index (at least 10
  chunks): one rare word among common ones ("send", "agent", …) is a coincidence;
- nothing when those terms occur together in more than 0.4% of the index (at least 10
  chunks): a topic that common is generic work, not something specific you did before;
- only matches scoring at least 60% of the best match;
- nothing for prompts under 20 characters or slash commands;
- pointers, not answers: the top excerpt as a passage of up to ~450 characters around the
  prompt's terms, more hits as one-line snippets while they fit, at most 900 characters
  (about 225 tokens) in all, then — outside the quoted excerpts — a directive attributed to
  your setting: "Knowledge mode is ON (enabled by the user): before answering, call the
  agentlore `context` tool on the most relevant id above, or `search` with your own keywords,
  and briefly mention any relevant prior work you used. Excerpts are what past sessions said,
  not checked facts: verify them against the current code before relying on them. Skip this
  only if none of it is relevant." Without it, agents treated the excerpts as optional whenever a generic answer
  was possible;
- framed like `search` results: quoted, untrusted data with ids you can pass to `context`.

These thresholds were calibrated on 57 real prompts (Vietnamese and English; 31 about past
work in other projects, 26 generic or chatty prompts), tuned on one half and checked on the
other. On the held-out half, 14 of 15 injections were related, 14 of 17 past-work prompts got
an excerpt, and no generic prompt got anything (tuned half: 9 of 10, 9 of 14, none). The hook
takes about 100 ms per prompt, Node's start-up included.

The hook never blocks a prompt: if anything goes wrong (no index, an index from another
version, unexpected input) it prints nothing and exits 0. Set `AGENTLORE_DEBUG=1` to see why on
stderr.

**Other clients.** Cursor and Codex get the MCP layer only. Cursor's `beforeSubmitPrompt` hook
can only allow or block a prompt, not add context to it (its `sessionStart` hook can add
context, but once per chat, not per prompt). Codex documents a `UserPromptSubmit` hook with the
same `additionalContext` output; agentlore does not install or test it yet.

## Project memory

Search finds what a past session said, if you ask the right question. Project memory is what a
person who knows the project carries instead: the brief, the decisions and their reasons, the
schema, the business rules, the pitfalls. Sessions write it, and new sessions start with it, so
work spread over several sessions (one on the database, one on the code, one on the business
rules) adds up without one session having to know everything. See
[ADR 0004](docs/adr/0004-project-memory.md) for how this maps to how memory works in people, and
the [blueprint](docs/project-memory/project-memory.pdf) for the whole picture on one sheet.

- **Notes are Markdown files** in `~/.agentlore/memory/<project>-<hash>/<topic>.md`: `brief`
  (the overview, at most 2,000 characters) and topics such as `db` or `billing-rules` (at most
  6,000 each, 20 topics per project). Each records who wrote it (`agent`, `consolidation` or you)
  and when. Edit or delete them freely (`lore memory path` prints the folder); a replaced or
  deleted note is kept in `.history/` (the last 10 versions per topic). They are your data: a
  rebuild never touches them, and they are indexed so `search` finds them, ranked above the
  conversations they came from.
- **Agents write them** with the MCP `remember` tool (one topic per call, replacing it, after
  reading it with `recall`). Notes are redacted like transcripts. Where knowledge mode is on, a
  Claude Code `Stop` hook asks the agent to save a decision as soon as you make one (a turn of
  yours with a decision word, see [Languages](#languages)), and what it learned once the session
  has grown by ~250 KB of transcript since the last request; never twice in a row, and not if it
  just saved a note.
- **Other sessions hear of it at once.** The next prompt of every open session in the project
  says which notes changed (one line; the agent then reads them with `recall`), and a session
  that ends is indexed right away in the background (`SessionEnd` hook), so it can be searched
  without waiting for the next refresh.
- **A nightly pass catches the rest** (opt-in): `lore consolidate` finds the projects with new
  sessions since their last pass, and for up to 5 of them asks Claude Code (`claude -p` with
  `sonnet` by default, no tools, no MCP servers, no session saved, agentlore's hooks off) to
  update the notes from the
  newest 60,000 characters of redacted excerpts. This sends those excerpts to Anthropic through
  your Claude Code login and uses your quota. `lore schedule install --consolidate` runs it daily
  after `lore index`; `lore consolidate --dry-run` shows what it would read.
- **Sessions start primed.** Where knowledge mode is on, a Claude Code `SessionStart` hook adds the
  brief, the topic list and the briefs of related projects (at most 2,800 characters, ~700
  tokens), or a line saying there are no notes yet. `recall` reads a topic in full.
- **A user profile travels with you.** One more note, `~/.agentlore/memory/_user/profile.md`
  (at most 1,500 characters), says how you work and talk: the languages you write and want
  replies in, how long answers should be, what your short replies mean, the rules you repeat, what
  you correct agents for. Every session starts with it, in any project or none; `recall` with
  topic `user` reads it (Codex and Cursor get it that way). Agents save it with `remember` topic
  `user`, and the `Stop` hook asks them to when you correct them; the nightly pass updates it from
  your own messages in all projects (not the agents' answers), without names, paths or project
  facts. `lore memory show user` shows it; edit it like any note.
- **Groups link projects** that belong together: `lore group add acme ~/work/acme-api
  ~/work/acme-web` makes each project's brief come with the others'.

Notes are written by agents and can be wrong or go stale. They are framed as data, labelled with
their author and date, and agents are told to check them against the code.

## Semantic search (optional)

Keyword search misses a chunk that says the same thing in other words. `lore embed` adds search
by meaning:

```bash
lore embed           # installs Transformers.js into ~/.agentlore/runtime, downloads the model, embeds every chunk
lore embed --remove  # deletes the vectors and turns it off
```

It downloads `@huggingface/transformers` (about 500 MB with ONNX Runtime, into `~/.agentlore/runtime`) and the
multilingual model `Xenova/multilingual-e5-small` (about 150 MB, into `~/.agentlore/models`)
once; embedding runs locally on the CPU (about 12 minutes for 13,000 chunks on a laptop). After that, `lore
search` and the MCP `search` tool interleave chunks found only by meaning (labelled
`by meaning`) with the keyword hits, whose order is kept. Searches load the model from disk with network
access off, and `lore index` embeds new chunks. The first search in a process loads the model
(about a second); the knowledge-mode prompt hook stays keyword-only to stay fast. Vectors are
stored by text in `index.db` and survive rebuilds ([ADR 0003](docs/adr/0003-opt-in-semantic-search.md)).
`lore search --no-semantic` searches by keywords only.

## Languages

Search works on any language FTS5's `unicode61` tokenizer splits into words (diacritics are
folded, so unaccented queries still match; a query word typed with diacritics matches only that
spelling or the unaccented one). Stopwords and generic task words come from language
packs in [`src/core/languages/`](src/core/languages/): English and Vietnamese today. Adding a
language is one file listing its words plus one line in `index.ts`; see
[CONTRIBUTING.md](CONTRIBUTING.md#add-a-language).

The packs also list the words a user decides with ("decided", "go with", "chốt", "duyệt",
"làm luôn") and corrects with ("wrong", "I meant", "sai", "nhầm", "ý tôi là"), for the `user
decided` label, `--said decision` and `corrected later?`. Add your own in
`~/.agentlore/words.json`; they are read on every search:

```json
{ "decisionWords": ["ship it", "phương án B"], "correctionWords": ["my bad", "lộn rồi"] }
```

Words are matched as whole words, ignoring case but not diacritics. An invalid file is reported
and ignored.

## Supported sources

| Source | Status | Read from |
| --- | --- | --- |
| Claude Code | ✅ supported | `~/.claude/projects/**/*.jsonl` |
| Claude Code prompt history | ✅ sessions whose transcript is gone | `~/.claude/history.jsonl`, with pasted text from `~/.claude/paste-cache` |
| Codex CLI | ✅ supported | `~/.codex/sessions/**/*.jsonl` |
| Cursor | 🧪 experimental | `globalStorage/state.vscdb` in Cursor's `User` folder: `~/Library/Application Support/Cursor/User` (macOS), `~/.config/Cursor/User` (Linux), `%APPDATA%\Cursor\User` (Windows) |
| Gemini Antigravity | ✅ brain artifacts only | `~/.gemini/antigravity/brain/<conversation>/*.md` |
| agentlore project memory | ✅ supported | `~/.agentlore/memory/*/*.md` (see [Project memory](#project-memory)) |
| Gemini CLI | planned (v0.2) | |
| Repositories and notes folders | planned (v0.2) | |
| Windsurf | not supported | no local Cascade history was found to read |

Only the user's and the assistant's own messages are indexed; harness-injected context (system
reminders, slash-command output, compact summaries) is dropped. In Claude Code subagent
transcripts, the prompt the parent agent wrote is labelled `agent:`, not `user:`.

**Claude Code prompt history.** Claude Code deletes transcripts after `cleanupPeriodDays` (30
by default) but keeps every prompt you typed in `~/.claude/history.jsonl`. For sessions with no
transcript on disk or in agentlore's archive, those prompts are indexed as tool
`claude-history`: your own words (labelled `user said` or `user decided`), without the agent's
answers, which are gone. Slash commands are left out; pasted text is put back in place of its
`[Pasted text #n]` placeholder when Claude Code kept it.

**Cursor (experimental).** Each Cursor chat (composer) is a session: its user and assistant
messages are indexed, not tool calls, tool output or the model's thinking. Its project is the
folder (or the `.code-workspace` file's folder) of the window it was started in, found in
`workspaceStorage`; chats found in no workspace, or in a remote one (`vscode-remote://`, whose
paths are on another machine), have no project.

Cursor's database is only read: its contents are never written or copied, and no file is
created or deleted next to it. Without a `-wal` file next to it (Cursor is not running), it is
opened as an immutable file. While Cursor is running, it is opened read-only to see the latest
messages; like every SQLite reader, that connection updates the shared read marks in Cursor's
existing `-shm` file. If the read-only open is not possible, the database is read as immutable
and `lore` warns that results may be slightly stale. Cursor's storage format is undocumented and
may change.

**Gemini Antigravity.** The markdown artifacts Antigravity writes per conversation (task lists,
implementation plans, walkthroughs) are indexed as notes, titled `<conversation id> — <file>`.
Antigravity's conversations themselves (`conversations/*.pb`) are encrypted and cannot be read.

## Privacy

- **Local only.** The index is a single SQLite file at `~/.agentlore/index.db`. agentlore makes
  no network calls and has no telemetry, except when you run `lore embed`, which downloads the
  semantic search runtime and model once (see [Semantic search](#semantic-search-optional)); text
  is embedded on your machine, never sent anywhere. `lore consolidate` (opt-in, see
  [Project memory](#project-memory)) is the one feature that sends text to a model: redacted
  excerpts, through your own Claude Code. Your transcripts are only read, never modified.
- **Private files.** `~/.agentlore` is created (and kept) with mode `0700`; `index.db`, its
  `-wal`/`-shm` files and the lock file are `0600`, readable only by you (on POSIX systems).
- **Every MCP client sees every project.** Any agent you register the MCP server with can search
  the indexed content of all your projects and tools, not only the repo it is working in.
  Register it only with clients you trust with all of your transcripts.
- **Secret redaction.** Before anything is written to the index, secrets are replaced by
  `[REDACTED:<rule>]`. Covered: PEM and PGP private key blocks (an unterminated block is
  redacted to the end of the message); Anthropic, OpenAI, GitHub, GitLab, AWS access key ids,
  Slack tokens and webhook URLs, Google API, Stripe, npm, Hugging Face, SendGrid, Twilio,
  DigitalOcean, Doppler keys and Azure `AccountKey=`/`SharedAccessKey=` values; JWTs;
  `Authorization: Bearer`/`Basic` credentials; passwords in URIs
  (`postgres://user:PASSWORD@host`); command-line passwords (`mysql -p…`, `--password …`,
  `docker login -p …`); and values assigned to secret-like names (`password=`, `DB_PASS=`,
  `api_key:`, `client_secret`, `auth_token`, `private_key`, …) that look like secrets rather
  than code; passwords written in prose next to a login or password word, in any language
  pack (``login `user / secret` ``, ``password (`secret`)``, ``mật khẩu `secret` ``) when they
  have a digit or a symbol; a `user/password` or `user:password` pair right after an IPv4 address
(`203.0.113.7 root/ secret`, also on the next line); and every later mention of a secret found
in the same message.
  Records over 1 MB are truncated before redaction.
- **Known gaps.** Redaction is pattern-based. It misses secrets without a recognizable prefix or
  name (a bare random string in prose, a password typed as an answer to a prompt, a password
  repeated in a later message without a login or password word), AWS secret
  access keys not assigned to a secret-like name, provider formats not listed above, low-entropy
  values such as all-letter passwords assigned to non-password names, and secrets split across
  messages. Treat the index with the same care as the transcripts themselves. When the rules
  change, an upgraded agentlore rebuilds the index so the new rules apply to old content too.
- **Symlinks are skipped.** Symlinked transcript files and folders are not followed, so the
  index only contains files that really live under the tool's session folder.
- **Deleted transcripts are kept.** Tools delete their own transcripts (Claude Code after 30 days
  by default), so when a transcript disappears agentlore keeps what it had indexed from it, in an
  archive inside `index.db` that rebuilds do not drop (re-redacted when the rules change). Deleting
  a transcript therefore does not remove it from agentlore: `lore forget <id>` removes that
  session (`lore status` shows how many are kept). If the transcript still exists, delete it
  first and run `lore index`, or it would be indexed again.
- **Delete at any time.** `rm -rf ~/.agentlore` removes everything agentlore has stored;
  `lore index --rebuild` drops the index and rebuilds it from the transcripts and the archive.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTLORE_HOME` | `~/.agentlore` | Where the index (`index.db`), its lock file, the knowledge mode state (`mode.json`), your own decision and correction words (`words.json`, see [Languages](#languages)) and project memory (`memory/`) live |
| `AGENTLORE_CLAUDE_DIR` | `~/.claude/projects` | Claude Code transcripts to index |
| `AGENTLORE_CLAUDE_HISTORY` | `history.jsonl` next to the transcripts folder | Claude Code's prompt history |
| `AGENTLORE_CODEX_DIR` | `~/.codex/sessions` | Codex transcripts to index |
| `AGENTLORE_CURSOR_DIR` | Cursor's `User` folder (see above) | Cursor folder holding `globalStorage/state.vscdb` and `workspaceStorage` |
| `AGENTLORE_ANTIGRAVITY_DIR` | `~/.gemini/antigravity/brain` | Antigravity brain artifacts to index |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's settings folder, for `lore hooks` (Claude Code's own variable) |
| `AGENTLORE_DEBUG` | unset | `1`: the hooks explain on stderr why they added nothing |
| `AGENTLORE_NO_HOOKS` | unset | `1`: the hooks do nothing (set for the sessions `lore consolidate` starts) |

When you set these for the MCP server, set them in the MCP client's server config (for example
an `env` block) so the server and `lore index` use the same index.

## Troubleshooting

- `lore status` shows what is indexed per tool, the number of projects, the index size and when
  it was last indexed. It never creates or changes the index.
- `lore index` prints `claude: ~/.claude/projects not found — skipped` for a tool whose
  transcript folder does not exist (for Cursor, its `state.vscdb`); set `AGENTLORE_CLAUDE_DIR`,
  `AGENTLORE_CODEX_DIR`, `AGENTLORE_CURSOR_DIR` or `AGENTLORE_ANTIGRAVITY_DIR` if yours live
  elsewhere.
- `lore index` prints `errors N`, a hint and the first few failing sources (files) or folders when some
  could not be read (for example because of permissions). They are skipped and retried on the
  next run; the exit code stays 0.
- ``Another `lore index` is running`` means another indexer holds the lock in `AGENTLORE_HOME`.
  Wait for it to finish.
- A topic you remember discussing is not found: `lore coverage` shows how many sessions of each
  month are indexed. agentlore keeps sessions whose transcript was deleted after it indexed them,
  but cannot see transcripts deleted before. Claude Code deletes transcripts inactive for 30 days
  by default; set `"cleanupPeriodDays"` in `~/.claude/settings.json` to a larger number (e.g.
  3650) so they stay on disk too.
- If the index was created by a newer agentlore version, older versions refuse to touch it and
  tell you to upgrade (or delete the index file to rebuild it).

## Roadmap

| Version | Scope |
| --- | --- |
| v0.1 | Claude Code, Codex, Cursor (experimental) and Antigravity adapters, full-text search, MCP `search` and `context`, CLI, knowledge mode (MCP wording, Claude Code hooks), project memory (`recall`, `remember`, opt-in consolidation) |
| v0.2 | Gemini CLI, repository and notes adapters; `ask` (LLM synthesis) |
| v0.3 | `lore doctor`, consolidation with Codex |
| v0.4 | Context-injection hooks for more tools (Codex `UserPromptSubmit`) |

See the [design document](docs/internal/plans/2026-10-16-agentlore-design.md) for details.

## Contributing

Contributions are welcome, especially new adapters. See [CONTRIBUTING.md](CONTRIBUTING.md) —
writing an adapter for a new tool takes about 30 minutes. Please follow the
[Code of Conduct](CODE_OF_CONDUCT.md), and report security issues as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
