import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeAdapter } from "../../src/adapters/claude.js";
import { getContext } from "../../src/core/context.js";
import { indexAll } from "../../src/core/indexer.js";
import { search } from "../../src/core/search.js";
import { openStore, type Store } from "../../src/core/store.js";
import { hostPath } from "../helpers.js";

const root = join(import.meta.dirname, "../fixtures/unicode/claude");
const fixture = readFileSync(join(root, "-work-repo-u/unicode-s1.jsonl"), "utf8");
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function indexed(): Promise<Store> {
  const store = openStore(":memory:");
  stores.push(store);
  const stats = await indexAll(store, [createClaudeAdapter(root)]);
  expect(stats).toMatchObject({ sources: 1, skipped: 0, errors: 0 });
  return store;
}

describe("unicode transcripts (emoji and Vietnamese)", () => {
  it("finds Vietnamese text with and without diacritics", async () => {
    const store = await indexed();
    for (const query of ["triển khai thanh toán", "trien khai thanh toan", "khóa ghi đè"]) {
      const hits = search(store, query);
      expect(hits, query).toHaveLength(1);
      expect(hits[0]).toMatchObject({ sessionId: "unicode-s1", project: hostPath("/work/repo-u") });
    }
  });

  it("finds words next to emoji and keeps emoji intact in snippets and context", async () => {
    const store = await indexed();
    const [hit] = search(store, "idempotency staging");
    expect(hit?.snippet).toMatch(/🚀🔥|🔑/u);
    const context = getContext(store, hit?.chunkId ?? "", 0);
    if (!context.ok) throw new Error(context.message);
    const text = context.chunks.map((c) => c.text).join("\n");
    // Emoji with surrogate pairs and a ZWJ family sequence survive byte-exact.
    for (const emoji of ["🚀🔥", "👨‍👩‍👧", "🔑", "✅"]) {
      expect(text).toContain(emoji);
      expect(fixture).toContain(emoji);
    }
    expect(text).toContain("xửLýThanhToán");
  });

  it("does not match an emoji-only query", async () => {
    expect(search(await indexed(), "🚀🔥")).toEqual([]);
  });
});
