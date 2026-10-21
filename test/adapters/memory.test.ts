import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryAdapter, MEMORY_TOOL } from "../../src/adapters/memory.js";
import { indexAll } from "../../src/core/indexer.js";
import { projectSlug, writeNote } from "../../src/core/memory.js";
import { search } from "../../src/core/search.js";
import { openStore, type Store } from "../../src/core/store.js";
import { chunk, hostPath, seed, tempDir } from "../helpers.js";

const repo = hostPath("/work/shop-api");
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("memory adapter", () => {
  it("indexes notes as note chunks, without their history", async () => {
    const root = tempDir("lore-memory-");
    writeNote(root, { project: repo, topic: "db", text: "Orders use soft delete", by: "agent" });
    writeNote(root, {
      project: repo,
      topic: "db",
      text: "Orders use soft delete via deleted_at",
      by: "agent",
    });
    const adapter = createMemoryAdapter(root);
    const { sources, complete } = await adapter.discover();
    expect(complete).toBe(true);
    expect(sources.map((s) => path.basename(s.id))).toEqual(["db.md"]);
    const batches = [];
    for await (const batch of adapter.read(sources[0] as never, undefined, {})) batches.push(batch);
    expect(batches[0]?.records).toEqual([
      expect.objectContaining({
        kind: "note",
        tool: MEMORY_TOOL,
        title: "db",
        project: repo,
        text: "Orders use soft delete via deleted_at",
      }),
    ]);
  });

  it("lists nothing, and reports no missing tool, before the first note", async () => {
    const discovery = await createMemoryAdapter(
      path.join(tempDir("lore-memory-"), "none"),
    ).discover();
    expect(discovery).toEqual({ sources: [], complete: true });
  });

  it("removes a deleted note from the index instead of archiving it", async () => {
    const root = tempDir("lore-memory-");
    writeNote(root, { project: repo, topic: "db", text: "Orders use soft delete", by: "agent" });
    const store = openStore(":memory:");
    stores.push(store);
    const adapters = [createMemoryAdapter(root)];
    await indexAll(store, adapters);
    expect(store.stats()).toEqual([{ tool: MEMORY_TOOL, sources: 1, chunks: 1 }]);
    rmSync(path.join(root, projectSlug(repo), "db.md"));
    const stats = await indexAll(store, adapters);
    expect(stats.archived).toBe(0);
    expect(store.stats()).toEqual([]);
    expect(store.archivedSessionCount()).toBe(0);
  });

  it("shows the briefs of many projects together", async () => {
    const root = tempDir("lore-memory-");
    for (const name of ["a", "b", "c"]) {
      writeNote(root, {
        project: hostPath(`/work/${name}`),
        topic: "brief",
        text: `Project ${name} uses the ledger service`,
        by: "agent",
      });
    }
    const store = openStore(":memory:");
    stores.push(store);
    await indexAll(store, [createMemoryAdapter(root)]);
    const hits = search(store, "ledger service");
    expect(hits).toHaveLength(3);
    expect(hits[0]?.sessionId).toMatch(/^brief · [a-c]-[0-9a-f]{8}$/);
  });

  it("ranks a note above a transcript matching as well", async () => {
    const root = tempDir("lore-memory-");
    const store = openStore(":memory:");
    stores.push(store);
    seed(store, "/t", [chunk({ text: "user: orders soft delete column is deleted_at" })]);
    writeNote(root, {
      project: repo,
      topic: "db",
      text: "orders soft delete column is deleted_at",
      by: "agent",
    });
    await indexAll(store, [createMemoryAdapter(root)], { record: false });
    expect(store.getMeta("lastIndexedAt")).toBeUndefined();
    const hits = search(store, "orders soft delete");
    expect(hits.map((h) => h.kind)).toEqual(["note", "transcript"]);
  });
});
