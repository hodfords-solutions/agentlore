import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { chunkKey } from "../../src/core/chunk.js";
import { REDACTION_VERSION } from "../../src/core/redact.js";
import { SCHEMA_VERSION } from "../../src/core/schema.js";
import {
  CheckpointConflictError,
  openStore as open,
  type SourceRow,
  type Store,
} from "../../src/core/store.js";
import { chunk as makeChunk, tempDir } from "../helpers.js";

const stores: Store[] = [];

/** Open a store that is closed after the test. */
const openStore = (path: string, options?: Parameters<typeof open>[1]) => {
  const store = open(path, options);
  stores.push(store);
  return store;
};
const tmpDbPath = () => {
  return join(tempDir("lore-store-"), "index.db");
};

afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.open) store.close();
});

const chunk = (text: string) => makeChunk({ tool: "codex", project: "/p", text });

const row = (over: Partial<SourceRow> = {}): SourceRow => ({
  id: "/f.jsonl",
  tool: "codex",
  version: "10:1",
  checkpoint: { offset: 10, state: { project: "/p" } },
  ...over,
});

const chunkKeys = (store: Store) =>
  (
    store.db.prepare("SELECT chunk_key AS key FROM chunks ORDER BY id").all() as { key: string }[]
  ).map((r) => r.key);

describe("store", () => {
  it("saves source progress with chunks and reads it back", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("hello world")], { reset: false });
    expect(store.getSource("/f.jsonl")).toEqual(row());
    expect(store.stats()).toEqual([{ tool: "codex", sources: 1, chunks: 1 }]);
  });

  it("stores a null checkpoint", () => {
    const store = openStore(":memory:");
    store.saveSource(row({ checkpoint: null }), [], { reset: false });
    expect(store.getSource("/f.jsonl")?.checkpoint).toBeNull();
  });

  it("stores each chunk's kind and source", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("a")], { reset: false });
    expect(store.db.prepare("SELECT kind, source_id AS sourceId FROM chunks").get()).toEqual({
      kind: "transcript",
      sourceId: "/f.jsonl",
    });
  });

  it("keys chunks by source and text, suffixing repeats, stably across re-indexing", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("a")], { reset: false });
    store.saveSource(row(), [chunk("b"), chunk("a")], { reset: false });
    const first = chunkKeys(store);
    const a = chunkKey("/f.jsonl", "a");
    expect(first).toEqual([a, chunkKey("/f.jsonl", "b"), `${a}#1`]);
    store.saveSource(row(), [chunk("a"), chunk("b"), chunk("a")], { reset: true });
    expect(chunkKeys(store)).toEqual(first);
    store.saveSource(row({ id: "/g.jsonl" }), [chunk("a")], { reset: false });
    expect(chunkKeys(store)[3]).not.toBe(first[0]);
  });

  it("numbers repeats of a text within one save and across appends", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("a"), chunk("a"), chunk("a")], { reset: false });
    store.saveSource(row(), [chunk("a"), chunk("c"), chunk("a")], { reset: false });
    const a = chunkKey("/f.jsonl", "a");
    expect(chunkKeys(store)).toEqual([
      a,
      `${a}#1`,
      `${a}#2`,
      `${a}#3`,
      chunkKey("/f.jsonl", "c"),
      `${a}#4`,
    ]);
    store.saveSource(row(), [chunk("a"), chunk("a")], { reset: true });
    expect(chunkKeys(store)).toEqual([a, `${a}#1`]);
  });

  it("appends chunks on incremental saves and replaces them on reset", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("a")], { reset: false });
    store.saveSource(row({ version: "20:2" }), [chunk("b")], { reset: false });
    expect(store.stats()[0]?.chunks).toBe(2);
    store.saveSource(row({ version: "5:3" }), [chunk("c")], { reset: true });
    expect(store.stats()[0]?.chunks).toBe(1);
  });

  it("saves only over the checkpoint the caller read, so two writers never both append", () => {
    const store = openStore(":memory:");
    const first = row({ checkpoint: { offset: 10 } });
    store.saveSource(first, [chunk("a")], { reset: false, expectedCheckpoint: undefined });
    // A second writer that also saw no source must not append the same records again.
    expect(() =>
      store.saveSource(first, [chunk("a")], { reset: false, expectedCheckpoint: undefined }),
    ).toThrow(CheckpointConflictError);
    const next = row({ checkpoint: { offset: 20 } });
    store.saveSource(next, [chunk("b")], { reset: false, expectedCheckpoint: { offset: 10 } });
    let conflict: unknown;
    try {
      store.saveSource(row({ checkpoint: { offset: 30 } }), [chunk("c")], {
        reset: true,
        expectedCheckpoint: { offset: 10 },
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(CheckpointConflictError);
    expect(conflict).toMatchObject({ code: "CHECKPOINT_CONFLICT", sourceId: "/f.jsonl" });
    // Nothing of the refused save was written.
    expect(store.getSource("/f.jsonl")).toEqual(next);
    expect(chunkKeys(store)).toEqual([chunkKey("/f.jsonl", "a"), chunkKey("/f.jsonl", "b")]);
    // Without an expected checkpoint, saves are unconditional as before.
    store.saveSource(row(), [], { reset: false });
    expect(store.getSource("/f.jsonl")).toEqual(row());
  });

  it("refuses a checked save when the source was removed or the index reset meanwhile", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("a")], { reset: false });
    store.removeSource("/f.jsonl");
    const save = () =>
      store.saveSource(row(), [chunk("b")], {
        reset: false,
        expectedCheckpoint: row().checkpoint,
      });
    expect(save).toThrow(CheckpointConflictError);
    store.saveSource(row(), [chunk("a")], { reset: false });
    store.reset();
    expect(save).toThrow(CheckpointConflictError);
    expect(store.chunkCount()).toBe(0);
    // A stored null checkpoint is not the same as no source.
    store.saveSource(row({ checkpoint: null }), [], { reset: false });
    expect(() =>
      store.saveSource(row(), [], { reset: false, expectedCheckpoint: undefined }),
    ).toThrow(CheckpointConflictError);
    store.saveSource(row(), [], { reset: false, expectedCheckpoint: null });
    expect(store.getSource("/f.jsonl")).toEqual(row());
  });

  it("removes a source and its chunks", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("a")], { reset: false });
    store.removeSource("/f.jsonl");
    expect(store.getSource("/f.jsonl")).toBeUndefined();
    expect(store.stats()).toEqual([]);
  });

  it("keeps the full-text index in sync", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("idempotency check")], { reset: false });
    const count = () =>
      store.db
        .prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'idempotency'")
        .get() as { n: number };
    expect(count().n).toBe(1);
    store.removeSource("/f.jsonl");
    expect(count().n).toBe(0);
  });

  it("finds candidates in raw bm25 order, with a limit and an optional project filter", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("deploy once"), chunk("deploy deploy deploy")], {
      reset: false,
    });
    store.saveSource(
      row({ id: "/g.jsonl" }),
      [makeChunk({ project: "/q", sessionId: "sq", text: "deploy", sidechain: true })],
      { reset: false },
    );
    const hits = store.searchCandidates({ fts: '"deploy"', limit: 10 });
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.bm25)).toEqual([...hits.map((h) => h.bm25)].sort((a, b) => a - b));
    expect(hits[0]).toMatchObject({ kind: "transcript", sidechain: false });
    expect(hits[0]).not.toHaveProperty("snippet");
    expect(store.searchCandidates({ fts: '"deploy"', limit: 1 })).toHaveLength(1);
    expect(store.searchCandidates({ fts: '"deploy"', limit: 10, project: "/q" })).toEqual([
      expect.objectContaining({
        project: "/q",
        sessionId: "sq",
        sidechain: true,
        chunkId: chunkKey("/g.jsonl", "deploy"),
      }),
    ]);
  });

  it("leaves out a session and a project with its subfolders before limiting candidates", () => {
    const store = openStore(":memory:");
    store.saveSource(
      row({ id: "/g.jsonl" }),
      [
        makeChunk({ project: "/q", sessionId: "sq", text: "deploy deploy deploy" }),
        makeChunk({ project: "/q/sub", sessionId: "sq2", text: "deploy deploy" }),
        makeChunk({ project: "/qq", sessionId: "sq3", text: "deploy now" }),
        makeChunk({ project: "/r", sessionId: "sr", text: "deploy it later" }),
      ],
      { reset: false },
    );
    const sessions = (query: Omit<Parameters<Store["searchCandidates"]>[0], "fts" | "limit">) =>
      store.searchCandidates({ fts: '"deploy"', limit: 1, ...query }).map((c) => c.sessionId);
    expect(sessions({})).toEqual(["sq"]);
    // "/qq" is not inside "/q".
    expect(sessions({ excludeProject: "/q" })).toEqual(["sq3"]);
    expect(sessions({ excludeProject: "/q", excludeSessionId: "sq3" })).toEqual(["sr"]);
    expect(sessions({ excludeSessionId: "sq" })).toEqual(["sq2"]);
    expect(sessions({ project: "/q", excludeSessionId: "sq" })).toEqual(["sq2"]);
    expect(sessions({ project: "…/qq", excludeProject: "/q" })).toEqual(["sq3"]);
    expect(sessions({ project: "/q", excludeProject: "/q/sub", excludeSessionId: "sq" })).toEqual(
      [],
    );
  });

  it("counts matches, optionally leaving out a session and a project with its subfolders", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("deploy the api")], { reset: false });
    store.saveSource(
      row({ id: "/g.jsonl" }),
      [
        makeChunk({ project: "/q", sessionId: "sq", text: "deploy" }),
        makeChunk({ project: "/q/sub", sessionId: "sq2", text: "deploy" }),
        makeChunk({ project: "/qq", sessionId: "sq3", text: "deploy" }),
      ],
      { reset: false },
    );
    expect(store.countMatches('"deploy"')).toBe(4);
    expect(store.countMatches('"deploy"', { sessionId: "sq3" })).toBe(3);
    // "/qq" is not inside "/q".
    expect(store.countMatches('"deploy"', { project: "/q" })).toBe(2);
    expect(store.countMatches('"deploy"', { project: "/q", sessionId: "sq3" })).toBe(1);
    expect(store.countMatches('"deploy"', {})).toBe(4);
  });

  it("makes snippets and reads texts only for the given candidates", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("deploy the api"), chunk("deploy the web app")], {
      reset: false,
    });
    const [first, second] = store.searchCandidates({ fts: '"deploy"', limit: 10 });
    if (!first || !second) throw new Error("expected two candidates");
    const snippets = store.snippets('"deploy"', [first]);
    expect([...snippets.keys()]).toEqual([first.rowid]);
    expect(snippets.get(first.rowid)).toContain("[deploy]");
    expect(store.snippets('"deploy"', [{ ...second, chunkId: "changed" }])).toEqual(new Map());
    expect(store.snippets('"deploy"', [])).toEqual(new Map());
    expect(store.chunkTexts([second.rowid, 999])).toEqual(
      new Map([[second.rowid, expect.stringContaining("deploy")]]),
    );
    expect(store.chunkTexts([])).toEqual(new Map());
  });

  it("gets chunks by id in the order asked, skipping unknown ids", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("a"), chunk("b")], { reset: false });
    const [a, b] = [chunkKey("/f.jsonl", "a"), chunkKey("/f.jsonl", "b")];
    expect(store.getChunks([b, "unknown", a]).map((c) => c.text)).toEqual(["b", "a"]);
    expect(store.getChunks([a])[0]).toEqual({
      ...chunk("a"),
      chunkId: a,
      sourceId: "/f.jsonl",
    });
  });

  it("gets a chunk's neighbours from the same source in source order", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("0"), chunk("1")], { reset: false });
    store.saveSource(row({ id: "/other" }), [chunk("x")], { reset: false });
    store.saveSource(row(), [chunk("2"), chunk("3"), chunk("4")], { reset: false });
    const texts = (ordinal: number, around: number) =>
      store.getNeighbours(chunkKey("/f.jsonl", String(ordinal)), around).map((c) => c.text);
    expect(texts(2, 1)).toEqual(["1", "2", "3"]);
    expect(texts(0, 2)).toEqual(["0", "1", "2"]);
    expect(texts(4, 0)).toEqual(["4"]);
    expect(store.getNeighbours("unknown", 2)).toEqual([]);
  });

  it("finds chunk keys by prefix, telling repeats apart, at most two", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("a"), chunk("a"), chunk("b")], { reset: false });
    const a = chunkKey("/f.jsonl", "a");
    expect(store.findChunkKeys(a.slice(0, 8))).toEqual([a]);
    expect(store.findChunkKeys(a.slice(0, 8), "#1")).toEqual([`${a}#1`]);
    expect(store.findChunkKeys(a.slice(0, 8), "#2")).toEqual([]);
    expect(store.findChunkKeys("")).toHaveLength(2);
    expect(store.findChunkKeys("zz")).toEqual([]);
  });

  it("counts distinct projects", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("a"), makeChunk({ project: "/q", text: "b" })], {
      reset: false,
    });
    store.saveSource(row({ id: "/g" }), [makeChunk({ project: "", text: "c" })], { reset: false });
    expect(store.projectCount()).toBe(2);
  });

  it("opens an existing index read-only without changing it", () => {
    const path = tmpDbPath();
    expect(() => openStore(path, { readonly: true })).toThrow();
    const writer = openStore(path);
    writer.saveSource(row(), [chunk("a")], { reset: false });
    writer.close();
    const reader = openStore(path, { readonly: true });
    expect(reader.stats()).toEqual([{ tool: "codex", sources: 1, chunks: 1 }]);
    expect(() => reader.setMeta("x", "y")).toThrow(/readonly/i);
  });

  it("refuses to open an outdated index read-only instead of rebuilding it", () => {
    const path = tmpDbPath();
    const raw = new Database(path);
    raw.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    raw.close();
    expect(() => openStore(path, { readonly: true })).toThrow(/older agentlore.*lore index/);
    const check = new Database(path);
    expect(check.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION - 1);
    check.close();
  });

  it("refuses to open an index redacted by other rules read-only, leaving it as it is", () => {
    const path = tmpDbPath();
    const writer = openStore(path);
    writer.saveSource(row(), [chunk("a")], { reset: false });
    writer.setMeta("redactionVersion", String(REDACTION_VERSION - 1));
    writer.close();
    expect(() => openStore(path, { readonly: true })).toThrow(/built by an older agentlore/);
    const check = new Database(path, { readonly: true });
    expect(check.prepare("SELECT count(*) AS n FROM chunks").get()).toEqual({ n: 1 });
    check.close();
  });

  it("stores metadata", () => {
    const store = openStore(":memory:");
    expect(store.getMeta("lastIndexedAt")).toBeUndefined();
    store.setMeta("lastIndexedAt", "2026-01-01T00:00:00Z");
    expect(store.getMeta("lastIndexedAt")).toBe("2026-01-01T00:00:00Z");
  });

  it("uses WAL with synchronous NORMAL", () => {
    const store = openStore(tmpDbPath());
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(store.db.pragma("synchronous", { simple: true })).toBe(1);
  });

  it("creates new index files with incremental auto-vacuum", () => {
    const store = openStore(tmpDbPath());
    expect(store.db.pragma("auto_vacuum", { simple: true })).toBe(2);
  });

  it("switches a rebuilt index to incremental auto-vacuum", () => {
    const path = tmpDbPath();
    const raw = new Database(path);
    raw.exec("CREATE TABLE old (x); PRAGMA user_version = 1;");
    raw.close();
    const store = openStore(path);
    expect(store.db.pragma("auto_vacuum", { simple: true })).toBe(2);
  });

  it("optimizes the full-text index and returns free pages to the file system", () => {
    const store = openStore(tmpDbPath());
    const many = Array.from({ length: 300 }, (_, i) => chunk(`chunk ${i} ${"word ".repeat(200)}`));
    store.saveSource(row(), many, { reset: false });
    store.removeSource("/f.jsonl");
    expect(store.db.pragma("freelist_count", { simple: true })).toBeGreaterThan(0);
    store.optimize();
    expect(store.db.pragma("freelist_count", { simple: true })).toBe(0);
    store.saveSource(row(), [chunk("still searchable")], { reset: false });
    expect(store.searchCandidates({ fts: '"searchable"', limit: 5 })).toHaveLength(1);
  });

  it("records the schema version", () => {
    const store = openStore(":memory:");
    expect(store.db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  it("rebuilds an index created by an older schema version", () => {
    const path = tmpDbPath();
    const first = openStore(path);
    first.saveSource(row(), [chunk("idempotency check")], { reset: false });
    first.setMeta("lastIndexedAt", "2026-01-01T00:00:00Z");
    first.close();
    const raw = new Database(path);
    raw.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    raw.close();

    const store = openStore(path);
    expect(store.db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(store.getSource("/f.jsonl")).toBeUndefined();
    expect(store.getMeta("lastIndexedAt")).toBeUndefined();
    expect(store.stats()).toEqual([]);
    expect(
      store.db
        .prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'idempotency'")
        .get(),
    ).toEqual({ n: 0 });
    store.saveSource(row(), [chunk("rebuilt")], { reset: false });
    expect(store.stats()).toEqual([{ tool: "codex", sources: 1, chunks: 1 }]);
    store.close();
  });

  it("rebuilds a schema-2 index that still has the files table", () => {
    const path = tmpDbPath();
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE files (path TEXT PRIMARY KEY, tool TEXT NOT NULL);
      CREATE TABLE chunks (id INTEGER PRIMARY KEY, file TEXT NOT NULL, text TEXT NOT NULL);
      INSERT INTO files VALUES ('/old.jsonl', 'claude');
      PRAGMA user_version = 2;
    `);
    raw.close();

    const store = openStore(path);
    const tables = store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('files', 'sources')",
      )
      .all();
    expect(tables).toEqual([{ name: "sources" }]);
    store.saveSource(row(), [chunk("rebuilt")], { reset: false });
    expect(store.stats()).toEqual([{ tool: "codex", sources: 1, chunks: 1 }]);
  });

  it("refuses to open an index created by a newer schema version and keeps its data", () => {
    const path = tmpDbPath();
    const first = openStore(path);
    first.saveSource(row(), [chunk("a")], { reset: false });
    first.close();
    const raw = new Database(path);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();

    expect(() => openStore(path)).toThrow(/newer agentlore.*upgrade.*delete/s);
    const check = new Database(path);
    expect(check.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION + 1);
    expect(check.prepare("SELECT count(*) AS n FROM chunks").get()).toEqual({ n: 1 });
    check.close();
  });

  it("keeps the data of an index with the current schema version", () => {
    const path = tmpDbPath();
    const first = openStore(path);
    first.saveSource(row(), [chunk("a")], { reset: false });
    first.close();
    const store = openStore(path);
    expect(store.stats()).toEqual([{ tool: "codex", sources: 1, chunks: 1 }]);
    store.close();
  });

  it("records the redaction version", () => {
    const store = openStore(":memory:");
    expect(store.getMeta("redactionVersion")).toBe(String(REDACTION_VERSION));
  });

  it("rebuilds an index whose secrets were redacted by other rules", () => {
    const path = tmpDbPath();
    const first = openStore(path);
    first.saveSource(row(), [chunk("redacted by older rules")], { reset: false });
    first.setMeta("lastIndexedAt", "2026-01-01T00:00:00Z");
    first.setMeta("redactionVersion", String(REDACTION_VERSION - 1));
    first.close();

    const store = openStore(path);
    expect(store.getSource("/f.jsonl")).toBeUndefined();
    expect(store.getMeta("lastIndexedAt")).toBeUndefined();
    expect(store.getMeta("redactionVersion")).toBe(String(REDACTION_VERSION));
    expect(store.stats()).toEqual([]);
  });

  it("treats an index without a recorded redaction version as outdated", () => {
    const path = tmpDbPath();
    const first = openStore(path);
    first.saveSource(row(), [chunk("a")], { reset: false });
    first.db.prepare("DELETE FROM meta WHERE key = 'redactionVersion'").run();
    first.close();
    expect(openStore(path).stats()).toEqual([]);
  });

  it("drops everything on reset and stays usable", () => {
    const store = openStore(":memory:");
    store.saveSource(row(), [chunk("before reset")], { reset: false });
    store.setMeta("lastIndexedAt", "2026-01-01T00:00:00Z");
    store.reset();
    expect(store.stats()).toEqual([]);
    expect(store.getMeta("lastIndexedAt")).toBeUndefined();
    expect(store.getMeta("redactionVersion")).toBe(String(REDACTION_VERSION));
    store.saveSource(row(), [chunk("after reset")], { reset: false });
    expect(store.searchCandidates({ fts: '"after"', limit: 5 })).toHaveLength(1);
    expect(store.searchCandidates({ fts: '"before"', limit: 5 })).toHaveLength(0);
  });
});
