import type Database from "better-sqlite3";

/**
 * Vectors of chunk texts for semantic search, keyed by `textHash` so a cache rebuild keeps them
 * (docs/adr/0001, rules 3 and 5). One model at a time: switching models drops the old vectors.
 * Bump EMBEDDINGS_VERSION with a migration on any change.
 */
export const EMBEDDINGS_VERSION = 1;

const EMBEDDINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS embeddings (hash TEXT PRIMARY KEY, vector BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Create the tables when missing; throws for tables a newer agentlore wrote. */
export function ensureEmbeddings(db: Database.Database, path: string): void {
  db.exec(EMBEDDINGS_SCHEMA);
  const version = meta(db, "version");
  if (version === undefined) {
    setMeta(db, "version", String(EMBEDDINGS_VERSION));
  } else if (Number(version) > EMBEDDINGS_VERSION) {
    throw new Error(
      `The embeddings in ${path} were written by a newer agentlore (embeddings ${version}, this version supports ${EMBEDDINGS_VERSION}). Upgrade agentlore.`,
    );
  }
}

const hasTables = (db: Database.Database) =>
  db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embedding_meta'")
    .get() !== undefined;

function meta(db: Database.Database, key: string): string | undefined {
  if (!hasTables(db)) return undefined;
  const row = db.prepare("SELECT value FROM embedding_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** The model the stored vectors come from, if any. */
export const embeddingModel = (db: Database.Database): string | undefined => meta(db, "model");

/** Record the model about to be used; vectors of another model are dropped. */
export function useEmbeddingModel(db: Database.Database, model: string): void {
  db.transaction(() => {
    if (embeddingModel(db) !== model) db.exec("DELETE FROM embeddings");
    setMeta(db, "model", model);
  }).immediate();
}

/** Delete every vector and the model: semantic search is off until vectors are made again. */
export function dropEmbeddings(db: Database.Database): void {
  db.transaction(() => {
    db.exec("DELETE FROM embeddings; DELETE FROM embedding_meta WHERE key = 'model'");
  }).immediate();
}

/** Distinct chunk texts without a vector yet, at most `limit`. */
export function missingEmbeddings(
  db: Database.Database,
  limit: number,
): { hash: string; text: string }[] {
  return db
    .prepare(
      `SELECT c.text_hash AS hash, min(c.text) AS text FROM chunks c
       WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.hash = c.text_hash)
       GROUP BY c.text_hash LIMIT ?`,
    )
    .all(limit) as { hash: string; text: string }[];
}

export function saveEmbeddings(
  db: Database.Database,
  rows: { hash: string; vector: Float32Array }[],
): void {
  const insert = db.prepare("INSERT OR REPLACE INTO embeddings (hash, vector) VALUES (?, ?)");
  db.transaction(() => {
    for (const { hash, vector } of rows) {
      insert.run(hash, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
    }
  }).immediate();
}

/** How many distinct chunk texts have a vector, out of how many. */
export function embeddingCounts(db: Database.Database): { embedded: number; total: number } {
  if (!hasTables(db)) return { embedded: 0, total: 0 };
  return db
    .prepare(
      `SELECT count(*) AS total, count(e.hash) AS embedded
       FROM (SELECT DISTINCT text_hash FROM chunks) c LEFT JOIN embeddings e ON e.hash = c.text_hash`,
    )
    .get() as { embedded: number; total: number };
}

/** All stored vectors by text hash. */
export function loadVectors(db: Database.Database): Map<string, Float32Array> {
  const vectors = new Map<string, Float32Array>();
  for (const row of db.prepare("SELECT hash, vector FROM embeddings").iterate() as Iterable<{
    hash: string;
    vector: Buffer;
  }>) {
    const copy = new Uint8Array(row.vector);
    vectors.set(row.hash, new Float32Array(copy.buffer, 0, copy.byteLength / 4));
  }
  return vectors;
}

/** Dot product: cosine similarity for the normalized vectors models return. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}
