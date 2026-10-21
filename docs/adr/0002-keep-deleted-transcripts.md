# ADR 0002: Keep what deleted transcripts said

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

The tools delete their own transcripts. Claude Code removes sessions inactive for 30 days by
default (`cleanupPeriodDays`), Cursor drops a chat the user deletes, and users clear old Codex
sessions to save space. Until now agentlore removed a source from the index once its transcript
disappeared, so a decision made five weeks ago was gone from search as soon as the tool cleaned
up, which is when a librarian is most useful.

Under [ADR 0001](0001-index-is-a-rebuildable-cache.md) the index is a cache rebuilt from the
transcripts that exist. The content of a deleted transcript cannot be rebuilt, so by that ADR's
rule 3 it cannot live only in cache tables.

## Decision

1. When a complete scan no longer finds a source, its chunks are **archived**, not removed: they
   are copied, in order, to the `archive` table of `index.db`, and the source stays in the index,
   marked with the version `archived` (`src/core/archive.ts`).
2. The archive is not a cache. A rebuild (schema change, redaction change, `lore index --rebuild`)
   never drops it; after recreating the cache tables, it puts the archived chunks back. The
   archive has its own `ARCHIVE_VERSION` in `archive_meta`, changed only with a tested
   migration; an archive written by a newer agentlore is refused.
3. Archived text was redacted when it was indexed. Each row records its `REDACTION_VERSION`;
   rows redacted by older rules are redacted again, in the archive too, on the next rebuild,
   which a redaction change triggers.
4. A transcript that exists again (restored from a backup, or an id the tool reuses) is the
   truth again: it is read in full, replacing its archived chunks and archive rows.
5. Users remove a kept session with `lore forget <id>`. It only removes sessions whose
   transcripts are gone, since an existing transcript would be indexed again on the next run.
   `rm -rf ~/.agentlore` still removes everything.

## Consequences

- Deleting a transcript no longer deletes it from agentlore. The README's privacy section says
  so and points to `lore forget`; `lore status` shows how many sessions are kept.
- `index.db` grows with history instead of mirroring what is on disk. Chunk text is already
  stored there, so archiving roughly doubles the size of what it keeps (the same text in
  `chunks` and in `archive`).
- Transcripts deleted before agentlore first indexed them cannot be recovered. The README
  suggests raising `cleanupPeriodDays`.
