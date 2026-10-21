import { afterEach, describe, expect, it } from "vitest";
import { type Embedder, embedMissing } from "../../src/core/embedder.js";
import { formatHits } from "../../src/core/format.js";
import { search } from "../../src/core/search.js";
import { openStore, type Store } from "../../src/core/store.js";
import { chunk, seed } from "../helpers.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** Words of one concept share a dimension, so synonyms are close; normalized like a model's. */
const CONCEPTS = [
  ["car", "automobile", "vehicle", "xe"],
  ["broken", "failure", "fails", "hỏng"],
  ["invoice", "billing", "payment"],
];
const fake = (model = "fake-model"): Embedder & { calls: number } => {
  const embedder = {
    model,
    calls: 0,
    async embed(texts: string[]) {
      embedder.calls += texts.length;
      return texts.map((text) => {
        const words = text.toLowerCase().split(/[^\p{L}]+/u);
        const v = new Float32Array(CONCEPTS.length + 1);
        CONCEPTS.forEach((group, i) => {
          v[i] = words.filter((w) => group.includes(w)).length;
        });
        v[CONCEPTS.length] = 0.1;
        const norm = Math.hypot(...v);
        return v.map((x) => x / norm);
      });
    },
  };
  return embedder;
};

function seeded(): Store {
  const store = openStore(":memory:");
  stores.push(store);
  seed(store, "/a", [
    chunk({ sessionId: "auto", text: "user: the automobile shows an engine failure on cold days" }),
    chunk({ sessionId: "pay", text: "user: billing sends the invoice twice" }),
    chunk({ sessionId: "kw", text: "user: vehicle broken notes, nothing more" }),
  ]);
  return store;
}

describe("semantic search", () => {
  it("embeds each chunk text once, and again only for a new model", async () => {
    const store = seeded();
    const embedder = fake();
    expect(await embedMissing(store, embedder)).toBe(3);
    expect(await embedMissing(store, embedder)).toBe(0);
    expect(store.embeddingCounts()).toEqual({ embedded: 3, total: 3 });
    // Vectors are keyed by text: a rebuilt index finds them again.
    store.reset();
    seed(store, "/a", [
      chunk({ sessionId: "auto", text: "user: billing sends the invoice twice" }),
    ]);
    expect(store.embeddingCounts()).toEqual({ embedded: 1, total: 1 });
    expect(await embedMissing(store, fake("other-model"))).toBe(1);
    expect(store.embeddingModel()).toBe("other-model");
    store.dropEmbeddings();
    expect(store.embeddingModel()).toBeUndefined();
  });

  it("finds a chunk by meaning when the query's words are not in it", async () => {
    const store = seeded();
    const embedder = fake();
    await embedMissing(store, embedder);
    const [vector] = await embedder.embed(["vehicle broken"], "query");
    const keyword = search(store, "vehicle broken");
    expect(keyword.map((h) => h.sessionId)).toEqual(["kw"]);
    const hybrid = search(store, "vehicle broken", { vector });
    expect(hybrid.map((h) => h.sessionId)).toEqual(["kw", "auto", "pay"]);
    expect(hybrid[0]?.semantic).toBeUndefined();
    expect(hybrid[1]?.semantic).toBe(true);
    expect(hybrid[1]?.snippet).toContain("automobile");
    expect(
      formatHits(hybrid)
        .split("\n")
        .find((l) => l.includes(" claude ")),
    ).toBeDefined();
    expect(formatHits([hybrid[1] as (typeof hybrid)[number]])).toMatch(
      /· user said · by meaning$/m,
    );
  });

  it("applies the same filters to semantic matches", async () => {
    const store = seeded();
    const embedder = fake();
    await embedMissing(store, embedder);
    const [vector] = await embedder.embed(["vehicle broken"], "query");
    const hits = search(store, "vehicle broken", { vector, excludeSessionId: "auto" });
    expect(hits.map((h) => h.sessionId)).not.toContain("auto");
    expect(search(store, "vehicle broken", { vector, since: "2030-01-01T00:00:00.000Z" })).toEqual(
      [],
    );
  });
});
