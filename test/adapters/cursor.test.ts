import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCursorAdapter,
  cursorUserDir,
  openCursorDb,
  uriPath,
} from "../../src/adapters/cursor.js";
import { indexAll } from "../../src/core/indexer.js";
import { openStore } from "../../src/core/store.js";
import type { Checkpoint, ReadBatch, SourceRecord } from "../../src/core/types.js";
import { CursorFixture } from "../cursor-fixture.js";
import { hostPath, tempDir } from "../helpers.js";

const repoA = hostPath("/work/repo-a");
const repoC = hostPath("/work/repo-c");

/** A Lexical editor state holding two paragraphs. */
const richText = JSON.stringify({
  root: {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Only in " },
          { type: "text", text: "rich text" },
        ],
      },
      { type: "paragraph", children: [{ type: "mention", text: "@file" }] },
    ],
  },
});

/**
 * c1: a mapped conversation with every kind of bubble; c2: mapped through a `.code-workspace`;
 * c3: unmapped; draft: no messages; v14: opaque state only; broken: invalid JSON.
 */
function cursorUser(): { userDir: string; fixture: CursorFixture } {
  const userDir = join(tempDir("lore-cursor-"), "User");
  const fixture = new CursorFixture(userDir)
    .composer("c1", [
      ["b1", 1],
      ["b2", 2],
      ["b3", 2],
      ["b4", 1],
      ["b5", 2],
      ["b6", 2],
      ["b7", 1],
    ])
    .bubble("c1", "b1", {
      type: 1,
      text: "How do I seed the warehouse?",
      createdAt: "2026-03-01T09:01:00.000Z",
    })
    // A tool step: no text of its own, a large tool call payload.
    .bubble("c1", "b2", {
      type: 2,
      text: "",
      createdAt: "2026-03-01T09:02:00.000Z",
      toolFormerData: { name: "read_file", result: "x".repeat(200_000) },
    })
    .bubble("c1", "b3", {
      type: 2,
      text: "Run the seed endpoint once.",
      createdAt: "2026-03-01T09:03:00.000Z",
      thinking: { text: "private reasoning" },
    })
    .bubble("c1", "b4", { type: 1, text: "", richText, createdAt: "2026-03-01T09:04:00.000Z" })
    // b5 is missing (an orphan header).
    .raw("bubbleId:c1:b6", "{not json")
    .bubble("c1", "b7", { type: 1, text: "Thanks" })
    .composer("c2", [["x1", 1]], { name: "Workspace chat" })
    .bubble("c2", "x1", { type: 1, text: "multi-root question", createdAt: "2026-03-02T00:00:00Z" })
    .composer("c3", [["y1", 2]])
    .bubble("c3", "y1", { type: 2, text: "unmapped answer", createdAt: "2026-03-03T00:00:00Z" })
    .composer("draft", [])
    .composer("v14", [], { _v: 14, conversationState: "~opaque" })
    .raw("composerData:broken", "{oops")
    .workspace("hash-a", ["c1", "other"], { folder: repoA })
    .workspace("hash-c", ["c2"], { workspace: join(repoC, "repo-c.code-workspace") })
    .workspace("hash-none", ["c3"]);
  return { userDir, fixture };
}

async function readAll(
  adapter: ReturnType<typeof createCursorAdapter>,
  id: string,
  checkpoint?: Checkpoint,
  batchSize?: number,
): Promise<ReadBatch[]> {
  const batches: ReadBatch[] = [];
  for await (const batch of adapter.read({ id, version: "v" }, checkpoint, { batchSize })) {
    batches.push(batch);
  }
  return batches;
}

const records = (batches: ReadBatch[]): SourceRecord[] => batches.flatMap((b) => b.records);

describe("cursor adapter", () => {
  it("discovers one source per conversation that has messages, or cannot be read", async () => {
    const { userDir, fixture } = cursorUser();
    fixture.close();
    const { sources, complete } = await createCursorAdapter(userDir).discover();
    expect(complete).toBe(true);
    // Last updated months ago: settled.
    expect(sources).toEqual([
      { id: "cursor:broken", version: "malformed" },
      { id: "cursor:c1", version: `${Date.parse("2026-03-01T09:30:00Z") + 7}:7:settled` },
      { id: "cursor:c2", version: `${Date.parse("2026-03-01T09:30:00Z") + 1}:1:settled` },
      { id: "cursor:c3", version: `${Date.parse("2026-03-01T09:30:00Z") + 1}:1:settled` },
    ]);
  });

  it("reads the user's and assistant's messages in conversation order", async () => {
    const { userDir, fixture } = cursorUser();
    fixture.close();
    const batches = await readAll(createCursorAdapter(userDir), "cursor:c1");
    expect(batches[0]?.reset).toBe(true);
    expect(batches.reduce((n, b) => n + b.skipped, 0)).toBe(1);
    expect(records(batches)).toEqual([
      {
        kind: "transcript",
        tool: "cursor",
        sessionId: "c1",
        title: "Chat c1",
        project: repoA,
        role: "user",
        timestamp: "2026-03-01T09:01:00.000Z",
        text: "How do I seed the warehouse?",
      },
      expect.objectContaining({ role: "assistant", text: "Run the seed endpoint once." }),
      expect.objectContaining({ role: "user", text: "Only in rich text\n@file" }),
      // No createdAt: the conversation's creation time.
      expect.objectContaining({
        role: "user",
        text: "Thanks",
        timestamp: "2026-03-01T09:00:00.000Z",
      }),
    ]);
    expect(JSON.stringify(batches)).not.toContain("private reasoning");
  });

  it("maps conversations to the folder of a .code-workspace file, or to no project", async () => {
    const { userDir, fixture } = cursorUser();
    fixture.close();
    const adapter = createCursorAdapter(userDir);
    await adapter.discover();
    expect(records(await readAll(adapter, "cursor:c2"))).toEqual([
      expect.objectContaining({
        title: "Workspace chat",
        project: repoC,
        text: "multi-root question",
      }),
    ]);
    expect(records(await readAll(adapter, "cursor:c3"))).toEqual([
      expect.objectContaining({ project: "", role: "assistant", text: "unmapped answer" }),
    ]);
  });

  it("reads only messages appended since the checkpoint", async () => {
    const { userDir, fixture } = cursorUser();
    const adapter = createCursorAdapter(userDir);
    const first = await readAll(adapter, "cursor:c2");
    const checkpoint = first.at(-1)?.checkpoint;
    fixture
      .composer(
        "c2",
        [
          ["x1", 1],
          ["x2", 2],
        ],
        { name: "Workspace chat" },
      )
      .bubble("c2", "x2", { type: 2, text: "appended answer", createdAt: "2026-03-02T00:01:00Z" })
      .close();
    const next = await readAll(adapter, "cursor:c2", checkpoint);
    expect(next.map((b) => b.reset)).toEqual([false]);
    expect(records(next).map((r) => r.text)).toEqual(["appended answer"]);

    // Nothing new: one empty batch that keeps the checkpoint.
    const again = await readAll(adapter, "cursor:c2", next.at(-1)?.checkpoint);
    expect(again).toEqual([
      { records: [], checkpoint: next.at(-1)?.checkpoint, reset: false, skipped: 0 },
    ]);
  });

  it("re-reads a conversation whose messages shrank or changed", async () => {
    const { userDir, fixture } = cursorUser();
    const adapter = createCursorAdapter(userDir);
    const checkpoint = (await readAll(adapter, "cursor:c1")).at(-1)?.checkpoint;
    fixture.composer("c1", [["b1", 1]]);
    const shrunk = await readAll(adapter, "cursor:c1", checkpoint);
    expect(shrunk[0]?.reset).toBe(true);
    expect(records(shrunk).map((r) => r.text)).toEqual(["How do I seed the warehouse?"]);

    fixture.composer("c1", [
      ["b3", 2],
      ["b1", 1],
    ]);
    const changed = await readAll(adapter, "cursor:c1", shrunk.at(-1)?.checkpoint);
    expect(changed[0]?.reset).toBe(true);
    expect(records(changed).map((r) => r.text)).toEqual([
      "Run the seed endpoint once.",
      "How do I seed the warehouse?",
    ]);
    fixture.close();
  });

  it("re-reads everything when the checkpoint is not one it wrote", async () => {
    const { userDir, fixture } = cursorUser();
    fixture.close();
    const batches = await readAll(createCursorAdapter(userDir), "cursor:c3", { offset: 3 });
    expect(batches[0]?.reset).toBe(true);
    expect(records(batches)).toHaveLength(1);
  });

  it("reads in batches of at most batchSize messages, each with its checkpoint", async () => {
    const { userDir, fixture } = cursorUser();
    fixture.close();
    const adapter = createCursorAdapter(userDir);
    const batches = await readAll(adapter, "cursor:c1", undefined, 3);
    expect(batches.map((b) => b.reset)).toEqual([true, false, false]);
    expect(batches.map((b) => b.records.length)).toEqual([2, 1, 1]);
    // Resuming from the middle reads the rest only.
    const rest = await readAll(adapter, "cursor:c1", batches[0]?.checkpoint);
    expect(records(rest).map((r) => r.text)).toEqual(["Only in rich text\n@file", "Thanks"]);
  });

  it("clears a conversation that was deleted", async () => {
    const { userDir, fixture } = cursorUser();
    fixture.delete("composerData:c3").close();
    expect(await readAll(createCursorAdapter(userDir), "cursor:c3")).toEqual([
      { records: [], checkpoint: null, reset: true, skipped: 0 },
    ]);
  });

  it("keeps what was indexed from a conversation that became unreadable", async () => {
    const { userDir, fixture } = cursorUser();
    const adapter = createCursorAdapter(userDir);
    const checkpoint = (await readAll(adapter, "cursor:c3")).at(-1)?.checkpoint;
    fixture.raw("composerData:c3", "{oops").close();
    expect(await readAll(adapter, "cursor:c3", checkpoint)).toEqual([
      { records: [], checkpoint, reset: false, skipped: 1 },
    ]);
    expect(await readAll(adapter, "cursor:broken")).toEqual([
      { records: [], checkpoint: null, reset: false, skipped: 1 },
    ]);
  });

  it("re-reads a conversation whose last message changed, e.g. while it was streamed", async () => {
    const { userDir, fixture } = cursorUser();
    fixture
      .composer("live", [
        ["u1", 1],
        ["a1", 2],
      ])
      .bubble("live", "u1", { type: 1, text: "question" })
      .bubble("live", "a1", { type: 2, text: "" });
    const adapter = createCursorAdapter(userDir);
    const first = await readAll(adapter, "cursor:live");
    expect(records(first).map((r) => r.text)).toEqual(["question"]);

    fixture.bubble("live", "a1", { type: 2, text: "Partial ans" });
    const second = await readAll(adapter, "cursor:live", first.at(-1)?.checkpoint);
    expect(second[0]?.reset).toBe(true);
    expect(records(second).map((r) => r.text)).toEqual(["question", "Partial ans"]);

    fixture.bubble("live", "a1", { type: 2, text: "Partial answer, now complete." });
    const third = await readAll(adapter, "cursor:live", second.at(-1)?.checkpoint);
    expect(third[0]?.reset).toBe(true);
    expect(records(third).map((r) => r.text)).toEqual([
      "question",
      "Partial answer, now complete.",
    ]);

    // Unchanged: nothing is read again.
    const fourth = await readAll(adapter, "cursor:live", third.at(-1)?.checkpoint);
    expect(fourth).toEqual([
      { records: [], checkpoint: third.at(-1)?.checkpoint, reset: false, skipped: 0 },
    ]);
    fixture.close();
  });

  it("waits for a recent message stored after its header", async () => {
    const { userDir, fixture } = cursorUser();
    fixture
      .composer(
        "recent",
        [
          ["m1", 1],
          ["m2", 2],
          ["m3", 1],
        ],
        { lastUpdatedAt: Date.now() },
      )
      .bubble("recent", "m1", { type: 1, text: "first" })
      .bubble("recent", "m3", { type: 1, text: "third" });
    const adapter = createCursorAdapter(userDir);
    const first = await readAll(adapter, "cursor:recent");
    expect(records(first).map((r) => r.text)).toEqual(["first"]);

    fixture.bubble("recent", "m2", { type: 2, text: "second" }).close();
    const next = await readAll(adapter, "cursor:recent", first.at(-1)?.checkpoint);
    expect(next[0]?.reset).toBe(false);
    expect(records(next).map((r) => r.text)).toEqual(["second", "third"]);
  });

  describe("through indexAll", () => {
    const HOUR = 60 * 60 * 1000;
    let home: string;
    let store: ReturnType<typeof openStore>;
    beforeEach(() => {
      home = tempDir("lore-cursor-");
      store = openStore(join(home, "index.db"));
    });
    afterEach(() => store.close());

    /** Messages indexed from a conversation, in order, as "role: text". */
    const indexed = (composerId: string): string[] => {
      const db = new Database(join(home, "index.db"), { readonly: true });
      try {
        return (
          db
            .prepare("SELECT text FROM chunks WHERE session_id = ? ORDER BY rowid")
            .pluck()
            .all(composerId) as string[]
        ).flatMap((text) => text.split("\n\n"));
      } finally {
        db.close();
      }
    };

    /** A recent conversation whose second message's header was stored before the message. */
    function withGap(updatedAt: number) {
      const { userDir, fixture } = cursorUser();
      fixture
        .composer(
          "gap",
          [
            ["m1", 1],
            ["m2", 2],
            ["m3", 1],
          ],
          { lastUpdatedAt: updatedAt },
        )
        .bubble("gap", "m1", { type: 1, text: "first question" })
        .bubble("gap", "m3", { type: 1, text: "third question" });
      return { userDir, fixture };
    }

    it("indexes the messages after a gap once the missing message arrives", async () => {
      const t0 = Date.parse("2026-10-01T10:00:00Z");
      const { userDir, fixture } = withGap(t0);
      fixture.close();
      const adapter = createCursorAdapter(userDir, { now: () => t0 + HOUR });
      await indexAll(store, [adapter]);
      expect(indexed("gap")).toEqual(["user: first question"]);
      // Nothing changed: still waiting.
      await indexAll(store, [adapter]);
      expect(indexed("gap")).toEqual(["user: first question"]);

      // The message is stored; Cursor does not touch the composer itself.
      new CursorFixture(userDir).bubble("gap", "m2", { type: 2, text: "second answer" }).close();
      const stats = await indexAll(store, [adapter]);
      expect(stats.errors).toBe(0);
      expect(indexed("gap")).toEqual([
        "user: first question",
        "assistant: second answer",
        "user: third question",
      ]);
    });

    it("skips a message that never arrives once the conversation is a day old", async () => {
      const t0 = Date.parse("2026-10-01T10:00:00Z");
      const { userDir, fixture } = withGap(t0);
      fixture.close();
      let now = t0 + HOUR;
      const adapter = createCursorAdapter(userDir, { now: () => now });
      await indexAll(store, [adapter]);
      expect(indexed("gap")).toEqual(["user: first question"]);
      now = t0 + 25 * HOUR;
      await indexAll(store, [adapter]);
      expect(indexed("gap")).toEqual(["user: first question", "user: third question"]);
    });

    it("does not list composers kept only in the opaque newer format", async () => {
      const { userDir, fixture } = cursorUser();
      fixture
        .raw("composerData:opaque", { _v: 16, composerId: "opaque", conversationState: "~x" })
        .raw("composerData:odd", { _v: 10, composerId: "odd", fullConversationHeadersOnly: {} })
        .close();
      const stats = await indexAll(store, [createCursorAdapter(userDir)]);
      // "broken" (invalid JSON) and b6 are the only skipped records; "odd" is malformed too.
      expect(stats).toMatchObject({ skipped: 3, errors: 0 });
      const ids = store.listSourceIds("cursor");
      expect(ids).not.toContain("cursor:opaque");
      expect(ids).toContain("cursor:odd");
    });

    it("keeps what was indexed from a conversation that became unreadable", async () => {
      const { userDir, fixture } = cursorUser();
      fixture.close();
      const adapter = createCursorAdapter(userDir);
      await indexAll(store, [adapter]);
      expect(indexed("c3")).toEqual(["assistant: unmapped answer"]);

      new CursorFixture(userDir).raw("composerData:c3", "{oops").close();
      const stats = await indexAll(store, [adapter]);
      expect(stats).toMatchObject({ archived: 0, resets: 0, skipped: 1, errors: 0 });
      expect(indexed("c3")).toEqual(["assistant: unmapped answer"]);
      // Still unreadable: left alone, not reported again.
      expect(await indexAll(store, [adapter])).toMatchObject({ sources: 0, skipped: 0 });
      expect(indexed("c3")).toEqual(["assistant: unmapped answer"]);

      // Readable again: reading goes on from where it stopped.
      new CursorFixture(userDir)
        .composer("c3", [
          ["y1", 2],
          ["y2", 1],
        ])
        .bubble("c3", "y2", { type: 1, text: "follow-up" })
        .close();
      await indexAll(store, [adapter]);
      expect(indexed("c3")).toEqual(["assistant: unmapped answer", "user: follow-up"]);
    });
  });

  it("reports a missing Cursor database without failing", async () => {
    const userDir = join(tempDir("lore-cursor-"), "User");
    expect(await createCursorAdapter(userDir).discover()).toEqual({
      sources: [],
      complete: true,
      missingRoot: join(userDir, "globalStorage", "state.vscdb"),
    });
  });

  it.skipIf(process.platform === "win32")(
    "decodes workspace URIs as Cursor writes them, and maps remote folders to no project",
    async () => {
      const { userDir, fixture } = cursorUser();
      fixture
        .workspace("hash-space", ["c2"], { raw: '{"folder":"file:///work/a%20b"}' })
        .workspace("hash-remote", ["c3"], {
          raw: '{"folder":"vscode-remote://ssh-remote%2Bhost/home/u/proj"}',
        })
        .close();
      const adapter = createCursorAdapter(userDir);
      await adapter.discover();
      expect(records(await readAll(adapter, "cursor:c2"))[0]?.project).toBe("/work/a b");
      expect(records(await readAll(adapter, "cursor:c3"))[0]?.project).toBe("");
    },
  );

  it("picks up a changed workspace mapping on the next discovery", async () => {
    const { userDir, fixture } = cursorUser();
    fixture.close();
    const adapter = createCursorAdapter(userDir);
    await adapter.discover();
    expect(records(await readAll(adapter, "cursor:c3"))[0]?.project).toBe("");
    const again = createCursorAdapter(userDir);
    await again.discover();
    expect(records(await readAll(again, "cursor:c3"))[0]?.project).toBe("");

    new CursorFixture(userDir).workspace("hash-a", ["c1", "c3"], { folder: repoA }).close();
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(userDir, "workspaceStorage", "hash-a", "state.vscdb"), future, future);
    await adapter.discover();
    expect(records(await readAll(adapter, "cursor:c3"))[0]?.project).toBe(repoA);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reads a workspace again after a failed read, even if its files did not change",
    async () => {
      const { userDir, fixture } = cursorUser();
      fixture.workspace("hash-late", ["c3"], { folder: repoC }).close();
      const db = join(userDir, "workspaceStorage", "hash-late", "state.vscdb");
      // Unreadable for a moment; permissions are not part of what marks a workspace changed.
      chmodSync(db, 0o000);
      const warn = vi.fn();
      const adapter = createCursorAdapter(userDir, { warn });
      try {
        await adapter.discover();
        expect(records(await readAll(adapter, "cursor:c3"))[0]?.project).toBe("");
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/cannot read workspace .*hash-late/),
        );
      } finally {
        chmodSync(db, 0o644);
      }
      await adapter.discover();
      expect(records(await readAll(adapter, "cursor:c3"))[0]?.project).toBe(repoC);
    },
  );

  it("ignores workspace folders it cannot read", async () => {
    const { userDir, fixture } = cursorUser();
    fixture.workspace("hash-bad", ["c3"], { folder: repoC }).close();
    rmSync(join(userDir, "workspaceStorage", "hash-bad", "state.vscdb"));
    writeFileSync(join(userDir, "workspaceStorage", ".DS_Store"), "");
    const warn = vi.fn();
    const adapter = createCursorAdapter(userDir, { warn });
    await adapter.discover();
    expect(records(await readAll(adapter, "cursor:c3"))[0]?.project).toBe("");
    // Missing files are expected while Cursor creates or removes a workspace.
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the workspace folder cannot be listed, and still reads conversations", async () => {
    const { userDir, fixture } = cursorUser();
    fixture.close();
    const workspaces = join(userDir, "workspaceStorage");
    rmSync(workspaces, { recursive: true });
    writeFileSync(workspaces, "");
    const warn = vi.fn();
    const adapter = createCursorAdapter(userDir, { warn });
    await adapter.discover();
    expect(records(await readAll(adapter, "cursor:c1"))[0]?.project).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cannot list .*workspaceStorage/));
  });

  it("warns nothing when Cursor has no workspace folder", async () => {
    const { userDir, fixture } = cursorUser();
    fixture.close();
    rmSync(join(userDir, "workspaceStorage"), { recursive: true });
    const warn = vi.fn();
    await createCursorAdapter(userDir, { warn }).discover();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once per adapter, not once per process", async () => {
    const { userDir, fixture } = cursorUser();
    fixture.close();
    writeFileSync(join(userDir, "globalStorage", "state.vscdb-wal"), "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = createCursorAdapter(userDir);
      await first.discover();
      await first.discover();
      expect(error).toHaveBeenCalledTimes(1);
      await createCursorAdapter(userDir).discover();
      expect(error).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenLastCalledWith(expect.stringMatching(/may be stale/));
    } finally {
      error.mockRestore();
    }
  });

  it("never writes to Cursor's database nor adds or removes files next to it", async () => {
    const { userDir, fixture } = cursorUser();
    fixture.close();
    const db = join(userDir, "globalStorage", "state.vscdb");
    expect(existsSync(`${db}-wal`)).toBe(false);
    const before = { files: listing(userDir), mtime: statSync(db).mtimeMs, hash: sha1(db) };
    const home = tempDir("lore-cursor-");
    const store = openStore(join(home, "index.db"));
    try {
      const stats = await indexAll(store, [createCursorAdapter(userDir)]);
      // The unreadable composer is listed too (and counted as skipped), not indexed.
      expect(stats).toMatchObject({ sources: 4, errors: 0, skipped: 2 });
      expect(store.stats()).toEqual([expect.objectContaining({ tool: "cursor", sources: 4 })]);
    } finally {
      store.close();
    }
    expect({ files: listing(userDir), mtime: statSync(db).mtimeMs, hash: sha1(db) }).toEqual(
      before,
    );
  });

  it("opens a database without a write-ahead log as immutable", () => {
    const { userDir, fixture } = cursorUser();
    fixture.close();
    const db = join(userDir, "globalStorage", "state.vscdb");
    const warn = vi.fn();
    const opened = openCursorDb(db, warn);
    expect(opened.mode).toBe("immutable");
    expect(() => opened.db.exec("DELETE FROM cursorDiskKV")).toThrow(/readonly/);
    opened.db.close();
    expect(warn).not.toHaveBeenCalled();
  });

  it("opens the database read-only while Cursor writes, seeing its latest messages", async () => {
    const { userDir, fixture } = cursorUser();
    try {
      const db = join(userDir, "globalStorage", "state.vscdb");
      // The writer is still open: everything it wrote is only in the write-ahead log.
      expect(existsSync(`${db}-wal`) && existsSync(`${db}-shm`)).toBe(true);
      const files = listing(userDir);
      const warn = vi.fn();
      const opened = openCursorDb(db, warn);
      expect(opened.mode).toBe("readonly");
      expect(() => opened.db.exec("DELETE FROM cursorDiskKV")).toThrow(/readonly/);
      opened.db.close();
      expect(warn).not.toHaveBeenCalled();
      expect(records(await readAll(createCursorAdapter(userDir), "cursor:c3"))).toHaveLength(1);
      expect(listing(userDir)).toEqual(files);
    } finally {
      fixture.close();
    }
  });

  it("falls back to immutable, with a warning, when the write-ahead log has no -shm file", () => {
    const { userDir, fixture } = cursorUser();
    fixture.close();
    const db = join(userDir, "globalStorage", "state.vscdb");
    writeFileSync(`${db}-wal`, "");
    const files = listing(userDir);
    const warn = vi.fn();
    const opened = openCursorDb(db, warn);
    expect(opened.mode).toBe("immutable");
    opened.db.close();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/-shm file is missing.*may be stale/));
    expect(listing(userDir)).toEqual(files);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "falls back to immutable, with a warning, when the read-only open fails",
    () => {
      const { userDir, fixture } = cursorUser();
      fixture.close();
      const db = join(userDir, "globalStorage", "state.vscdb");
      writeFileSync(`${db}-wal`, "");
      writeFileSync(`${db}-shm`, "");
      chmodSync(`${db}-shm`, 0o000);
      try {
        const warn = vi.fn();
        const opened = openCursorDb(db, warn);
        expect(opened.mode).toBe("immutable");
        expect(opened.db.prepare("SELECT count(*) AS n FROM cursorDiskKV").get()).toEqual({
          n: expect.any(Number),
        });
        opened.db.close();
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be opened read-only/));
      } finally {
        chmodSync(`${db}-shm`, 0o644);
      }
    },
  );

  it("explains when a database cannot be opened at all", () => {
    const dir = tempDir("lore-cursor-");
    expect(() => openCursorDb(join(dir, "missing.vscdb"))).toThrow(/cannot open .*immutable/);
  });
});

/** Every file and folder under `dir`, relative and sorted. */
function listing(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).sort();
}

describe("uriPath", () => {
  it("decodes file URIs, with an upper-case drive letter on Windows", () => {
    expect(uriPath("file:///c%3A/a%20b", true)).toBe("C:\\a b");
    expect(uriPath("file:///D:/repo/x", true)).toBe("D:\\repo\\x");
    expect(uriPath("file:///work/a%20b", false)).toBe("/work/a b");
  });

  it("gives no path for remote or malformed URIs", () => {
    expect(uriPath("vscode-remote://ssh-remote%2Bhost/home/u/proj", false)).toBeUndefined();
    expect(uriPath("not a uri", false)).toBeUndefined();
    expect(uriPath("file://server/share/x", false)).toBeUndefined();
  });
});

describe("cursorUserDir", () => {
  it("is Cursor's User folder on each platform", () => {
    expect(cursorUserDir("darwin", {}, "/Users/u")).toBe(
      join("/Users/u", "Library", "Application Support", "Cursor", "User"),
    );
    expect(cursorUserDir("linux", {}, "/home/u")).toBe(
      join("/home/u", ".config", "Cursor", "User"),
    );
    expect(cursorUserDir("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/u")).toBe(
      join("/cfg", "Cursor", "User"),
    );
    expect(cursorUserDir("win32", { APPDATA: "C:\\AppData" }, "C:\\u")).toBe(
      join("C:\\AppData", "Cursor", "User"),
    );
    expect(cursorUserDir("win32", {}, "/u")).toBe(
      join("/u", "AppData", "Roaming", "Cursor", "User"),
    );
  });
});

function sha1(path: string): string {
  return createHash("sha1").update(readFileSync(path)).digest("hex");
}
