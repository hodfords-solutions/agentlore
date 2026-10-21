import type Database from "better-sqlite3";
import { ensureArchive, hasArchive, restoreArchive } from "./archive.js";
import { ensureEmbeddings } from "./embeddings.js";
import { errnoCode } from "./errors.js";
import { REDACTION_VERSION } from "./redact.js";

/** Bump on any schema change; an older index is rebuilt, being a cache (docs/adr/0001). */
export const SCHEMA_VERSION = 7;

const DROP_SCHEMA = `
DROP TABLE IF EXISTS chunks_fts;
DROP TRIGGER IF EXISTS chunks_ai;
DROP TRIGGER IF EXISTS chunks_ad;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS sources;
DROP TABLE IF EXISTS meta;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  version TEXT NOT NULL,
  checkpoint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
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
  sidechain INTEGER NOT NULL DEFAULT 0,
  -- textHash(text): embeddings are keyed by it, so they survive rebuilds (docs/adr/0001).
  text_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id);
-- Sessions written to lately (see Store.recentSessions), without reading every row.
CREATE INDEX IF NOT EXISTS chunks_recent ON chunks(ended_at, session_id) WHERE kind = 'transcript';
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function rebuild(db: Database.Database): void {
  db.exec(DROP_SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('redactionVersion', ?)").run(
    String(REDACTION_VERSION),
  );
  // Deleted transcripts cannot be read again: their chunks come back from the archive.
  if (hasArchive(db)) restoreArchive(db);
}

/**
 * Rebuild when the schema or `REDACTION_VERSION` is older (so new rules reach old content);
 * never drop an index a newer agentlore built. Immediate transaction so concurrent openers agree.
 */
export function migrate(db: Database.Database, path: string): void {
  db.transaction(() => {
    const outdated = isOutdated(db, path);
    ensureArchive(db, path);
    ensureEmbeddings(db, path);
    if (outdated) rebuild(db);
  }).immediate();
}

/** Throws for an index built by a newer agentlore. */
function isOutdated(db: Database.Database, path: string): boolean {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) throw newerIndexError(path, `schema ${version}`, SCHEMA_VERSION);
  // An older schema may not even have the meta table.
  if (version < SCHEMA_VERSION) return true;
  const redaction = redactionVersion(db);
  if (redaction > REDACTION_VERSION) {
    throw newerIndexError(path, `redaction ${redaction}`, REDACTION_VERSION);
  }
  return redaction !== REDACTION_VERSION;
}

/** NaN when missing or unreadable, which compares as neither newer nor current. */
function redactionVersion(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'redactionVersion'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : Number.NaN;
}

/** Best effort: auto_vacuum can only be switched on an empty file (VACUUM applies it). */
export function enableIncrementalVacuum(db: Database.Database): void {
  if (db.pragma("auto_vacuum", { simple: true }) === 2) return;
  const empty = db.prepare("SELECT 1 FROM sources UNION ALL SELECT 1 FROM chunks LIMIT 1").get();
  if (empty) return;
  try {
    db.pragma("auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
  } catch (error) {
    // Another connection is busy; retry on a later open.
    if (!/^SQLITE_(BUSY|LOCKED)/.test(errnoCode(error) ?? "")) throw error;
  }
}

/** For read-only opens, which cannot rebuild. */
export function checkCurrent(db: Database.Database, path: string): void {
  if (isOutdated(db, path)) {
    throw new Error(
      `The index at ${path} was built by an older agentlore; \`lore index\` rebuilds it.`,
    );
  }
}

const newerIndexError = (path: string, found: string, supported: number) =>
  new Error(
    `The index at ${path} was created by a newer agentlore (${found}, this version supports ${supported}); upgrade agentlore or delete ${path}.`,
  );
