import type Database from "better-sqlite3";
import { textHash } from "./chunk.js";
import { REDACTION_VERSION, redact } from "./redact.js";

/**
 * What deleted transcripts said. Tools delete their own transcripts (Claude Code after 30 days by
 * default), and the index is a cache rebuilt from the transcripts that exist (docs/adr/0001), so
 * the chunks of a deleted source are copied here: never dropped by a rebuild, put back into the
 * index after one (docs/adr/0002). Bump ARCHIVE_VERSION with a migration on any change.
 */
export const ARCHIVE_VERSION = 1;

/** `sources.version` of a source whose transcript is gone and whose chunks come from the archive. */
export const ARCHIVED_VERSION = "archived";

const ARCHIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS archive (
  id INTEGER PRIMARY KEY,
  chunk_key TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  text TEXT NOT NULL,
  sidechain INTEGER NOT NULL,
  archived_at TEXT NOT NULL,
  redaction_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_source ON archive(source_id);
CREATE TABLE IF NOT EXISTS archive_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const CHUNK_COLUMNS =
  "chunk_key, source_id, kind, tool, session_id, project, started_at, ended_at, text, sidechain";

/**
 * Create the archive tables when missing. Throws for an archive a newer agentlore wrote, which
 * this version must not touch.
 */
export function ensureArchive(db: Database.Database, path: string): void {
  db.exec(ARCHIVE_SCHEMA);
  const row = db.prepare("SELECT value FROM archive_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO archive_meta (key, value) VALUES ('version', ?)").run(
      String(ARCHIVE_VERSION),
    );
    return;
  }
  if (Number(row.value) > ARCHIVE_VERSION) {
    throw new Error(
      `The archive in ${path} was written by a newer agentlore (archive ${row.value}, this version supports ${ARCHIVE_VERSION}). Upgrade agentlore.`,
    );
  }
}

/** Whether the archive tables exist: a read-only open of an index no writer has opened since. */
export const hasArchive = (db: Database.Database): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archive'").get() !==
  undefined;

/** Copy a source's chunks into the archive, in order, replacing what was archived of it before. */
export function archiveSource(db: Database.Database, sourceId: string, now: string): void {
  db.prepare("DELETE FROM archive WHERE source_id = ?").run(sourceId);
  db.prepare(
    `INSERT INTO archive (${CHUNK_COLUMNS}, archived_at, redaction_version)
     SELECT ${CHUNK_COLUMNS}, ?, ? FROM chunks WHERE source_id = ? ORDER BY id`,
  ).run(now, REDACTION_VERSION, sourceId);
}

export function unarchiveSource(db: Database.Database, sourceId: string): void {
  db.prepare("DELETE FROM archive WHERE source_id = ?").run(sourceId);
}

/**
 * Put archived chunks back into a freshly rebuilt index, as sources marked ARCHIVED_VERSION.
 * Text archived under older redaction rules is redacted again first, in the archive too.
 */
export function restoreArchive(db: Database.Database): void {
  const stale = db
    .prepare("SELECT id, text FROM archive WHERE redaction_version < ?")
    .all(REDACTION_VERSION) as { id: number; text: string }[];
  const update = db.prepare("UPDATE archive SET text = ?, redaction_version = ? WHERE id = ?");
  for (const { id, text } of stale) update.run(redact(text), REDACTION_VERSION, id);
  db.function("agentlore_text_hash", { deterministic: true }, (text) => textHash(String(text)));
  db.exec(`INSERT INTO chunks (${CHUNK_COLUMNS}, text_hash)
    SELECT ${CHUNK_COLUMNS}, agentlore_text_hash(text) FROM archive ORDER BY id`);
  db.prepare(
    `INSERT OR IGNORE INTO sources (id, tool, version, checkpoint)
     SELECT source_id, min(tool), ?, 'null' FROM archive GROUP BY source_id`,
  ).run(ARCHIVED_VERSION);
}
