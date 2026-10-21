# agentlore v0.1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Index Claude Code and Codex transcripts from every project into one local SQLite FTS5 index, and expose cross-project `search` through a CLI (`lore`) and an MCP server.

**Architecture:** Single npm package `agentlore`. Adapters turn tool-specific JSONL lines into a common `Message`; the indexer reads files incrementally (byte offsets), redacts secrets, chunks messages and stores them in SQLite with an FTS5 index. `search` ranks with bm25. The MCP server re-indexes lazily when the index is older than 10 minutes.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 22, pnpm, better-sqlite3, zod, commander, @modelcontextprotocol/sdk, Vitest, Biome, Changesets.

**Design:** [`2026-10-16-agentlore-design.md`](2026-10-16-agentlore-design.md). Deviation for v0.1: one package instead of a pnpm monorepo (split later if needed); Node ≥ 22 because better-sqlite3 13 requires it.

**Conventions for every task**
- Run commands from the repository root.
- Relative imports end in `.js` (NodeNext).
- Never put realistic secrets in fixtures; build fake keys in tests by string concatenation.
- Commit messages follow Conventional Commits.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `.editorconfig`, `.nvmrc`, `LICENSE`

**Step 1: Create `package.json`**

```json
{
  "name": "agentlore",
  "version": "0.0.0",
  "description": "Local-first knowledge librarian shared by all your AI coding agents (Claude Code, Codex, Cursor, Gemini).",
  "license": "MIT",
  "type": "module",
  "bin": { "lore": "dist/cli/index.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=22" },
  "keywords": ["mcp", "claude-code", "codex", "agents", "memory", "knowledge"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "format": "biome check --write .",
    "test": "vitest run",
    "prepublishOnly": "pnpm build"
  }
}
```

**Step 2: Install dependencies**

```bash
pnpm add better-sqlite3 zod commander @modelcontextprotocol/sdk
pnpm add -D typescript @types/node @types/better-sqlite3 vitest @biomejs/biome @changesets/cli
```

If pnpm blocks the better-sqlite3 build script, run `pnpm approve-builds` and approve `better-sqlite3`, then `pnpm rebuild better-sqlite3`.

**Step 3: Create `tsconfig.json` (typecheck: src + test) and `tsconfig.build.json` (emit: src only)**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

**Step 4: Create `biome.json`**

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "files": { "includes": ["**", "!dist", "!coverage", "!test/fixtures"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

If `biome check` rejects a key (schema differs by version), regenerate with `pnpm biome init` and re-apply the formatter settings above.

**Step 5: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], passWithNoTests: true },
});
```

**Step 6: Create `.gitignore`, `.editorconfig`, `.nvmrc`, `LICENSE`**

`.gitignore`:
```
node_modules/
dist/
coverage/
*.log
.DS_Store
```

`.editorconfig`:
```
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true
```

`.nvmrc`: `22`

`LICENSE`: standard MIT text, `Copyright (c) 2026 agentlore contributors`.

**Step 7: Verify**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all succeed (vitest reports no test files, exits 0).

**Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript project with Biome, Vitest and MIT license"
```

---

### Task 2: Core types

**Files:**
- Create: `src/core/types.ts`

**Step 1: Write the types (no runtime logic, so no test)**

```ts
export type Tool = "claude" | "codex";

/** One user or assistant message, normalized across tools. */
export interface Message {
  tool: Tool;
  sessionId: string;
  /** Working directory of the session (the repo/folder). */
  project: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  role: "user" | "assistant";
  text: string;
}

/** A group of consecutive messages from one session, the unit we index. */
export interface Chunk {
  tool: Tool;
  sessionId: string;
  project: string;
  startedAt: string;
  endedAt: string;
  text: string;
}

/** Per-file state an adapter keeps between incremental reads (e.g. Codex session cwd). */
export type FileState = Record<string, string>;

export interface ParseResult {
  messages: Message[];
  /** Lines that were not valid JSON or did not match the expected schema. */
  skipped: number;
}

export interface Adapter {
  tool: Tool;
  /** Absolute paths of all source files for this tool. */
  discover(): Promise<string[]>;
  /** Parse complete JSONL lines. May read and update `state`. */
  parse(lines: string[], file: string, state: FileState): ParseResult;
}
```

**Step 2: Verify and commit**

Run: `pnpm typecheck` — Expected: PASS

```bash
git add src/core/types.ts
git commit -m "feat(core): add normalized message, chunk and adapter types"
```

---

### Task 3: Secret redaction

**Files:**
- Create: `src/core/redact.ts`
- Test: `test/core/redact.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { redact } from "../../src/core/redact.js";

// Fake secrets are assembled at runtime so no secret-like literal lives in the repo.
const fake = (prefix: string, n = 40) => prefix + "A1b2C3d4".repeat(Math.ceil(n / 8)).slice(0, n);

describe("redact", () => {
  it.each([
    ["anthropic-key", fake("sk-ant-api03-")],
    ["openai-key", fake("sk-proj-")],
    ["github-token", fake("ghp_", 36)],
    ["aws-access-key", `AKIA${"ABCDEFGHIJKLMNOP"}`],
    ["slack-token", fake("xoxb-", 24)],
  ])("redacts %s", (rule, secret) => {
    const out = redact(`use ${secret} now`);
    expect(out).toBe(`use [REDACTED:${rule}] now`);
  });

  it("redacts private key blocks", () => {
    const block = ["-----BEGIN RSA PRIVATE KEY-----", "abc", "-----END RSA PRIVATE KEY-----"].join(
      "\n",
    );
    expect(redact(`key:\n${block}\nend`)).toBe("key:\n[REDACTED:private-key]\nend");
  });

  it("redacts values of secret-like assignments but keeps the name", () => {
    expect(redact('password = "hunter2hunter2"')).toBe('password = "[REDACTED:assignment]"');
  });

  it("does not double-redact", () => {
    expect(redact(`api_key=${fake("sk-ant-api03-")}`)).toBe("api_key=[REDACTED:anthropic-key]");
  });

  it("leaves normal text untouched", () => {
    const text = "The token bucket refills every second; see tokenizer.ts";
    expect(redact(text)).toBe(text);
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm vitest run test/core/redact.test.ts`
Expected: FAIL — cannot find module `src/core/redact.js`.

**Step 3: Implement**

```ts
type Rule = { name: string; pattern: RegExp; keepGroup1?: boolean };

// Order matters: specific providers before generic patterns.
const RULES: Rule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: "github-pat", pattern: /github_pat_[A-Za-z0-9_]{22,}/g },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "slack-token", pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: "assignment",
    pattern:
      /\b((?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"']{8,})/gi,
    keepGroup1: true,
  },
];

/** Replace secrets with `[REDACTED:<rule>]`. Applied before anything is written to the index. */
export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (_match, group1: string) =>
      rule.keepGroup1 ? `${group1}[REDACTED:${rule.name}]` : `[REDACTED:${rule.name}]`,
    );
  }
  return out;
}
```

**Step 4: Run to verify it passes**

Run: `pnpm vitest run test/core/redact.test.ts` — Expected: PASS (9 tests)

**Step 5: Commit**

```bash
git add src/core/redact.ts test/core/redact.test.ts
git commit -m "feat(core): redact common secrets before indexing"
```

---

### Task 4: Chunking

**Files:**
- Create: `src/core/chunk.ts`
- Test: `test/core/chunk.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { chunkMessages } from "../../src/core/chunk.js";
import type { Message } from "../../src/core/types.js";

const msg = (over: Partial<Message> = {}): Message => ({
  tool: "claude",
  sessionId: "s1",
  project: "/p",
  timestamp: "2026-01-01T00:00:00Z",
  role: "user",
  text: "hello",
  ...over,
});

describe("chunkMessages", () => {
  it("groups consecutive messages of one session into one chunk", () => {
    const chunks = chunkMessages([
      msg({ text: "question", timestamp: "2026-01-01T00:00:00Z" }),
      msg({ role: "assistant", text: "answer", timestamp: "2026-01-01T00:01:00Z" }),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      sessionId: "s1",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:01:00Z",
      text: "user: question\n\nassistant: answer",
    });
  });

  it("starts a new chunk when the session changes", () => {
    const chunks = chunkMessages([msg(), msg({ sessionId: "s2" })]);
    expect(chunks.map((c) => c.sessionId)).toEqual(["s1", "s2"]);
  });

  it("starts a new chunk when the size limit is reached", () => {
    const chunks = chunkMessages([msg({ text: "a".repeat(60) }), msg({ text: "b".repeat(60) })], 100);
    expect(chunks).toHaveLength(2);
  });

  it("splits a single oversized message", () => {
    const chunks = chunkMessages([msg({ text: "x".repeat(250) })], 100);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(100);
  });

  it("returns nothing for no messages", () => {
    expect(chunkMessages([])).toEqual([]);
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm vitest run test/core/chunk.test.ts` — Expected: FAIL (module not found)

**Step 3: Implement**

```ts
import type { Chunk, Message } from "./types.js";

/** ~800 tokens. */
export const MAX_CHUNK_CHARS = 3200;
const SEPARATOR = "\n\n";

const format = (m: Message) => `${m.role}: ${m.text}`;

function splitOversized(m: Message, max: number): Message[] {
  if (format(m).length <= max) return [m];
  const size = max - `${m.role}: `.length;
  const parts: Message[] = [];
  for (let i = 0; i < m.text.length; i += size) {
    parts.push({ ...m, text: m.text.slice(i, i + size) });
  }
  return parts;
}

/** Group consecutive messages of the same session into chunks of at most `max` characters. */
export function chunkMessages(messages: Message[], max = MAX_CHUNK_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Message[] = [];
  let length = 0;

  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    chunks.push({
      tool: first.tool,
      sessionId: first.sessionId,
      project: first.project,
      startedAt: first.timestamp,
      endedAt: last.timestamp,
      text: current.map(format).join(SEPARATOR),
    });
    current = [];
    length = 0;
  };

  for (const message of messages) {
    for (const part of splitOversized(message, max)) {
      const partLength = format(part).length;
      const first = current[0];
      const sameSession =
        !first || (first.sessionId === part.sessionId && first.project === part.project);
      const extra = current.length ? SEPARATOR.length : 0;
      if (!sameSession || length + extra + partLength > max) flush();
      length += (current.length ? SEPARATOR.length : 0) + partLength;
      current.push(part);
    }
  }
  flush();
  return chunks;
}
```

**Step 4: Run to verify it passes**

Run: `pnpm vitest run test/core/chunk.test.ts` — Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add src/core/chunk.ts test/core/chunk.test.ts
git commit -m "feat(core): chunk messages by session and size"
```

---

### Task 5: Incremental JSONL reader

**Files:**
- Create: `src/core/jsonl.ts`
- Test: `test/core/jsonl.test.ts`

**Step 1: Write the failing test**

```ts
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLinesFrom } from "../../src/core/jsonl.js";

const tmpFile = (content: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "lore-jsonl-")), "f.jsonl");
  writeFileSync(file, content);
  return file;
};

describe("readLinesFrom", () => {
  it("reads complete lines and returns the next offset", async () => {
    const file = tmpFile('{"a":1}\n{"b":2}\n');
    const { lines, offset } = await readLinesFrom(file, 0);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(offset).toBe(16);
  });

  it("does not consume a trailing partial line", async () => {
    const file = tmpFile('{"a":1}\n{"b":');
    const first = await readLinesFrom(file, 0);
    expect(first.lines).toEqual(['{"a":1}']);
    appendFileSync(file, '2}\n');
    const second = await readLinesFrom(file, first.offset);
    expect(second.lines).toEqual(['{"b":2}']);
  });

  it("counts offsets in bytes for multi-byte text", async () => {
    const file = tmpFile('{"t":"tiếng việt"}\n');
    const { offset } = await readLinesFrom(file, 0);
    expect(offset).toBe(Buffer.byteLength('{"t":"tiếng việt"}\n'));
  });

  it("skips blank lines", async () => {
    const file = tmpFile('\n{"a":1}\n\n');
    expect((await readLinesFrom(file, 0)).lines).toEqual(['{"a":1}']);
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm vitest run test/core/jsonl.test.ts` — Expected: FAIL (module not found)

**Step 3: Implement (streaming, so 100+ MB transcripts never load at once)**

```ts
import { createReadStream } from "node:fs";

const NEWLINE = 0x0a;

/**
 * Read complete lines starting at byte `offset`.
 * A trailing line without "\n" is left for the next call (the writer may still be appending).
 */
export async function readLinesFrom(
  path: string,
  offset: number,
): Promise<{ lines: string[]; offset: number }> {
  const lines: string[] = [];
  let position = offset;
  let pending: Buffer = Buffer.alloc(0);

  for await (const chunk of createReadStream(path, { start: offset }) as AsyncIterable<Buffer>) {
    const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    let newline = buffer.indexOf(NEWLINE, start);
    while (newline !== -1) {
      const line = buffer.subarray(start, newline).toString("utf8");
      if (line.trim() !== "") lines.push(line);
      position += newline - start + 1;
      start = newline + 1;
      newline = buffer.indexOf(NEWLINE, start);
    }
    pending = buffer.subarray(start);
  }
  return { lines, offset: position };
}
```

**Step 4: Run to verify it passes**

Run: `pnpm vitest run test/core/jsonl.test.ts` — Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/core/jsonl.ts test/core/jsonl.test.ts
git commit -m "feat(core): stream complete JSONL lines from a byte offset"
```

---

### Task 6: Claude Code adapter

**Files:**
- Create: `src/adapters/fs.ts`, `src/adapters/claude.ts`
- Create: `test/fixtures/claude/-work-repo-a/claude-s1.jsonl`
- Test: `test/adapters/claude.test.ts`

**Step 1: Create the fixture** (mirrors the real format observed in `~/.claude/projects/**/*.jsonl`)

```jsonl
{"type":"permission-mode","permissionMode":"default","sessionId":"claude-s1"}
{"type":"user","sessionId":"claude-s1","cwd":"/work/repo-a","timestamp":"2026-06-03T02:51:45.340Z","message":{"role":"user","content":"Why does the payment webhook retry twice?"}}
{"type":"assistant","sessionId":"claude-s1","cwd":"/work/repo-a","timestamp":"2026-06-03T02:51:50.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Stripe retries because the handler returns 500 before the idempotency check."}]}}
{"type":"user","sessionId":"claude-s1","cwd":"/work/repo-a","timestamp":"2026-06-03T02:52:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}
{"type":"user","sessionId":"claude-s1","cwd":"/work/repo-a","timestamp":"2026-06-03T02:52:10.000Z","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>ignore</local-command-caveat>"}}
{"type":"user","sessionId":"claude-s1","cwd":"/work/repo-a","timestamp":"2026-06-03T02:52:20.000Z","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>injected context</system-reminder>Thanks, move the idempotency check first."}]}}
not json at all
```

**Step 2: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeAdapter } from "../../src/adapters/claude.js";

const root = join(import.meta.dirname, "../fixtures/claude");
const file = join(root, "-work-repo-a/claude-s1.jsonl");
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);

describe("claude adapter", () => {
  const adapter = createClaudeAdapter(root);

  it("discovers jsonl files recursively", async () => {
    expect(await adapter.discover()).toEqual([file]);
  });

  it("returns no files when the root does not exist", async () => {
    expect(await createClaudeAdapter(join(root, "missing")).discover()).toEqual([]);
  });

  it("extracts user and assistant text only", () => {
    const { messages, skipped } = adapter.parse(lines, file, {});
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Why does the payment webhook retry twice?"],
      ["assistant", "Stripe retries because the handler returns 500 before the idempotency check."],
      ["user", "Thanks, move the idempotency check first."],
    ]);
    expect(messages[0]).toMatchObject({
      tool: "claude",
      sessionId: "claude-s1",
      project: "/work/repo-a",
      timestamp: "2026-06-03T02:51:45.340Z",
    });
    expect(skipped).toBe(1);
  });
});
```

**Step 3: Run to verify it fails**

Run: `pnpm vitest run test/adapters/claude.test.ts` — Expected: FAIL (module not found)

**Step 4: Implement `src/adapters/fs.ts`**

```ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Absolute paths of files under `root` ending in `extension`, sorted. Missing root → []. */
export async function findFiles(root: string, extension: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true });
    return entries
      .filter((entry) => entry.endsWith(extension))
      .map((entry) => join(root, entry))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
```

**Step 5: Implement `src/adapters/claude.ts`**

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Adapter, Message } from "../core/types.js";
import { findFiles, parseJson } from "./fs.js";

const Line = z.object({
  type: z.string(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  timestamp: z.string().optional(),
  isMeta: z.boolean().optional(),
  message: z
    .object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.string(), text: z.string().optional() })),
      ]),
    })
    .optional(),
});

const INJECTED = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function extractText(content: string | { type: string; text?: string }[]): string {
  const raw =
    typeof content === "string"
      ? content
      : content
          .filter((block) => block.type === "text" && block.text)
          .map((block) => block.text)
          .join("\n");
  return raw.replace(INJECTED, "").trim();
}

export function createClaudeAdapter(root = join(homedir(), ".claude", "projects")): Adapter {
  return {
    tool: "claude",
    discover: () => findFiles(root, ".jsonl"),
    parse(lines) {
      const messages: Message[] = [];
      let skipped = 0;
      for (const raw of lines) {
        const result = Line.safeParse(parseJson(raw));
        if (!result.success) {
          skipped++;
          continue;
        }
        const line = result.data;
        if (line.type !== "user" && line.type !== "assistant") continue;
        if (line.isMeta || !line.message || !line.sessionId) continue;
        const text = extractText(line.message.content);
        if (!text) continue;
        messages.push({
          tool: "claude",
          sessionId: line.sessionId,
          project: line.cwd ?? "",
          timestamp: line.timestamp ?? "",
          role: line.type,
          text,
        });
      }
      return { messages, skipped };
    },
  };
}
```

**Step 6: Run to verify it passes**

Run: `pnpm vitest run test/adapters/claude.test.ts` — Expected: PASS (3 tests)

**Step 7: Commit**

```bash
git add src/adapters test/adapters/claude.test.ts test/fixtures/claude
git commit -m "feat(adapters): add Claude Code transcript adapter"
```

---

### Task 7: Codex adapter

**Files:**
- Create: `src/adapters/codex.ts`
- Create: `test/fixtures/codex/2026/07/08/rollout-2026-07-08T14-28-56-codex-s1.jsonl`
- Test: `test/adapters/codex.test.ts`

**Step 1: Create the fixture** (mirrors `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; clean text lives in `event_msg` user_message/agent_message)

```jsonl
{"timestamp":"2026-07-08T07:29:14.467Z","type":"session_meta","payload":{"id":"codex-s1","cwd":"/work/repo-b","originator":"codex_cli_rs"}}
{"timestamp":"2026-07-08T07:29:15.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>"}]}}
{"timestamp":"2026-07-08T07:29:16.000Z","type":"event_msg","payload":{"type":"user_message","message":"How does the warehouse import work?"}}
{"timestamp":"2026-07-08T07:29:20.000Z","type":"event_msg","payload":{"type":"agent_message","message":"The warehouse import is a one-time seed via POST /inventory/seed, not incremental."}}
{"timestamp":"2026-07-08T07:29:21.000Z","type":"event_msg","payload":{"type":"token_count"}}
not json at all
```

**Step 2: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexAdapter } from "../../src/adapters/codex.js";
import type { FileState } from "../../src/core/types.js";

const root = join(import.meta.dirname, "../fixtures/codex");
const file = join(root, "2026/07/08/rollout-2026-07-08T14-28-56-codex-s1.jsonl");
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);

describe("codex adapter", () => {
  const adapter = createCodexAdapter(root);

  it("discovers rollout files", async () => {
    expect(await adapter.discover()).toEqual([file]);
  });

  it("extracts user and agent messages with the session cwd", () => {
    const state: FileState = {};
    const { messages, skipped } = adapter.parse(lines, file, state);
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "How does the warehouse import work?"],
      [
        "assistant",
        "The warehouse import is a one-time seed via POST /inventory/seed, not incremental.",
      ],
    ]);
    expect(messages[0]).toMatchObject({
      tool: "codex",
      sessionId: "codex-s1",
      project: "/work/repo-b",
    });
    expect(skipped).toBe(1);
  });

  it("remembers session metadata across incremental reads via state", () => {
    const state: FileState = {};
    adapter.parse(lines.slice(0, 1), file, state);
    const { messages } = adapter.parse(lines.slice(2, 3), file, state);
    expect(messages[0]).toMatchObject({ sessionId: "codex-s1", project: "/work/repo-b" });
  });

  it("falls back to the file name when session_meta is missing", () => {
    const { messages } = adapter.parse(lines.slice(2, 3), file, {});
    expect(messages[0]?.sessionId).toBe("rollout-2026-07-08T14-28-56-codex-s1");
  });
});
```

**Step 3: Run to verify it fails**

Run: `pnpm vitest run test/adapters/codex.test.ts` — Expected: FAIL (module not found)

**Step 4: Implement**

```ts
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Adapter, Message } from "../core/types.js";
import { findFiles, parseJson } from "./fs.js";

const Line = z.object({
  timestamp: z.string().optional(),
  type: z.string(),
  payload: z
    .object({
      type: z.string().optional(),
      id: z.string().optional(),
      session_id: z.string().optional(),
      cwd: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const ROLES: Record<string, Message["role"]> = {
  user_message: "user",
  agent_message: "assistant",
};

export function createCodexAdapter(root = join(homedir(), ".codex", "sessions")): Adapter {
  return {
    tool: "codex",
    discover: () => findFiles(root, ".jsonl"),
    parse(lines, file, state) {
      const messages: Message[] = [];
      let skipped = 0;
      for (const raw of lines) {
        const result = Line.safeParse(parseJson(raw));
        if (!result.success) {
          skipped++;
          continue;
        }
        const { type, payload, timestamp } = result.data;
        if (type === "session_meta" && payload) {
          const id = payload.id ?? payload.session_id;
          if (id) state.sessionId = id;
          if (payload.cwd) state.project = payload.cwd;
          continue;
        }
        const role = type === "event_msg" && payload?.type ? ROLES[payload.type] : undefined;
        const text = payload?.message?.trim();
        if (!role || !text) continue;
        messages.push({
          tool: "codex",
          sessionId: state.sessionId ?? basename(file, ".jsonl"),
          project: state.project ?? "",
          timestamp: timestamp ?? "",
          role,
          text,
        });
      }
      return { messages, skipped };
    },
  };
}
```

**Step 5: Run to verify it passes**

Run: `pnpm vitest run test/adapters/codex.test.ts` — Expected: PASS (4 tests)

**Step 6: Commit**

```bash
git add src/adapters/codex.ts test/adapters/codex.test.ts test/fixtures/codex
git commit -m "feat(adapters): add Codex session adapter"
```

---

### Task 8: SQLite store

**Files:**
- Create: `src/core/store.ts`
- Test: `test/core/store.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { openStore } from "../../src/core/store.js";
import type { Chunk } from "../../src/core/types.js";

const chunk = (text: string): Chunk => ({
  tool: "codex",
  sessionId: "s1",
  project: "/p",
  startedAt: "2026-01-01T00:00:00Z",
  endedAt: "2026-01-01T00:01:00Z",
  text,
});

const row = (over = {}) => ({
  path: "/f.jsonl",
  tool: "codex" as const,
  size: 10,
  mtimeMs: 1,
  offset: 10,
  state: { project: "/p" },
  ...over,
});

describe("store", () => {
  it("saves file progress with chunks and reads it back", () => {
    const store = openStore(":memory:");
    store.saveFile(row(), [chunk("hello world")], { reset: false });
    expect(store.getFile("/f.jsonl")).toEqual(row());
    expect(store.stats()).toEqual([{ tool: "codex", files: 1, chunks: 1 }]);
  });

  it("appends chunks on incremental saves and replaces them on reset", () => {
    const store = openStore(":memory:");
    store.saveFile(row(), [chunk("a")], { reset: false });
    store.saveFile(row({ offset: 20 }), [chunk("b")], { reset: false });
    expect(store.stats()[0]?.chunks).toBe(2);
    store.saveFile(row({ offset: 5 }), [chunk("c")], { reset: true });
    expect(store.stats()[0]?.chunks).toBe(1);
  });

  it("removes a file and its chunks", () => {
    const store = openStore(":memory:");
    store.saveFile(row(), [chunk("a")], { reset: false });
    store.removeFile("/f.jsonl");
    expect(store.getFile("/f.jsonl")).toBeUndefined();
    expect(store.stats()).toEqual([]);
  });

  it("keeps the full-text index in sync", () => {
    const store = openStore(":memory:");
    store.saveFile(row(), [chunk("idempotency check")], { reset: false });
    const count = () =>
      store.db.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'idempotency'").get() as { n: number };
    expect(count().n).toBe(1);
    store.removeFile("/f.jsonl");
    expect(count().n).toBe(0);
  });

  it("stores metadata", () => {
    const store = openStore(":memory:");
    expect(store.getMeta("lastIndexedAt")).toBeUndefined();
    store.setMeta("lastIndexedAt", "2026-01-01T00:00:00Z");
    expect(store.getMeta("lastIndexedAt")).toBe("2026-01-01T00:00:00Z");
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm vitest run test/core/store.test.ts` — Expected: FAIL (module not found)

**Step 3: Implement**

```ts
import Database from "better-sqlite3";
import type { Chunk, FileState, Tool } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  read_offset INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  file TEXT NOT NULL,
  tool TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export interface FileRow {
  path: string;
  tool: Tool;
  size: number;
  mtimeMs: number;
  offset: number;
  state: FileState;
}

export interface ToolStats {
  tool: string;
  files: number;
  chunks: number;
}

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);

  const statements = {
    getFile: db.prepare(
      "SELECT path, tool, size, mtime_ms AS mtimeMs, read_offset AS offset, state FROM files WHERE path = ?",
    ),
    upsertFile: db.prepare(`
      INSERT INTO files (path, tool, size, mtime_ms, read_offset, state)
      VALUES (@path, @tool, @size, @mtimeMs, @offset, @state)
      ON CONFLICT(path) DO UPDATE SET tool = excluded.tool, size = excluded.size,
        mtime_ms = excluded.mtime_ms, read_offset = excluded.read_offset, state = excluded.state`),
    deleteChunks: db.prepare("DELETE FROM chunks WHERE file = ?"),
    deleteFile: db.prepare("DELETE FROM files WHERE path = ?"),
    insertChunk: db.prepare(`
      INSERT INTO chunks (file, tool, session_id, project, started_at, ended_at, text)
      VALUES (@file, @tool, @sessionId, @project, @startedAt, @endedAt, @text)`),
    listPaths: db.prepare("SELECT path FROM files WHERE tool = ?"),
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
    stats: db.prepare(`
      SELECT f.tool AS tool, count(DISTINCT f.path) AS files, count(c.id) AS chunks
      FROM files f LEFT JOIN chunks c ON c.file = f.path GROUP BY f.tool ORDER BY f.tool`),
  };

  const saveFile = db.transaction((row: FileRow, chunks: Chunk[], reset: boolean) => {
    if (reset) statements.deleteChunks.run(row.path);
    for (const chunk of chunks) statements.insertChunk.run({ file: row.path, ...chunk });
    statements.upsertFile.run({ ...row, state: JSON.stringify(row.state) });
  });

  const removeFile = db.transaction((path: string) => {
    statements.deleteChunks.run(path);
    statements.deleteFile.run(path);
  });

  return {
    db,
    getFile(path: string): FileRow | undefined {
      const raw = statements.getFile.get(path) as (Omit<FileRow, "state"> & { state: string }) | undefined;
      return raw && { ...raw, state: JSON.parse(raw.state) as FileState };
    },
    saveFile(row: FileRow, chunks: Chunk[], options: { reset: boolean }) {
      saveFile(row, chunks, options.reset);
    },
    removeFile(path: string) {
      removeFile(path);
    },
    listPaths(tool: Tool): string[] {
      return (statements.listPaths.all(tool) as { path: string }[]).map((r) => r.path);
    },
    getMeta(key: string): string | undefined {
      return (statements.getMeta.get(key) as { value: string } | undefined)?.value;
    },
    setMeta(key: string, value: string) {
      statements.setMeta.run(key, value);
    },
    stats(): ToolStats[] {
      return statements.stats.all() as ToolStats[];
    },
    close() {
      db.close();
    },
  };
}
```

Note: `:memory:` databases ignore WAL; that is fine for tests.

**Step 4: Run to verify it passes**

Run: `pnpm vitest run test/core/store.test.ts` — Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add src/core/store.ts test/core/store.test.ts
git commit -m "feat(core): add SQLite store with FTS5 index and file checkpoints"
```

---

### Task 9: Indexer (incremental, pruning, single-writer lock)

**Files:**
- Create: `src/core/lock.ts`, `src/core/indexer.ts`
- Test: `test/core/indexer.test.ts`

**Step 1: Write the failing test**

```ts
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createClaudeAdapter } from "../../src/adapters/claude.js";
import { createCodexAdapter } from "../../src/adapters/codex.js";
import { indexAll } from "../../src/core/indexer.js";
import { openStore, type Store } from "../../src/core/store.js";

const fixtures = join(import.meta.dirname, "../fixtures");
let dir: string;
let store: Store;
let adapters: ReturnType<typeof createAdapters>;

const createAdapters = (d: string) => [
  createClaudeAdapter(join(d, "claude")),
  createCodexAdapter(join(d, "codex")),
];
const claudeFile = () => join(dir, "claude/-work-repo-a/claude-s1.jsonl");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lore-index-"));
  cpSync(fixtures, dir, { recursive: true });
  store = openStore(":memory:");
  adapters = createAdapters(dir);
});

describe("indexAll", () => {
  it("indexes every adapter and records lastIndexedAt", async () => {
    const stats = await indexAll(store, adapters);
    expect(stats).toMatchObject({ files: 2, removed: 0, skippedLines: 2 });
    expect(stats.chunks).toBeGreaterThanOrEqual(2);
    expect(store.getMeta("lastIndexedAt")).toBeDefined();
  });

  it("skips unchanged files on the second run", async () => {
    await indexAll(store, adapters);
    expect((await indexAll(store, adapters)).files).toBe(0);
  });

  it("reads only appended lines", async () => {
    await indexAll(store, adapters);
    appendFileSync(
      claudeFile(),
      `${JSON.stringify({ type: "user", sessionId: "claude-s1", cwd: "/work/repo-a", timestamp: "2026-06-03T03:00:00Z", message: { role: "user", content: "one more question" } })}\n`,
    );
    const stats = await indexAll(store, adapters);
    expect(stats).toMatchObject({ files: 1, chunks: 1 });
  });

  it("re-reads a file from scratch when it shrinks", async () => {
    await indexAll(store, adapters);
    writeFileSync(
      claudeFile(),
      `${JSON.stringify({ type: "user", sessionId: "claude-s1", cwd: "/work/repo-a", timestamp: "2026-06-03T03:00:00Z", message: { role: "user", content: "rewritten" } })}\n`,
    );
    await indexAll(store, adapters);
    expect(store.stats().find((s) => s.tool === "claude")?.chunks).toBe(1);
  });

  it("prunes files that no longer exist", async () => {
    await indexAll(store, adapters);
    rmSync(claudeFile());
    expect((await indexAll(store, adapters)).removed).toBe(1);
    expect(store.stats().map((s) => s.tool)).toEqual(["codex"]);
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm vitest run test/core/indexer.test.ts` — Expected: FAIL (module not found)

**Step 3: Implement `src/core/lock.ts`**

```ts
import { openSync, closeSync, rmSync, statSync } from "node:fs";

const STALE_MS = 10 * 60 * 1000;

/**
 * Run `fn` while holding an exclusive lock file. Returns `undefined` without running
 * `fn` when another process holds a fresh lock. Locks older than 10 minutes are stolen.
 */
export async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (!tryAcquire(path)) return undefined;
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}

function tryAcquire(path: string): boolean {
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (Date.now() - statSync(path).mtimeMs < STALE_MS) return false;
    rmSync(path, { force: true });
    return tryAcquire(path);
  }
}
```

**Step 4: Implement `src/core/indexer.ts`**

```ts
import { stat } from "node:fs/promises";
import { chunkMessages } from "./chunk.js";
import { readLinesFrom } from "./jsonl.js";
import { redact } from "./redact.js";
import type { Store } from "./store.js";
import type { Adapter } from "./types.js";

export interface IndexStats {
  /** Files that had new content. */
  files: number;
  chunks: number;
  skippedLines: number;
  removed: number;
}

export type ProgressFn = (event: { tool: string; done: number; total: number }) => void;

export async function indexAll(
  store: Store,
  adapters: Adapter[],
  onProgress?: ProgressFn,
): Promise<IndexStats> {
  const stats: IndexStats = { files: 0, chunks: 0, skippedLines: 0, removed: 0 };

  for (const adapter of adapters) {
    const files = await adapter.discover();
    const present = new Set(files);

    for (const [i, path] of files.entries()) {
      onProgress?.({ tool: adapter.tool, done: i + 1, total: files.length });
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      const size = info.size;
      const mtimeMs = Math.trunc(info.mtimeMs);
      const previous = store.getFile(path);
      if (previous && previous.size === size && previous.mtimeMs === mtimeMs) continue;

      const reset = !previous || size < previous.size;
      const state = reset ? {} : { ...previous.state };
      const { lines, offset } = await readLinesFrom(path, reset ? 0 : previous.offset);
      const { messages, skipped } = adapter.parse(lines, path, state);
      const chunks = chunkMessages(messages.map((m) => ({ ...m, text: redact(m.text) })));

      store.saveFile({ path, tool: adapter.tool, size, mtimeMs, offset, state }, chunks, { reset });
      stats.files++;
      stats.chunks += chunks.length;
      stats.skippedLines += skipped;
    }

    for (const path of store.listPaths(adapter.tool)) {
      if (present.has(path)) continue;
      store.removeFile(path);
      stats.removed++;
    }
  }

  store.setMeta("lastIndexedAt", new Date().toISOString());
  return stats;
}
```

**Step 5: Run to verify it passes**

Run: `pnpm vitest run test/core/indexer.test.ts` — Expected: PASS (5 tests)

**Step 6: Add a lock test to `test/core/indexer.test.ts`** (append)

```ts
import { withLock } from "../../src/core/lock.js";

describe("withLock", () => {
  it("does not run while another holder has the lock", async () => {
    const lock = join(mkdtempSync(join(tmpdir(), "lore-lock-")), "index.lock");
    const inner = await withLock(lock, async () => withLock(lock, async () => "inner"));
    expect(inner).toBeUndefined();
    expect(await withLock(lock, async () => "free again")).toBe("free again");
  });
});
```

Move the new import to the top of the file with the others. Run: `pnpm vitest run test/core/indexer.test.ts` — Expected: PASS (6 tests)

**Step 7: Commit**

```bash
git add src/core/lock.ts src/core/indexer.ts test/core/indexer.test.ts
git commit -m "feat(core): incremental indexer with pruning and single-writer lock"
```

---

### Task 10: Search

**Files:**
- Create: `src/core/search.ts`
- Test: `test/core/search.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { formatHits, search, toFtsQuery } from "../../src/core/search.js";
import { openStore } from "../../src/core/store.js";
import type { Chunk } from "../../src/core/types.js";

const chunk = (over: Partial<Chunk>): Chunk => ({
  tool: "claude",
  sessionId: "s1",
  project: "/work/repo-a",
  startedAt: "2026-06-03T02:51:45Z",
  endedAt: "2026-06-03T02:52:00Z",
  text: "",
  ...over,
});

function seeded() {
  const store = openStore(":memory:");
  const file = { tool: "claude" as const, size: 1, mtimeMs: 1, offset: 1, state: {} };
  store.saveFile({ ...file, path: "/a" }, [chunk({ text: "Stripe webhook retries twice because of the idempotency check" })], { reset: false });
  store.saveFile({ ...file, path: "/b", tool: "codex" }, [chunk({ tool: "codex", project: "/work/repo-b", sessionId: "s2", text: "Warehouse import is a one-time seed" })], { reset: false });
  store.saveFile({ ...file, path: "/c" }, [chunk({ sessionId: "s3", text: "Cấu hình tiếng Việt cho webhook" })], { reset: false });
  return store;
}

describe("toFtsQuery", () => {
  it("quotes unique terms and joins them with OR", () => {
    expect(toFtsQuery('webhook "retry" webhook AND x')).toBe('"webhook" OR "retry" OR "and"');
  });

  it("returns undefined when there are no usable terms", () => {
    expect(toFtsQuery("?? !")).toBeUndefined();
  });
});

describe("search", () => {
  it("finds chunks across tools and projects", () => {
    const hits = search(seeded(), "warehouse seed");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ tool: "codex", project: "/work/repo-b", sessionId: "s2" });
    expect(hits[0]?.snippet).toContain("[Warehouse]");
  });

  it("matches Vietnamese text without diacritics", () => {
    expect(search(seeded(), "tieng viet").map((h) => h.sessionId)).toEqual(["s3"]);
  });

  it("filters by project and respects the limit", () => {
    const store = seeded();
    expect(search(store, "webhook", { project: "/work/repo-b" })).toEqual([]);
    expect(search(store, "webhook", { limit: 1 })).toHaveLength(1);
  });

  it("formats hits for agents", () => {
    const text = formatHits(search(seeded(), "warehouse"));
    expect(text).toContain("[1] codex · /work/repo-b · 2026-06-03 · session s2");
    expect(formatHits([])).toBe("No matching knowledge found.");
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm vitest run test/core/search.test.ts` — Expected: FAIL (module not found)

**Step 3: Implement**

```ts
import type { Store } from "./store.js";

export interface SearchHit {
  tool: string;
  project: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  snippet: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  project?: string;
}

/** Turn free text into a safe FTS5 query: unique word terms, quoted, OR-ed (bm25 ranks them). */
export function toFtsQuery(query: string): string | undefined {
  const terms = query.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const unique = [...new Set(terms)].filter((t) => t.length > 1);
  return unique.length ? unique.map((t) => `"${t}"`).join(" OR ") : undefined;
}

export function search(store: Store, query: string, options: SearchOptions = {}): SearchHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const limit = options.limit ?? 5;
  const projectFilter = options.project ? "AND c.project = @project" : "";
  return store.db
    .prepare(`
      SELECT c.tool, c.project, c.session_id AS sessionId, c.started_at AS startedAt,
             c.ended_at AS endedAt,
             snippet(chunks_fts, 0, '[', ']', '…', 64) AS snippet,
             bm25(chunks_fts) AS score
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH @fts ${projectFilter}
      ORDER BY score
      LIMIT @limit`)
    .all({ fts, limit, project: options.project }) as SearchHit[];
}

export function formatHits(hits: SearchHit[]): string {
  if (!hits.length) return "No matching knowledge found.";
  return hits
    .map((h, i) => {
      const date = h.startedAt.slice(0, 10);
      return `[${i + 1}] ${h.tool} · ${h.project || "(unknown project)"} · ${date} · session ${h.sessionId}\n${h.snippet}`;
    })
    .join("\n\n");
}
```

Note: better-sqlite3 rejects named parameters that are not used in the SQL. If `project` is undefined and unused this is fine; if the run errors with "Too many parameter values", build the params object conditionally.

**Step 4: Run to verify it passes**

Run: `pnpm vitest run test/core/search.test.ts` — Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add src/core/search.ts test/core/search.test.ts
git commit -m "feat(core): bm25 full-text search with Vietnamese-friendly matching"
```

---

### Task 11: Runtime wiring (home dir, default adapters, lazy freshness)

**Files:**
- Create: `src/core/runtime.ts`
- Test: `test/core/runtime.test.ts`

**Step 1: Write the failing test**

```ts
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeAdapter } from "../../src/adapters/claude.js";
import { ensureFresh, loreHome } from "../../src/core/runtime.js";
import { openStore } from "../../src/core/store.js";

describe("loreHome", () => {
  it("honours AGENTLORE_HOME", () => {
    expect(loreHome({ AGENTLORE_HOME: "/x/lore" })).toBe("/x/lore");
  });
});

describe("ensureFresh", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-rt-"));
    cpSync(join(import.meta.dirname, "../fixtures"), dir, { recursive: true });
    return { dir, store: openStore(":memory:"), adapters: [createClaudeAdapter(join(dir, "claude"))] };
  };

  it("does nothing on a never-indexed store (full backfill is explicit)", async () => {
    const { dir, store, adapters } = setup();
    expect(await ensureFresh(store, adapters, join(dir, "index.lock"))).toBe("never-indexed");
  });

  it("re-indexes when the index is stale", async () => {
    const { dir, store, adapters } = setup();
    store.setMeta("lastIndexedAt", "2000-01-01T00:00:00Z");
    expect(await ensureFresh(store, adapters, join(dir, "index.lock"))).toBe("refreshed");
    expect(store.stats()[0]?.chunks).toBeGreaterThan(0);
  });

  it("skips when the index is fresh", async () => {
    const { dir, store, adapters } = setup();
    store.setMeta("lastIndexedAt", new Date().toISOString());
    expect(await ensureFresh(store, adapters, join(dir, "index.lock"))).toBe("fresh");
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm vitest run test/core/runtime.test.ts` — Expected: FAIL (module not found)

**Step 3: Implement**

```ts
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "../adapters/claude.js";
import { createCodexAdapter } from "../adapters/codex.js";
import { indexAll } from "./indexer.js";
import { withLock } from "./lock.js";
import { openStore, type Store } from "./store.js";
import type { Adapter } from "./types.js";

export const STALE_AFTER_MS = 10 * 60 * 1000;

export function loreHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTLORE_HOME ?? join(homedir(), ".agentlore");
}

export function defaultAdapters(): Adapter[] {
  return [createClaudeAdapter(), createCodexAdapter()];
}

export function openDefault() {
  const home = loreHome();
  mkdirSync(home, { recursive: true });
  return {
    store: openStore(join(home, "index.db")),
    adapters: defaultAdapters(),
    lockPath: join(home, "index.lock"),
  };
}

export type Freshness = "never-indexed" | "fresh" | "refreshed" | "busy";

/**
 * Incrementally re-index if the index is older than STALE_AFTER_MS.
 * Never runs the first full backfill (too slow for an MCP call) — that is `lore index`.
 */
export async function ensureFresh(
  store: Store,
  adapters: Adapter[],
  lockPath: string,
): Promise<Freshness> {
  const last = store.getMeta("lastIndexedAt");
  if (!last) return "never-indexed";
  if (Date.now() - Date.parse(last) < STALE_AFTER_MS) return "fresh";
  const result = await withLock(lockPath, () => indexAll(store, adapters));
  return result ? "refreshed" : "busy";
}
```

**Step 4: Run to verify it passes**

Run: `pnpm vitest run test/core/runtime.test.ts` — Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/core/runtime.ts test/core/runtime.test.ts
git commit -m "feat(core): lazy freshness check and default runtime wiring"
```

---

### Task 12: MCP server

**Files:**
- Create: `src/version.ts`, `src/mcp/server.ts`
- Test: `test/mcp/server.test.ts`

**Step 1: Write the failing test**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/mcp/server.js";
import { openStore } from "../../src/core/store.js";

async function connect(seed: boolean) {
  const store = openStore(":memory:");
  if (seed) {
    store.setMeta("lastIndexedAt", new Date().toISOString());
    store.saveFile(
      { path: "/b", tool: "codex", size: 1, mtimeMs: 1, offset: 1, state: {} },
      [{ tool: "codex", sessionId: "s2", project: "/work/repo-b", startedAt: "2026-07-08T07:29:16Z", endedAt: "2026-07-08T07:29:20Z", text: "Warehouse import is a one-time seed" }],
      { reset: false },
    );
  }
  const server = createServer({
    store,
    adapters: [],
    lockPath: join(mkdtempSync(join(tmpdir(), "lore-mcp-")), "index.lock"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: string; text: string }[])[0]?.text ?? "";

describe("mcp server", () => {
  it("lists the search tool with gating guidance", async () => {
    const { tools } = await (await connect(true)).listTools();
    expect(tools.map((t) => t.name)).toEqual(["search"]);
    expect(tools[0]?.description).toMatch(/only when/i);
  });

  it("returns formatted hits", async () => {
    const client = await connect(true);
    const result = await client.callTool({ name: "search", arguments: { query: "warehouse" } });
    expect(textOf(result)).toContain("codex · /work/repo-b");
  });

  it("tells the agent to run `lore index` when nothing is indexed", async () => {
    const client = await connect(false);
    const result = await client.callTool({ name: "search", arguments: { query: "warehouse" } });
    expect(textOf(result)).toContain("lore index");
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm vitest run test/mcp/server.test.ts` — Expected: FAIL (module not found)

**Step 3: Implement `src/version.ts`**

```ts
import { createRequire } from "node:module";

// src/version.ts and dist/version.js are both one level below package.json.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const VERSION = pkg.version;
```

**Step 4: Implement `src/mcp/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureFresh } from "../core/runtime.js";
import { formatHits, search } from "../core/search.js";
import type { Store } from "../core/store.js";
import type { Adapter } from "../core/types.js";
import { VERSION } from "../version.js";

const DESCRIPTION = `Search knowledge from the user's past AI coding sessions across ALL projects and tools (Claude Code, Codex).
Use only when: the task involves another repo or project, you need a prior decision or fix the user made before, or you are stuck after one attempt.
Do not call it for questions answerable from the current repo. Returns up to 5 short snippets with tool, project, date and session.`;

export interface ServerDeps {
  store: Store;
  adapters: Adapter[];
  lockPath: string;
}

export function createServer({ store, adapters, lockPath }: ServerDeps): McpServer {
  const server = new McpServer({ name: "agentlore", version: VERSION });

  server.registerTool(
    "search",
    {
      title: "Search cross-project knowledge",
      description: DESCRIPTION,
      inputSchema: {
        query: z.string().min(1).describe("Keywords or a short question"),
        project: z.string().optional().describe("Absolute path to restrict results to one project"),
        limit: z.number().int().min(1).max(10).optional().describe("Max results (default 5)"),
      },
    },
    async ({ query, project, limit }) => {
      const freshness = await ensureFresh(store, adapters, lockPath);
      const text =
        freshness === "never-indexed"
          ? "The agentlore index is empty. Ask the user to run `lore index` once."
          : formatHits(search(store, query, { project, limit }));
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}
```

**Step 5: Run to verify it passes**

Run: `pnpm vitest run test/mcp/server.test.ts` — Expected: PASS (3 tests)

If the SDK's `registerTool` signature differs in the installed version, check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` and adapt; keep behaviour and tests unchanged.

**Step 6: Commit**

```bash
git add src/version.ts src/mcp/server.ts test/mcp/server.test.ts
git commit -m "feat(mcp): expose cross-project search as an MCP tool"
```

---

### Task 13: CLI

**Files:**
- Create: `src/cli/index.ts`
- Test: `test/cli/cli.test.ts`

**Step 1: Write the failing test** (runs the real CLI through `tsx`-free path: build first, then execute `dist`)

```ts
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const cli = join(root, "dist/cli/index.js");
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "ignore", shell: process.platform === "win32" });
  const dir = mkdtempSync(join(tmpdir(), "lore-cli-"));
  cpSync(join(import.meta.dirname, "../fixtures"), dir, { recursive: true });
  env = {
    ...process.env,
    AGENTLORE_HOME: join(dir, "home"),
    AGENTLORE_CLAUDE_DIR: join(dir, "claude"),
    AGENTLORE_CODEX_DIR: join(dir, "codex"),
  };
}, 60_000);

const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });

describe("lore cli", () => {
  it("indexes, reports status and searches", () => {
    expect(run("index")).toMatch(/Indexed 2 files/);
    expect(run("status")).toMatch(/claude\s+1 files\s+\d+ chunks/);
    expect(run("search", "warehouse", "seed")).toContain("codex · /work/repo-b");
  });

  it("prints the version", () => {
    expect(run("--version").trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
```

**Step 2: Make adapter roots configurable via env** — modify `defaultAdapters()` in `src/core/runtime.ts`:

```ts
export function defaultAdapters(env: NodeJS.ProcessEnv = process.env): Adapter[] {
  return [
    createClaudeAdapter(env.AGENTLORE_CLAUDE_DIR),
    createCodexAdapter(env.AGENTLORE_CODEX_DIR),
  ];
}
```

(`undefined` falls back to each adapter's default root.)

**Step 3: Run to verify it fails**

Run: `pnpm vitest run test/cli/cli.test.ts` — Expected: FAIL (build has no `dist/cli/index.js`)

**Step 4: Implement `src/cli/index.ts`**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { indexAll } from "../core/indexer.js";
import { withLock } from "../core/lock.js";
import { openDefault } from "../core/runtime.js";
import { formatHits, search } from "../core/search.js";
import { createServer } from "../mcp/server.js";
import { VERSION } from "../version.js";

const program = new Command()
  .name("lore")
  .description("Local-first knowledge librarian shared by all your AI coding agents")
  .version(VERSION);

program
  .command("index")
  .description("Index new sessions from all supported tools (first run backfills everything)")
  .action(async () => {
    const { store, adapters, lockPath } = openDefault();
    const progress = process.stderr.isTTY
      ? ({ tool, done, total }: { tool: string; done: number; total: number }) =>
          process.stderr.write(`\r${tool}: ${done}/${total} files`)
      : undefined;
    const stats = await withLock(lockPath, () => indexAll(store, adapters, progress));
    if (progress) process.stderr.write("\n");
    if (!stats) {
      console.error("Another `lore index` is running. Try again shortly.");
      process.exitCode = 1;
      return;
    }
    console.log(
      `Indexed ${stats.files} files → ${stats.chunks} chunks (skipped ${stats.skippedLines} unreadable lines, removed ${stats.removed} deleted files).`,
    );
  });

program
  .command("search")
  .description("Search knowledge across all projects and tools")
  .argument("<query...>", "keywords or a question")
  .option("-n, --limit <n>", "max results", "5")
  .option("-p, --project <path>", "restrict to one project path")
  .action((query: string[], options: { limit: string; project?: string }) => {
    const { store } = openDefault();
    const hits = search(store, query.join(" "), {
      limit: Number(options.limit),
      project: options.project,
    });
    console.log(formatHits(hits));
  });

program
  .command("status")
  .description("Show what is indexed")
  .action(() => {
    const { store } = openDefault();
    for (const s of store.stats()) console.log(`${s.tool.padEnd(8)} ${s.files} files  ${s.chunks} chunks`);
    console.log(`last indexed: ${store.getMeta("lastIndexedAt") ?? "never — run `lore index`"}`);
  });

program
  .command("mcp")
  .description("Run the MCP server over stdio (register this in Claude Code, Codex, Cursor, Gemini)")
  .action(async () => {
    await createServer(openDefault()).connect(new StdioServerTransport());
  });

await program.parseAsync();
```

**Step 5: Run to verify it passes**

Run: `pnpm vitest run test/cli/cli.test.ts` — Expected: PASS (2 tests)

**Step 6: Run the whole suite, lint and typecheck**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test` — Expected: all PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "feat(cli): add lore index, search, status and mcp commands"
```

---

### Task 14: Open-source project files and CI

**Files:**
- Create: `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/workflows/ci.yml`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/ISSUE_TEMPLATE/new_adapter.md`, `.github/pull_request_template.md`, `.changeset/config.json` (via init)

**Step 1: `README.md`** — sections, in this order:
1. One-line pitch + "Your data never leaves your machine."
2. The problem (agents in different repos/tools can't see each other's knowledge).
3. Quick start:
   ```bash
   npx agentlore index          # one-time backfill
   npx agentlore search "webhook retry"
   ```
4. Register the MCP server — exact snippets:
   - Claude Code: `claude mcp add --scope user agentlore -- npx -y agentlore mcp`
   - Codex (`~/.codex/config.toml`):
     ```toml
     [mcp_servers.agentlore]
     command = "npx"
     args = ["-y", "agentlore", "mcp"]
     ```
   - Cursor (`~/.cursor/mcp.json`) and Gemini CLI (`~/.gemini/settings.json`):
     ```json
     { "mcpServers": { "agentlore": { "command": "npx", "args": ["-y", "agentlore", "mcp"] } } }
     ```
5. How it saves tokens (tool is gated: only cross-project / prior decisions / stuck).
6. Supported sources table (Claude Code ✅, Codex ✅, Gemini/Cursor/repos/notes — planned).
7. Privacy (local SQLite at `~/.agentlore`, secret redaction, `AGENTLORE_HOME`).
8. Roadmap (link to design doc), Contributing, License (MIT).

**Step 2: `CONTRIBUTING.md`** — setup (`nvm use`, `pnpm install`), the check command (`pnpm lint && pnpm typecheck && pnpm test`), Conventional Commits, `pnpm changeset` for user-facing changes, and "Write your first adapter in 30 minutes": implement `Adapter` (`discover`, `parse`), add a sanitized fixture under `test/fixtures/<tool>/`, copy `test/adapters/codex.test.ts` as a template, register in `defaultAdapters()`. Rule: never commit real transcripts.

**Step 3: `CODE_OF_CONDUCT.md`** — adopt Contributor Covenant 2.1 by reference (link https://www.contributor-covenant.org/version/2/1/code_of_conduct/) with an enforcement contact placeholder `<maintainer email>` for the maintainer to fill.

**Step 4: `SECURITY.md`** — report privately via GitHub Security Advisories; scope includes secret leakage into the index and path handling.

**Step 5: Issue/PR templates** — bug report (OS, Node, tool versions, `lore status` output), feature request, new adapter (tool name, where it stores sessions, sample format), PR checklist (tests, changeset, no real data).

**Step 6: `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

Add `"packageManager": "pnpm@<installed version>"` to `package.json` (run `pnpm -v`) so `pnpm/action-setup` picks the version.

**Step 7: Changesets**

Run: `pnpm changeset init`
Then add a changeset: create `.changeset/initial-release.md`:
```md
---
"agentlore": minor
---

First release: index Claude Code and Codex sessions; cross-project search via CLI and MCP.
```

**Step 8: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test` — Expected: PASS

```bash
git add -A
git commit -m "docs: add README, contributing guide, policies, templates and CI"
```

---

### Task 15: Verify on real data (acceptance for v0.1)

No code. Uses the user's real `~/.claude/projects` and `~/.codex/sessions`; nothing leaves the machine.

**Step 1:** `pnpm build && AGENTLORE_HOME=$(mktemp -d) node dist/cli/index.js index` — expect a summary line; note duration and DB size.

**Step 2:** `node dist/cli/index.js status` (same `AGENTLORE_HOME`) — expect both `claude` and `codex` rows.

**Step 3: Acceptance check** — search for a topic known only from a Codex session (e.g. `warehouse import inventory seed`) and confirm a `codex` hit from a different project than the current one.

**Step 4:** Check redaction: `sqlite3 $AGENTLORE_HOME/index.db "select count(*) from chunks where text glob '*sk-ant-[A-Za-z0-9]*'"` — expect `0` (keys appear only as `[REDACTED:...]`).

**Step 5:** Ask the user before registering the MCP server in their real Claude Code / Codex configs (it changes their tool setup). With approval: register, open a session in another repo, ask a cross-project question, confirm the agent calls `search` and uses the result.

**Step 6:** Record results (timings, sizes, any adapter skips) in the PR description.
