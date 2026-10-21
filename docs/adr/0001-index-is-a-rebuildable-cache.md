# ADR 0001: The index is a rebuildable cache

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

agentlore stores everything it derives from the tools' transcripts in one SQLite file,
`~/.agentlore/index.db`: the `sources` table (what was read, up to which checkpoint), the
`chunks` table and its FTS5 index, and a small `meta` table. All of it can be recomputed from
the transcripts, which agentlore never modifies.

The schema will keep changing while the project is young (v0.1 already renamed `files` to
`sources` and added `chunks.kind` and `chunks.chunk_key`). Writing and testing a forward
migration for every change would slow development down and add risk for no user benefit, as
long as rebuilding is cheap: a full backfill of 7.9 GB of transcripts takes about 20 seconds.

Later versions will add data that is expensive or impossible to recompute: local embeddings
(minutes of CPU per backfill), LLM-distilled lesson notes and their state (costs money, may not
be reproducible).

## Decision

1. The tables above are a **cache**. `schema.ts` carries a single `SCHEMA_VERSION`, kept in
   SQLite's `user_version`. On open, an index with an older version is dropped and recreated
   empty, and the next `lore index` rebuilds it. An index with a newer version is never
   touched; the user is told to upgrade agentlore or delete the file.
2. Any change to a cache table's shape or meaning bumps `SCHEMA_VERSION`. No migration code is
   written for cache tables.
   Likewise, `redact.ts` carries a `REDACTION_VERSION`, kept in the `meta` table: when the
   redaction rules change what gets redacted, the version is bumped and an index written with
   another version is dropped on open, so the new rules also apply to content indexed before.
   `lore index --rebuild` drops and rebuilds the index on demand.
3. **Expensive derived data does not live in cache tables.** Embeddings, distillation state and
   anything else costly to recompute go in separately versioned tables with real, tested
   migrations, or in a separate file, so a cache rebuild never deletes them.
4. **Chunk identity is content, not position.** `chunks.chunk_key` is
   `sha1(source_id + "\0" + text)`, with a `#n` suffix only for the n-th repeat of the same text
   in one source. A chunk whose text is unchanged keeps its key across re-indexing. Chunk
   *boundaries* are not guaranteed stable across rebuilds: they depend on how a source was
   batched and when lines were appended, so the same transcript can be cut differently.
5. The embedding cache (and any other per-chunk derived data) is keyed by `sha1(chunk text)`,
   not by `chunk_key` or rowid, so it is reused for every chunk with that text, whatever its
   source or position, and survives any rebuild.
6. Data the user writes (for example lesson notes as Markdown) is never stored only in the
   index; the index only caches what it reads from those files.

## Consequences

- Upgrading agentlore across a schema change costs one full re-index on the next `lore index`
  (the MCP server answers "index is empty" until then, since it never runs a full backfill).
- Schema changes stay cheap to make and to review.
- The first feature that stores expensive derived data must introduce its own migration
  mechanism, separate from `SCHEMA_VERSION`.
