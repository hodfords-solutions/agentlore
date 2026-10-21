import {
  appendFileSync,
  chmodSync,
  cpSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeAdapter } from "../../src/adapters/claude.js";
import { createCodexAdapter } from "../../src/adapters/codex.js";
import { formatHits } from "../../src/core/format.js";
import {
  indexAll,
  MAX_FAILURES,
  MAX_RECORD_CHARS,
  TRUNCATED_MARKER,
} from "../../src/core/indexer.js";
import { search } from "../../src/core/search.js";
import { openStore, type Store } from "../../src/core/store.js";
import type { Adapter, ReadBatch, SourceRecord } from "../../src/core/types.js";
import { hostPath, tempDir } from "../helpers.js";

const fixtures = join(import.meta.dirname, "../fixtures");
const canRevokeAccess = process.platform !== "win32" && process.getuid?.() !== 0;
let dir: string;
let store: Store;
let adapters: ReturnType<typeof createAdapters>;

const createAdapters = (d: string) => [
  createClaudeAdapter(join(d, "claude")),
  createCodexAdapter(join(d, "codex")),
];
const claudeFile = () => join(dir, "claude/-work-repo-a/claude-s1.jsonl");
const claudeOffset = () =>
  (store.getSource(claudeFile())?.checkpoint as { offset: number } | undefined)?.offset;
const claudeTexts = () =>
  (
    store.db.prepare("SELECT text FROM chunks WHERE tool = 'claude' ORDER BY id").all() as {
      text: string;
    }[]
  ).map((r) => r.text);

/** All chunk texts joined in order. */
const allText = () =>
  (store.db.prepare("SELECT text FROM chunks ORDER BY id").all() as { text: string }[])
    .map((r) => r.text)
    .join("");

/** Run `beforeBatch(n)` before the n-th batch (from 1) of `adapter` reaches the indexer. */
const tapBatches = (adapter: Adapter, beforeBatch: (n: number) => void): Adapter => ({
  ...adapter,
  async *read(source, checkpoint, options) {
    let n = 0;
    for await (const batch of adapter.read(source, checkpoint, options)) {
      beforeBatch(++n);
      yield batch;
    }
  },
});

/** An in-memory adapter with one source yielding `batches`. */
const memoryAdapter = (batches: ReadBatch[], version = "1"): Adapter => ({
  tool: "memory",
  discover: async () => ({ sources: [{ id: "memory:1", version }], complete: true }),
  async *read() {
    yield* batches;
  },
});

const message = (text: string): SourceRecord => ({
  kind: "transcript",
  tool: "memory",
  sessionId: "m1",
  project: "/p",
  timestamp: "2026-01-01T00:00:00Z",
  role: "user",
  text,
});

beforeEach(() => {
  dir = tempDir("lore-index-");
  cpSync(fixtures, dir, { recursive: true });
  store = openStore(":memory:");
  adapters = createAdapters(dir);
});

afterEach(() => {
  store.close();
});

describe("indexAll", () => {
  it("indexes every adapter and records lastIndexedAt", async () => {
    const stats = await indexAll(store, adapters);
    expect(stats).toMatchObject({ sources: 2, archived: 0, skipped: 2, complete: true });
    expect(stats.chunks).toBeGreaterThanOrEqual(2);
    expect(Date.parse(store.getMeta("lastIndexedAt") ?? "")).not.toBeNaN();
  });

  it("skips unchanged files on the second run", async () => {
    await indexAll(store, adapters);
    expect((await indexAll(store, adapters)).sources).toBe(0);
  });

  it("reads only appended lines", async () => {
    await indexAll(store, adapters);
    appendFileSync(
      claudeFile(),
      `${JSON.stringify({ type: "user", sessionId: "claude-s1", cwd: "/work/repo-a", timestamp: "2026-06-03T03:00:00Z", message: { role: "user", content: "one more question" } })}\n`,
    );
    const stats = await indexAll(store, adapters);
    expect(stats).toMatchObject({ sources: 1, chunks: 1 });
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

  it("re-reads a file from scratch when it is rewritten to a larger size", async () => {
    await indexAll(store, adapters);
    const before = statSync(claudeFile()).size;
    const text = `rewritten ${"x".repeat(before)}`;
    writeFileSync(
      claudeFile(),
      `${JSON.stringify({ type: "user", sessionId: "claude-s1", cwd: "/work/repo-a", timestamp: "2026-06-03T03:00:00Z", message: { role: "user", content: text } })}\n`,
    );
    expect(statSync(claudeFile()).size).toBeGreaterThan(before);
    await indexAll(store, adapters);
    expect(claudeTexts()).toEqual([`user: ${text}`]);
  });

  it("keeps what a deleted transcript said, also across rebuilds", async () => {
    await indexAll(store, adapters);
    const texts = claudeTexts();
    expect(texts.length).toBeGreaterThan(0);
    rmSync(claudeFile());
    expect((await indexAll(store, adapters)).archived).toBe(1);
    expect(claudeTexts()).toEqual(texts);
    expect(store.archivedSessionCount()).toBe(1);
    // Archived once: later runs leave it alone.
    expect((await indexAll(store, adapters)).archived).toBe(0);
    store.reset();
    await indexAll(store, adapters);
    expect(claudeTexts()).toEqual(texts);
    expect(store.stats().map((s) => s.tool)).toEqual(["claude", "codex"]);
  });

  it("reads a transcript that exists again in full, replacing its archived chunks", async () => {
    await indexAll(store, adapters);
    const texts = claudeTexts();
    const content = readFileSync(claudeFile());
    rmSync(claudeFile());
    await indexAll(store, adapters);
    store.reset();
    writeFileSync(claudeFile(), content);
    await indexAll(store, adapters);
    expect(claudeTexts()).toEqual(texts);
    expect(store.archivedSessionCount()).toBe(0);
    store.reset();
    await indexAll(store, adapters);
    expect(claudeTexts()).toEqual(texts);
  });

  it("forgets an archived session, but not one whose transcript still exists", async () => {
    await indexAll(store, adapters);
    expect(store.forgetSession("claude-s1")).toBe(0);
    rmSync(claudeFile());
    await indexAll(store, adapters);
    expect(store.forgetSession("claude-s1")).toBe(1);
    expect(claudeTexts()).toEqual([]);
    store.reset();
    await indexAll(store, adapters);
    expect(claudeTexts()).toEqual([]);
    expect(store.archivedSessionCount()).toBe(0);
  });

  it.skipIf(!canRevokeAccess)(
    "counts an unreadable file as an error and indexes the rest",
    async () => {
      chmodSync(claudeFile(), 0o000);
      const stats = await indexAll(store, adapters);
      expect(stats).toMatchObject({ sources: 1, errors: 1 });
      expect(store.stats().map((s) => s.tool)).toEqual(["codex"]);
      expect(Date.parse(store.getMeta("lastIndexedAt") ?? "")).not.toBeNaN();
    },
  );

  it("indexes a file larger than one batch and checkpoints after each batch", async () => {
    const [claude, codex] = adapters;
    if (!claude || !codex) throw new Error("missing adapters");
    const seen: (number | undefined)[] = [];
    const watched = tapBatches(claude, () => seen.push(claudeOffset()));
    const stats = await indexAll(store, [watched, codex], { batchSize: 2 });
    expect(stats).toMatchObject({ sources: 2, skipped: 2, errors: 0 });
    // 7 lines in batches of 2 → 4 batches; before each one the previous batch is saved.
    expect(seen).toHaveLength(4);
    expect(seen[0]).toBeUndefined();
    const checkpoints = seen.slice(1) as number[];
    expect(checkpoints).toEqual([...checkpoints].sort((a, b) => a - b));
    expect(new Set(checkpoints).size).toBe(3);
    expect(claudeOffset()).toBe(statSync(claudeFile()).size);
    expect(claudeTexts().join("\n")).toContain("Why does the payment webhook retry twice?");
    expect(claudeTexts().join("\n")).toContain("Thanks, move the idempotency check first.");
  });

  it("resumes an interrupted file from its last checkpoint without duplicates", async () => {
    const [claude, codex] = adapters;
    if (!claude || !codex) throw new Error("missing adapters");
    const crashing = tapBatches(claude, (n) => {
      if (n === 3) throw new Error("boom");
    });
    const failed = await indexAll(store, [crashing, codex], { batchSize: 2 });
    expect(failed).toMatchObject({
      errors: 1,
      failures: [{ source: claudeFile(), message: "boom" }],
    });
    await indexAll(store, adapters, { batchSize: 2 });
    expect(claudeTexts()).toEqual([
      "user: Why does the payment webhook retry twice?",
      "assistant: Stripe retries because the handler returns 500 before the idempotency check.",
      "user: Thanks, move the idempotency check first.",
    ]);
    expect((await indexAll(store, adapters)).sources).toBe(0);
  });

  it("stops at the deadline after a batch and resumes on the next run", async () => {
    const [claude, codex] = adapters;
    if (!claude || !codex) throw new Error("missing adapters");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const slow = tapBatches(claude, () => vi.setSystemTime(Date.now() + 10_000));
      const stats = await indexAll(store, [slow, codex], {
        batchSize: 2,
        deadline: Date.now() + 1000,
      });
      expect(stats).toMatchObject({ complete: false, sources: 1, errors: 0 });
      expect(store.getMeta("lastIndexedAt")).toBeUndefined();
      expect(claudeOffset()).toBeLessThan(statSync(claudeFile()).size);
      expect(store.stats().map((s) => s.tool)).toEqual(["claude"]);
    } finally {
      vi.useRealTimers();
    }
    expect(await indexAll(store, adapters, { batchSize: 2 })).toMatchObject({
      complete: true,
      sources: 2,
    });
    expect(Date.parse(store.getMeta("lastIndexedAt") ?? "")).not.toBeNaN();
    expect(claudeTexts()).toEqual([
      "user: Why does the payment webhook retry twice?",
      "assistant: Stripe retries because the handler returns 500 before the idempotency check.",
      "user: Thanks, move the idempotency check first.",
    ]);
  });

  it("does not start files or prune once the deadline has passed", async () => {
    await indexAll(store, adapters);
    const last = store.getMeta("lastIndexedAt");
    rmSync(claudeFile());
    const stats = await indexAll(store, adapters, { deadline: Date.now() - 1 });
    expect(stats).toMatchObject({ complete: false, sources: 0, archived: 0 });
    expect(store.getMeta("lastIndexedAt")).toBe(last);
  });

  it("does not list sources once the deadline has passed", async () => {
    const discover = vi.fn(async () => ({ sources: [], complete: true }));
    const adapter: Adapter = { tool: "memory", discover, async *read() {} };
    const stats = await indexAll(store, [adapter], { deadline: Date.now() - 1 });
    expect(stats.complete).toBe(false);
    expect(discover).not.toHaveBeenCalled();
  });

  it("stops the run when the heartbeat fails, e.g. after losing the index lock", async () => {
    const heartbeat = () => {
      throw new Error("lost the index lock");
    };
    await expect(indexAll(store, adapters, { heartbeat })).rejects.toThrow(/lost the index lock/);
    expect(store.getMeta("lastIndexedAt")).toBeUndefined();
  });

  it("optimizes the index after a run that reset sources, when asked", async () => {
    const optimized = vi.fn();
    const watched = { ...store, optimize: optimized };
    await indexAll(watched, adapters, { maintain: true });
    expect(optimized).not.toHaveBeenCalled();
    // Archiving a deleted transcript deletes nothing.
    rmSync(join(dir, "codex"), { recursive: true });
    await indexAll(watched, adapters, { maintain: true });
    expect(optimized).not.toHaveBeenCalled();
    writeFileSync(claudeFile(), "");
    await indexAll(watched, adapters, { maintain: true });
    expect(optimized).toHaveBeenCalledTimes(1);
  });

  it("counts sources whose earlier chunks were discarded", async () => {
    await indexAll(store, adapters);
    writeFileSync(claudeFile(), "");
    expect((await indexAll(store, adapters)).resets).toBe(1);
  });

  it("reports the tools whose source folder does not exist", async () => {
    rmSync(join(dir, "codex"), { recursive: true });
    const stats = await indexAll(store, adapters);
    expect(stats.missing).toEqual([{ tool: "codex", root: join(dir, "codex") }]);
    expect(stats.errors).toBe(0);
  });

  it("sends heartbeats while indexing", async () => {
    let beats = 0;
    await indexAll(store, adapters, { heartbeat: () => beats++ });
    expect(beats).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(!canRevokeAccess)(
    "does not prune files under an unreadable directory but indexes the rest",
    async () => {
      await indexAll(store, adapters);
      const locked = join(dir, "claude/-work-repo-a");
      chmodSync(locked, 0o000);
      try {
        const stats = await indexAll(store, adapters);
        expect(stats).toMatchObject({ errors: 1, archived: 0 });
        expect(store.getSource(claudeFile())).toMatchObject({ id: claudeFile(), tool: "claude" });
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  it("counts a failed discovery as an error and keeps that tool's rows", async () => {
    await indexAll(store, adapters);
    rmSync(join(dir, "claude"), { recursive: true });
    writeFileSync(join(dir, "claude"), "not a directory");
    const stats = await indexAll(store, adapters);
    expect(stats).toMatchObject({ errors: 1, archived: 0 });
    expect(store.stats().map((s) => s.tool)).toEqual(["claude", "codex"]);
  });

  it("gives equal chunk texts the same keys whether indexed in one run or two", async () => {
    const file = join(dir, "claude/-work-repo-a/keys.jsonl");
    const line = (sessionId: string, content: string) =>
      `${JSON.stringify({ type: "user", sessionId, cwd: "/w", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content } })}\n`;
    const claude = createClaudeAdapter(join(dir, "claude"));
    const keysByText = (target: Store) =>
      new Map(
        (
          target.db
            .prepare("SELECT text, chunk_key AS key FROM chunks WHERE source_id = ?")
            .all(file) as { text: string; key: string }[]
        ).map((r) => [r.text, r.key]),
      );

    writeFileSync(file, line("s1", "alpha") + line("s2", "beta"));
    await indexAll(store, [claude]);
    appendFileSync(file, line("s1", "gamma") + line("s2", "beta"));
    await indexAll(store, [claude]);

    const oneRun = openStore(":memory:");
    try {
      await indexAll(oneRun, [claude]);
      const [twoRuns, single] = [keysByText(store), keysByText(oneRun)];
      expect([...single.keys()].sort()).toEqual(["user: alpha", "user: beta", "user: gamma"]);
      for (const [text, key] of single) expect(twoRuns.get(text)).toBe(key);
      expect(
        store.db.prepare("SELECT count(*) AS n FROM chunks WHERE source_id = ?").get(file),
      ).toEqual({ n: 4 });
    } finally {
      oneRun.close();
    }
  });

  it("indexes documents from a notes adapter as searchable note chunks", async () => {
    const note: SourceRecord = {
      kind: "note",
      tool: "notes",
      title: "Deploy runbook",
      project: "/notes",
      timestamp: "2026-05-01T00:00:00Z",
      text: "# Deploy\n\nAlways use blue-green deploys for the billing service.",
    };
    const notes: Adapter = {
      tool: "notes",
      discover: async () => ({
        sources: [{ id: "/notes/deploy.md", version: "1" }],
        complete: true,
      }),
      async *read() {
        yield { records: [note], checkpoint: null, reset: true, skipped: 0 };
      },
    };
    await indexAll(store, [notes]);
    const hits = search(store, "blue-green billing");
    expect(hits).toEqual([
      expect.objectContaining({ kind: "note", tool: "notes", sessionId: "Deploy runbook" }),
    ]);
    expect(formatHits(hits)).toContain(
      `notes ${hostPath("/notes")} 2026-05-01 note Deploy runbook`,
    );
  });

  it("stops a source, without duplicates or an error, when another process saves it meanwhile", async () => {
    const batch = (n: number): ReadBatch => ({
      records: [message(`line ${n}`)],
      checkpoint: n,
      reset: false,
      skipped: 0,
    });
    const adapter = tapBatches(memoryAdapter([batch(1), batch(2)]), (n) => {
      // Another indexer got further between our two batches.
      if (n === 2) {
        store.saveSource({ id: "memory:1", tool: "memory", version: "0", checkpoint: 2 }, [], {
          reset: false,
        });
      }
    });
    const stats = await indexAll(store, [adapter]);
    expect(stats.errors).toBe(0);
    expect(store.getSource("memory:1")?.checkpoint).toBe(2);
    // Line 2 is the other process's to save: this run must not append it after the fact.
    expect(allText()).toContain("line 1");
    expect(allText()).not.toContain("line 2");
  });

  it("stores projects normalized, so the project filter matches them", async () => {
    const adapter = memoryAdapter([
      {
        records: [{ ...message("percent path"), project: "/work/my%20repo/" }],
        checkpoint: 1,
        reset: false,
        skipped: 0,
      },
    ]);
    await indexAll(store, [adapter]);
    expect(store.db.prepare("SELECT project FROM chunks").all()).toEqual([
      { project: hostPath("/work/my repo") },
    ]);
    expect(search(store, "percent", { project: "/work/my%20repo" })).toHaveLength(1);
  });

  it("redacts the records of any adapter before storing them", async () => {
    const secret = `sk-ant-api03-${"A1b2C3d4".repeat(5)}`;
    const adapter = memoryAdapter([
      { records: [message(`my key is ${secret}`)], checkpoint: 1, reset: false, skipped: 0 },
    ]);
    await indexAll(store, [adapter]);
    const texts = store.db.prepare("SELECT text FROM chunks").all();
    expect(texts).toEqual([{ text: "user: my key is [REDACTED:anthropic-key]" }]);
  });

  it("truncates a record over 1 MB with a marker before redacting it", async () => {
    const huge = `${"x".repeat(MAX_RECORD_CHARS)}${"-----BEGIN"} RSA PRIVATE KEY-----\nabc`;
    const adapter = memoryAdapter([
      { records: [message(huge)], checkpoint: 1, reset: false, skipped: 0 },
    ]);
    await indexAll(store, [adapter]);
    const text = allText();
    // Chunking adds a "user: " prefix per chunk.
    expect(text.length).toBeLessThan(MAX_RECORD_CHARS * 1.01);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text.endsWith(TRUNCATED_MARKER)).toBe(true);
  });

  it("indexes a non-file source and skips it while its version is unchanged", async () => {
    let reads = 0;
    const batches = [
      { records: [message("hello")], checkpoint: { row: 7 }, reset: false, skipped: 0 },
    ];
    const adapter: Adapter = {
      ...memoryAdapter(batches),
      async *read() {
        reads++;
        yield* batches;
      },
    };
    expect(await indexAll(store, [adapter])).toMatchObject({ sources: 1, chunks: 1 });
    expect(store.getSource("memory:1")).toEqual({
      id: "memory:1",
      tool: "memory",
      version: "1",
      checkpoint: { row: 7 },
    });
    expect(await indexAll(store, [adapter])).toMatchObject({ sources: 0, chunks: 0 });
    expect(reads).toBe(1);
  });

  it("hands the stored checkpoint back to the adapter when the version changes", async () => {
    const received: unknown[] = [];
    const adapter = (version: string): Adapter => ({
      ...memoryAdapter([], version),
      async *read(_source, checkpoint) {
        received.push(checkpoint);
        yield {
          records: [message(version)],
          checkpoint: { upTo: version },
          reset: false,
          skipped: 0,
        };
      },
    });
    await indexAll(store, [adapter("1")]);
    await indexAll(store, [adapter("2")]);
    expect(received).toEqual([undefined, { upTo: "1" }]);
    expect(store.stats()).toEqual([{ tool: "memory", sources: 1, chunks: 2 }]);
  });

  it("drops a source's earlier chunks when a batch asks for a reset", async () => {
    await indexAll(store, [
      memoryAdapter([{ records: [message("old")], checkpoint: 1, reset: false, skipped: 0 }], "1"),
    ]);
    await indexAll(store, [
      memoryAdapter([{ records: [message("new")], checkpoint: 1, reset: true, skipped: 0 }], "2"),
    ]);
    expect(store.db.prepare("SELECT text FROM chunks").all()).toEqual([{ text: "user: new" }]);
  });

  it("records the new version when the adapter yields no batch", async () => {
    await indexAll(store, [memoryAdapter([], "7")]);
    expect(store.getSource("memory:1")).toMatchObject({ version: "7", checkpoint: null });
  });

  it("records which sources failed, up to MAX_FAILURES", async () => {
    const count = MAX_FAILURES + 5;
    const failing: Adapter = {
      tool: "memory",
      discover: async () => ({
        sources: Array.from({ length: count }, (_, i) => ({ id: `memory:${i}`, version: "1" })),
        complete: true,
      }),
      read: () => {
        throw new Error("unreadable");
      },
    };
    const stats = await indexAll(store, [failing]);
    expect(stats.errors).toBe(count);
    expect(stats.failures).toHaveLength(MAX_FAILURES);
    expect(stats.failures[0]).toEqual({ source: "memory:0", message: "unreadable" });
  });

  it("records a failed discovery under the tool name", async () => {
    const broken: Adapter = {
      ...memoryAdapter([]),
      discover: async () => {
        throw new Error("no such folder");
      },
    };
    expect((await indexAll(store, [broken])).failures).toEqual([
      { source: "memory", message: "no such folder" },
    ]);
  });
});
