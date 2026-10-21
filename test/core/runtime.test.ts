import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeAdapter } from "../../src/adapters/claude.js";
import { withLock } from "../../src/core/lock.js";
import { ensureFresh } from "../../src/core/runtime.js";
import { openStore, type Store } from "../../src/core/store.js";
import type { Adapter } from "../../src/core/types.js";
import { tempDir } from "../helpers.js";

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("ensureFresh", () => {
  const setup = () => {
    const dir = tempDir("lore-rt-");
    cpSync(join(import.meta.dirname, "../fixtures"), dir, { recursive: true });
    const store = openStore(":memory:");
    stores.push(store);
    return { dir, store, adapters: [createClaudeAdapter(join(dir, "claude"))] };
  };

  it("does nothing on a never-indexed store (full backfill is explicit)", async () => {
    const { dir, store, adapters } = setup();
    expect(await ensureFresh({ store, adapters, lockPath: join(dir, "index.lock") })).toBe(
      "never-indexed",
    );
  });

  it("re-indexes when the index is stale", async () => {
    const { dir, store, adapters } = setup();
    store.setMeta("lastIndexedAt", "2000-01-01T00:00:00Z");
    expect(await ensureFresh({ store, adapters, lockPath: join(dir, "index.lock") })).toBe(
      "refreshed",
    );
    expect(store.stats()[0]?.chunks).toBeGreaterThan(0);
  });

  it("skips when the index is fresh", async () => {
    const { dir, store, adapters } = setup();
    store.setMeta("lastIndexedAt", new Date().toISOString());
    expect(await ensureFresh({ store, adapters, lockPath: join(dir, "index.lock") })).toBe("fresh");
  });

  it("reports busy when another indexer holds the lock", async () => {
    const { dir, store, adapters } = setup();
    store.setMeta("lastIndexedAt", "2000-01-01T00:00:00Z");
    const lock = join(dir, "index.lock");
    expect(await withLock(lock, () => ensureFresh({ store, adapters, lockPath: lock }))).toBe(
      "busy",
    );
    expect(store.stats()).toEqual([]);
  });

  it("reports a failed refresh, logs it and releases the lock", async () => {
    const { dir, store, adapters } = setup();
    store.setMeta("lastIndexedAt", "2000-01-01T00:00:00Z");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      ...store,
      setMeta: () => {
        throw new Error("disk full");
      },
    };
    const lock = join(dir, "index.lock");
    try {
      expect(await ensureFresh({ store: failing, adapters, lockPath: lock })).toBe(
        "refresh-failed",
      );
      expect(log).toHaveBeenCalledWith(expect.stringContaining("disk full"));
      expect(existsSync(lock)).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("skips indexing when another process refreshed the index while it waited", async () => {
    const { dir, store } = setup();
    let reads = 0;
    const racing = {
      ...store,
      getMeta: () => (reads++ === 0 ? "2000-01-01T00:00:00Z" : new Date().toISOString()),
    };
    const discover = vi.fn(async () => ({ sources: [], complete: true }));
    const adapter: Adapter = {
      tool: "claude",
      discover,
      async *read() {},
    };
    expect(
      await ensureFresh({ store: racing, adapters: [adapter], lockPath: join(dir, "index.lock") }),
    ).toBe("fresh");
    expect(discover).not.toHaveBeenCalled();
  });

  it("reports a partial refresh when the time budget runs out", async () => {
    const { dir, store, adapters } = setup();
    store.setMeta("lastIndexedAt", "2000-01-01T00:00:00Z");
    expect(
      await ensureFresh({ store, adapters, lockPath: join(dir, "index.lock") }, { budgetMs: 0 }),
    ).toBe("partial");
    expect(store.getMeta("lastIndexedAt")).toBe("2000-01-01T00:00:00Z");
  });

  it("does not start listing sources once the time budget is spent", async () => {
    const { dir, store } = setup();
    store.setMeta("lastIndexedAt", "2000-01-01T00:00:00Z");
    const discover = vi.fn(async () => ({ sources: [], complete: true }));
    const adapter: Adapter = { tool: "claude", discover, async *read() {} };
    const lockPath = join(dir, "index.lock");
    expect(await ensureFresh({ store, adapters: [adapter], lockPath }, { budgetMs: 0 })).toBe(
      "partial",
    );
    expect(discover).not.toHaveBeenCalled();
  });
});
