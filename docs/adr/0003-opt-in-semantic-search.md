# ADR 0003: Opt-in semantic search

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

Keyword search (FTS5, BM25) misses a chunk that says the same thing in other words, or in another
language than the query. Embeddings fix that, but need a model runtime (Transformers.js with
ONNX Runtime, about 500 MB) and a model downloaded from the network, while agentlore promises
a small install and no network calls.

## Decision

1. Semantic search is **opt-in**. `lore embed` installs `@huggingface/transformers` at a pinned
   version into `AGENTLORE_HOME/runtime` with npm, downloads `Xenova/multilingual-e5-small`
   (384 dimensions, multilingual, quantized) into `AGENTLORE_HOME/models`, and embeds every chunk
   text. It is the only command that uses the network. agentlore's own package does not depend
   on the runtime.
2. Vectors live in the `embeddings` table, keyed by `sha1(text)` (`chunks.text_hash`), with their
   own `EMBEDDINGS_VERSION`: a cache rebuild keeps them (ADR 0001, rules 3 and 5). One model at a
   time; switching models drops the old vectors.
3. When vectors exist, `lore search` and the MCP `search` tool embed the query (model loaded
   from disk, remote access off), take the 50 most similar chunks that pass the same filters
   (brute-force dot product over cached vectors). Keyword hits keep their order, which already
   weighs who said them (a first version fused both lists fully, and an agent's wrong claim
   that matched both outranked the user's own words); the semantic-only hits are interleaved by
   rank (reciprocal rank fusion, k = 60, each hit counted in the list that found it) and
   labelled `by meaning`.
4. The knowledge-mode prompt hook stays keyword-only: loading the model takes about a second.
5. `lore index` embeds new chunks when the runtime and model are present, never downloading.

## Consequences

- Users who never run `lore embed` get the same install, behaviour and speed as before.
- The first search in a process pays the model load; the MCP server keeps it loaded.
- `index.db` grows by about 1.5 KB per distinct chunk text.
