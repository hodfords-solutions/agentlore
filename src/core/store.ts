import Database from "better-sqlite3";
import { ARCHIVED_VERSION, archiveSource, hasArchive, unarchiveSource } from "./archive.js";
import { chunkKey, textHash } from "./chunk.js";
import {
  dot,
  dropEmbeddings,
  embeddingCounts,
  embeddingModel,
  loadVectors,
  missingEmbeddings,
  saveEmbeddings,
  useEmbeddingModel,
} from "./embeddings.js";
import { checkCurrent, enableIncrementalVacuum, migrate, rebuild } from "./schema.js";
import type { Checkpoint, Chunk, ChunkKind, StoredChunk, Tool } from "./types.js";

/** Indexing progress of one source. */
export interface SourceRow {
  id: string;
  tool: Tool;
  /** The source version fully indexed, or an older/placeholder value while partly indexed. */
  version: string;
  checkpoint: Checkpoint;
}

export interface CandidateQuery {
  /** An FTS5 MATCH expression. Callers must quote user input (see `search`). */
  fts: string;
  limit: number;
  /**
   * Only chunks of this project or its subfolders. A "…/a/b" label (see `shortProject`) matches
   * projects containing those consecutive folders.
   */
  project?: string;
  /** Leave out the chunks of this session. */
  excludeSessionId?: string;
  /** Leave out the chunks of this project (normalized) and its subfolders. */
  excludeProject?: string;
  /** Only chunks starting at or after this ISO 8601 time. */
  since?: string;
  /** Only chunks starting before this ISO 8601 time. */
  until?: string;
}

/** A full-text match before ranking: the chunk's metadata and its raw bm25 score. */
export interface Candidate {
  /** The chunk's row id: pass it to `snippets` or `chunkTexts` during the same search. */
  rowid: number;
  chunkId: string;
  kind: ChunkKind;
  tool: Tool;
  project: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  /** Lower is better. */
  bm25: number;
  /** True for a subagent's chunk (see `Chunk.sidechain`). */
  sidechain: boolean;
}

/** A semantic match: a candidate and the cosine similarity of its text to the query. */
export interface SemanticCandidate extends Candidate {
  similarity: number;
}

/** Thrown by a checked `saveSource` when another writer saved or removed the source meanwhile. */
export class CheckpointConflictError extends Error {
  readonly code = "CHECKPOINT_CONFLICT";
  constructor(readonly sourceId: string) {
    super(`Source ${sourceId} changed since its checkpoint was read; not saved.`);
    this.name = "CheckpointConflictError";
  }
}

export interface SaveOptions {
  /** Replace the source's chunks instead of appending. */
  reset: boolean;
  /**
   * When present, save only if the stored checkpoint still equals this one (`undefined`: no source
   * stored), else throw `CheckpointConflictError`. Stops concurrent writers both appending.
   */
  expectedCheckpoint?: Checkpoint | undefined;
}

/** Transcript sessions and chunks of one tool in one month (by when each chunk started). */
export interface MonthCoverage {
  /** YYYY-MM. */
  month: string;
  tool: Tool;
  sessions: number;
  chunks: number;
}

/** A project's transcripts: how many chunks and when the last one ended. */
export interface ProjectActivity {
  project: string;
  chunks: number;
  lastAt: string;
}

export interface ToolStats {
  tool: Tool;
  sources: number;
  chunks: number;
}

/** The SQLite index: sources with their checkpoints, chunks with full-text search, metadata. */
export interface Store {
  /** The underlying connection, for diagnostics and tests. */
  readonly db: Database.Database;
  getSource(id: string): SourceRow | undefined;
  /** Atomically append `chunks` (replacing existing ones when `reset`) and record progress. */
  saveSource(row: SourceRow, chunks: Chunk[], options: SaveOptions): void;
  removeSource(id: string): void;
  /**
   * Keep a source whose transcript is gone: its chunks stay searchable, are copied to the archive
   * (which survives rebuilds) and the source is marked ARCHIVED_VERSION.
   */
  archiveSource(id: string): void;
  /**
   * Remove the archived sources of a session, from the index and the archive; returns how many.
   * Sources whose transcript still exists are left alone (they would be indexed again).
   */
  forgetSession(sessionId: string): number;
  /** Distinct session ids of the tool's chunks. */
  sessionIds(tool: Tool): Set<string>;
  /** Sessions with chunks kept in the archive. */
  archivedSessionCount(): number;
  /** Ids of the tool's sources that are read from their transcripts (not archived). */
  listSourceIds(tool: Tool): string[];
  /** Up to `limit` matches, best bm25 first, without snippets: the caller ranks (see `search`). */
  searchCandidates(query: CandidateQuery): Candidate[];
  /**
   * Snippets by row id, matched terms in [brackets]. Candidates whose row no longer holds the same
   * chunk (the index changed in between) are left out.
   */
  snippets(fts: string, candidates: Pick<Candidate, "rowid" | "chunkId">[]): Map<number, string>;
  /**
   * The `limit` chunks most similar to a query vector, best first, with the filters of
   * `searchCandidates`; empty without stored vectors. Vectors are cached per store.
   */
  semanticCandidates(vector: Float32Array, query: Omit<CandidateQuery, "fts">): SemanticCandidate[];
  /** The model of the stored vectors, if any. */
  embeddingModel(): string | undefined;
  /** Record the model about to be used, dropping vectors of another one. */
  useEmbeddingModel(model: string): void;
  /** Delete every vector: semantic search is off. */
  dropEmbeddings(): void;
  /** Distinct chunk texts without a vector yet, at most `limit`. */
  missingEmbeddings(limit: number): { hash: string; text: string }[];
  saveEmbeddings(rows: { hash: string; vector: Float32Array }[]): void;
  /** Distinct chunk texts with a vector, out of all. */
  embeddingCounts(): { embedded: number; total: number };
  /** The texts of the chunks with these row ids; unknown ids are left out. */
  chunkTexts(rowids: number[]): Map<number, string>;
  /** Sessions with a transcript chunk ending at or after this ISO 8601 time. */
  recentSessions(since: string): Set<string>;
  /** How many chunks match an FTS5 MATCH expression, in any project but those of `exclude`. */
  countMatches(fts: string, exclude?: MatchExclusion): number;
  /**
   * Chunk keys starting with `hexPrefix` and ending with `repeat` ("#n"), or unsuffixed when it is
   * undefined. At most 2: more than one means the prefix is ambiguous.
   */
  findChunkKeys(hexPrefix: string, repeat?: string): string[];
  /** The chunks with these ids, in the same order; unknown ids are left out. */
  getChunks(chunkIds: string[]): StoredChunk[];
  /** A chunk with up to `around` neighbours each side, in source order; empty if unknown. */
  getNeighbours(chunkId: string, around: number): StoredChunk[];
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  stats(): ToolStats[];
  /** Indexed transcripts per month and tool, oldest first; with `project`, only its own. */
  coverage(project?: string): MonthCoverage[];
  /** Distinct projects with indexed chunks. */
  projectCount(): number;
  /** Every project with transcript chunks, most recently active first. */
  projectActivity(): ProjectActivity[];
  /**
   * Main-session transcript chunks of these session folders (exact `project` values, see
   * `projectActivity`; all folders when undefined) that ended after `since`, newest first until
   * `maxChars` of text, returned oldest first.
   */
  projectExcerpts(
    folders: string[] | undefined,
    since: string | undefined,
    maxChars: number,
  ): StoredChunk[];
  chunkCount(): number;
  /** Drop everything indexed, including metadata, so the next index run starts from scratch. */
  reset(): void;
  /** Merge FTS segments and free pages; worth it after many deletions, takes seconds. */
  optimize(): void;
  close(): void;
}

interface SourceRecord {
  id: string;
  tool: string;
  version: string;
  checkpoint: string;
}

interface ChunkRecord {
  chunkKey: string;
  sourceId: string;
  kind: string;
  tool: string;
  sessionId: string;
  project: string;
  startedAt: string;
  endedAt: string;
  text: string;
  sidechain: number;
  textHash: string;
}

/** Tokens (words) per search snippet: enough to judge a hit; `context` returns the full text. */
const SNIPPET_TOKENS = 32;

const CANDIDATE_COLUMNS = `c.id AS rowid, c.chunk_key AS chunkId, c.kind, c.tool, c.project,
  c.session_id AS sessionId, c.started_at AS startedAt, c.ended_at AS endedAt, m.bm25,
  c.sidechain`;

type CandidateRow = Omit<Candidate, "sidechain"> & { sidechain: number };

/** Chunks a count leaves out: a session's, and a project's (normalized) with its subfolders. */
export interface MatchExclusion {
  sessionId?: string;
  project?: string;
}

type ExclusionParams = {
  excludeSessionId: string | null;
  excludeProject: string | null;
  excludeProjectPrefix: string | null;
};

type CandidateParams = Partial<ExclusionParams> & {
  fts: string;
  since?: string | null;
  until?: string | null;
  limit: number;
  projectPrefix?: string;
  project?: string;
  /** For "…/a/b" filters: "/a/b/" and its backslash form, matched in `project` + separator. */
  slashSuffix?: string;
  backslashSuffix?: string;
};

/** Conditions on chunk `p` for `ExclusionParams`; a null parameter excludes nothing. */
const EXCLUSION_CONDITIONS = `AND (@excludeSessionId IS NULL OR p.session_id <> @excludeSessionId)
  AND (@excludeProject IS NULL OR NOT (p.project = @excludeProject
    OR substr(p.project, 1, length(@excludeProjectPrefix)) = @excludeProjectPrefix))`;

function exclusionParams({ sessionId, project }: MatchExclusion): ExclusionParams {
  return {
    excludeSessionId: sessionId ?? null,
    excludeProject: project ?? null,
    excludeProjectPrefix: project === undefined ? null : subfolderPrefix(project),
  };
}

type ProjectFilter = "none" | "path" | "suffix";

/** Conditions on chunk `p` for a time range; a null bound limits nothing. */
const DATE_CONDITIONS = `AND (@since IS NULL OR p.started_at >= @since)
  AND (@until IS NULL OR p.started_at < @until)`;

const PROJECT_CONDITIONS: Record<ProjectFilter, string> = {
  none: "",
  path: "AND (p.project = @project OR substr(p.project, 1, length(@projectPrefix)) = @projectPrefix)",
  suffix: `AND (instr(p.project || '/', @slashSuffix) > 0
    OR instr(p.project || '\\', @backslashSuffix) > 0)`,
};

/**
 * Picks the best `limit` matches in the FTS index first, then reads only those rows in full.
 * Filters apply before the limit, so excluded chunks never take the places of others.
 */
function coverageSql(filter: ProjectFilter): string {
  return `SELECT substr(p.started_at, 1, 7) AS month, p.tool AS tool,
      count(DISTINCT p.session_id) AS sessions, count(*) AS chunks
    FROM chunks p WHERE p.kind = 'transcript' ${PROJECT_CONDITIONS[filter]}
    GROUP BY month, p.tool ORDER BY month, p.tool`;
}

function semanticSql(filter: ProjectFilter): string {
  return `SELECT p.id AS rowid, p.chunk_key AS chunkId, p.kind, p.tool, p.project,
      p.session_id AS sessionId, p.started_at AS startedAt, p.ended_at AS endedAt, 0 AS bm25,
      p.sidechain, p.text_hash AS hash
    FROM chunks p WHERE 1 = 1 ${PROJECT_CONDITIONS[filter]} ${EXCLUSION_CONDITIONS}
      ${DATE_CONDITIONS}`;
}

function candidateSql(filter: ProjectFilter, exclude: boolean, dated: boolean): string {
  const best =
    filter === "none" && !exclude && !dated
      ? `SELECT rowid AS id, bm25(chunks_fts) AS bm25 FROM chunks_fts
         WHERE chunks_fts MATCH @fts ORDER BY bm25, id LIMIT @limit`
      : `SELECT chunks_fts.rowid AS id, bm25(chunks_fts) AS bm25
         FROM chunks_fts JOIN chunks p ON p.id = chunks_fts.rowid
         WHERE chunks_fts MATCH @fts ${PROJECT_CONDITIONS[filter]}
           ${exclude ? EXCLUSION_CONDITIONS : ""} ${dated ? DATE_CONDITIONS : ""}
         ORDER BY bm25, id LIMIT @limit`;
  return `SELECT ${CANDIDATE_COLUMNS} FROM (${best}) m JOIN chunks c ON c.id = m.id
    ORDER BY m.bm25, m.id`;
}

/** Filter parameters for a project value (already normalized, see `normalizeProject`). */
function projectParams(project: string): {
  filter: ProjectFilter;
  params: Partial<CandidateParams>;
} {
  const label = /^…[\\/](.+)$/.exec(project)?.[1];
  if (label) {
    const parts = label.split(/[\\/]/).filter(Boolean);
    return {
      filter: "suffix",
      params: {
        slashSuffix: `/${parts.join("/")}/`,
        backslashSuffix: `\\${parts.join("\\")}\\`,
      },
    };
  }
  return { filter: "path", params: { project, projectPrefix: subfolderPrefix(project) } };
}

/** `project` followed by a path separator: the paths of its subfolders start with it. */
const subfolderPrefix = (project: string) =>
  /[\\/]$/.test(project)
    ? project
    : `${project}${project.includes("/") || !project.includes("\\") ? "/" : "\\"}`;

const CHUNK_COLUMNS = `chunk_key AS chunkId, source_id AS sourceId, kind, tool,
  session_id AS sessionId, project, started_at AS startedAt, ended_at AS endedAt, text`;

type StoredChunkRow = StoredChunk & { id: number };
type NeighbourParams = { sourceId: string; id: number; around: number };

function prepareStatements(db: Database.Database) {
  return {
    getSource: db.prepare<[string], SourceRecord>(
      "SELECT id, tool, version, checkpoint FROM sources WHERE id = ?",
    ),
    upsertSource: db.prepare<SourceRecord>(`
      INSERT INTO sources (id, tool, version, checkpoint)
      VALUES (@id, @tool, @version, @checkpoint)
      ON CONFLICT(id) DO UPDATE SET tool = excluded.tool, version = excluded.version,
        checkpoint = excluded.checkpoint`),
    deleteSource: db.prepare<[string]>("DELETE FROM sources WHERE id = ?"),
    // Keys "<base>#<n>" sort between "<base>#" and "<base>$" ("$" follows "#").
    keyCount: db.prepare<{ base: string; low: string; high: string }, { n: number }>(`
      SELECT count(*) AS n FROM chunks
      WHERE chunk_key = @base OR (chunk_key > @low AND chunk_key < @high)`),
    deleteChunks: db.prepare<[string]>("DELETE FROM chunks WHERE source_id = ?"),
    insertChunk: db.prepare<ChunkRecord>(`
      INSERT INTO chunks (chunk_key, source_id, kind, tool, session_id, project, started_at,
        ended_at, text, sidechain, text_hash)
      VALUES (@chunkKey, @sourceId, @kind, @tool, @sessionId, @project, @startedAt, @endedAt,
        @text, @sidechain, @textHash)`),
    listSourceIds: db.prepare<[string, string], { id: string }>(
      "SELECT id FROM sources WHERE tool = ? AND version <> ?",
    ),
    markArchived: db.prepare<[string, string]>("UPDATE sources SET version = ? WHERE id = ?"),
    archivedSources: db.prepare<[string, string], { id: string }>(`
      SELECT DISTINCT c.source_id AS id FROM chunks c JOIN sources s ON s.id = c.source_id
      WHERE c.session_id = ? AND s.version = ?`),
    getMeta: db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare<[string, string]>(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
    findKeys: db.prepare<{ pattern: string }, { key: string }>(`
      SELECT chunk_key AS key FROM chunks
      WHERE chunk_key GLOB @pattern AND chunk_key NOT GLOB '*#*' LIMIT 2`),
    findRepeatKeys: db.prepare<{ pattern: string; repeat: string }, { key: string }>(`
      SELECT chunk_key AS key FROM chunks
      WHERE chunk_key GLOB @pattern AND chunk_key GLOB '*' || @repeat LIMIT 2`),
    chunkCount: db.prepare<[], { n: number }>("SELECT count(*) AS n FROM chunks"),
    projectCount: db.prepare<[], { n: number }>(
      "SELECT count(DISTINCT project) AS n FROM chunks WHERE project <> ''",
    ),
    snippets: db.prepare<[string, string], { rowid: number; chunkId: string; snippet: string }>(`
      SELECT chunks_fts.rowid AS rowid, c.chunk_key AS chunkId,
        snippet(chunks_fts, 0, '[', ']', '…', ${SNIPPET_TOKENS}) AS snippet
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ? AND chunks_fts.rowid IN (SELECT value FROM json_each(?))`),
    chunkTexts: db.prepare<[string], { rowid: number; text: string }>(`
      SELECT id AS rowid, text FROM chunks WHERE id IN (SELECT value FROM json_each(?))`),
    recentSessions: db.prepare<[string], { sessionId: string }>(`
      SELECT DISTINCT session_id AS sessionId FROM chunks
      WHERE kind = 'transcript' AND ended_at >= ?`),
    countMatches: db.prepare<[string], { n: number }>(
      "SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?",
    ),
    countMatchesExcept: db.prepare<ExclusionParams & { fts: string }, { n: number }>(`
      SELECT count(*) AS n FROM chunks_fts JOIN chunks p ON p.id = chunks_fts.rowid
      WHERE chunks_fts MATCH @fts ${EXCLUSION_CONDITIONS}`),
    getChunk: db.prepare<[string], StoredChunkRow>(
      `SELECT id, ${CHUNK_COLUMNS} FROM chunks WHERE chunk_key = ?`,
    ),
    getChunks: db.prepare<[string], StoredChunkRow>(
      `SELECT id, ${CHUNK_COLUMNS} FROM chunks WHERE chunk_key IN (SELECT value FROM json_each(?))`,
    ),
    chunksBefore: db.prepare<NeighbourParams, StoredChunkRow>(`
      SELECT id, ${CHUNK_COLUMNS} FROM chunks
      WHERE source_id = @sourceId AND id < @id ORDER BY id DESC LIMIT @around`),
    chunksAfter: db.prepare<NeighbourParams, StoredChunkRow>(`
      SELECT id, ${CHUNK_COLUMNS} FROM chunks
      WHERE source_id = @sourceId AND id > @id ORDER BY id LIMIT @around`),
    stats: db.prepare<[], ToolStats>(`
      SELECT s.tool AS tool, count(DISTINCT s.id) AS sources, count(c.id) AS chunks
      FROM sources s LEFT JOIN chunks c ON c.source_id = s.id GROUP BY s.tool ORDER BY s.tool`),
  };
}

const withoutRowid = ({ id: _id, ...chunk }: StoredChunkRow): StoredChunk => chunk;

export interface OpenOptions {
  /** Never create, rebuild or migrate; throw if the index is missing or not current. */
  readonly?: boolean;
}

/** Open (creating or rebuilding if needed) the index at `path`; `":memory:"` for tests. */
export function openStore(path: string, { readonly = false }: OpenOptions = {}): Store {
  const db = new Database(path, { readonly, fileMustExist: readonly });
  if (!readonly) {
    // Takes effect only on a new, empty file (see enableIncrementalVacuum for rebuilt ones).
    db.pragma("auto_vacuum = INCREMENTAL");
    db.pragma("journal_mode = WAL");
    // Safe with WAL (no corruption on power loss, at worst the last commits roll back) and faster.
    db.pragma("synchronous = NORMAL");
  }
  db.pragma("busy_timeout = 5000");
  try {
    if (readonly) {
      checkCurrent(db, path);
    } else {
      migrate(db, path);
      enableIncrementalVacuum(db);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  const statements = prepareStatements(db);
  const candidateStatements = new Map<string, Database.Statement<CandidateParams, CandidateRow>>();
  const candidateStatement = (filter: ProjectFilter, exclude: boolean, dated: boolean) => {
    const key = `${filter}:${exclude}:${dated}`;
    let statement = candidateStatements.get(key);
    if (!statement) {
      statement = db.prepare<CandidateParams, CandidateRow>(candidateSql(filter, exclude, dated));
      candidateStatements.set(key, statement);
    }
    return statement;
  };

  // Keyed on the model too: re-embedding with another model can end at the same count.
  let vectors: { key: string; byHash: Map<string, Float32Array> } | undefined;
  const cachedVectors = () => {
    const count = (db.prepare("SELECT count(*) AS n FROM embeddings").get() as { n: number }).n;
    const key = `${embeddingModel(db)}:${count}`;
    if (vectors?.key !== key) vectors = { key, byHash: loadVectors(db) };
    return vectors.byHash;
  };
  const semanticStatements = new Map<ProjectFilter, Database.Statement>();
  const semanticStatement = (filter: ProjectFilter) => {
    let statement = semanticStatements.get(filter);
    if (!statement) {
      statement = db.prepare(semanticSql(filter));
      semanticStatements.set(filter, statement);
    }
    return statement;
  };

  const storedRepeats = (base: string): number =>
    statements.keyCount.get({ base, low: `${base}#`, high: `${base}$` })?.n ?? 0;

  /**
   * The n-th repeat of a text in a source gets key `#n`. A source's chunks are only deleted all
   * together, so repeats are numbered without gaps and a stored count gives the next number.
   */
  const saveSourceTx = db.transaction((row: SourceRow, chunks: Chunk[], options: SaveOptions) => {
    const { reset } = options;
    if ("expectedCheckpoint" in options) {
      const stored = statements.getSource.get(row.id)?.checkpoint;
      const expected =
        options.expectedCheckpoint === undefined
          ? undefined
          : JSON.stringify(options.expectedCheckpoint);
      if (stored !== expected) throw new CheckpointConflictError(row.id);
    }
    if (reset) {
      statements.deleteChunks.run(row.id);
      // The transcript is back (or was rewritten): it is the truth again, not the archive.
      unarchiveSource(db, row.id);
    }
    const next = new Map<string, number>();
    for (const chunk of chunks) {
      const base = chunkKey(row.id, chunk.text);
      const n = next.get(base) ?? (reset ? 0 : storedRepeats(base));
      next.set(base, n + 1);
      statements.insertChunk.run({
        ...chunk,
        sidechain: chunk.sidechain ? 1 : 0,
        textHash: textHash(chunk.text),
        sourceId: row.id,
        chunkKey: n ? `${base}#${n}` : base,
      });
    }
    statements.upsertSource.run({ ...row, checkpoint: JSON.stringify(row.checkpoint) });
  });

  const removeSourceTx = db.transaction((id: string) => {
    statements.deleteChunks.run(id);
    statements.deleteSource.run(id);
  });

  const archiveSourceTx = db.transaction((id: string) => {
    archiveSource(db, id, new Date().toISOString());
    statements.markArchived.run(ARCHIVED_VERSION, id);
  });

  const forgetSessionTx = db.transaction((sessionId: string) => {
    const ids = statements.archivedSources.all(sessionId, ARCHIVED_VERSION).map((r) => r.id);
    for (const id of ids) {
      statements.deleteChunks.run(id);
      statements.deleteSource.run(id);
      unarchiveSource(db, id);
    }
    return ids.length;
  });

  return {
    db,
    getSource(id) {
      const record = statements.getSource.get(id);
      return record && { ...record, checkpoint: JSON.parse(record.checkpoint) as Checkpoint };
    },
    saveSource(row, chunks, options) {
      // Immediate: the checkpoint check and the writes must not interleave with another writer's.
      saveSourceTx.immediate(row, chunks, options);
    },
    removeSource(id) {
      removeSourceTx(id);
    },
    archiveSource(id) {
      archiveSourceTx.immediate(id);
    },
    forgetSession(sessionId) {
      return forgetSessionTx.immediate(sessionId);
    },
    sessionIds(tool) {
      const rows = db
        .prepare("SELECT DISTINCT session_id AS id FROM chunks WHERE tool = ?")
        .all(tool) as { id: string }[];
      return new Set(rows.map((r) => r.id));
    },
    archivedSessionCount() {
      if (!hasArchive(db)) return 0;
      const row = db.prepare("SELECT count(DISTINCT session_id) AS n FROM archive").get() as {
        n: number;
      };
      return row.n;
    },
    listSourceIds(tool) {
      return statements.listSourceIds.all(tool, ARCHIVED_VERSION).map((r) => r.id);
    },
    searchCandidates({ fts, limit, project, excludeSessionId, excludeProject, since, until }) {
      const { filter, params } = project
        ? projectParams(project)
        : { filter: "none" as const, params: {} };
      const exclude = excludeSessionId !== undefined || excludeProject !== undefined;
      const exclusion = exclude
        ? exclusionParams({ sessionId: excludeSessionId, project: excludeProject })
        : {};
      const dated = since !== undefined || until !== undefined;
      const dates = dated ? { since: since ?? null, until: until ?? null } : {};
      return candidateStatement(filter, exclude, dated)
        .all({ fts, limit, ...params, ...exclusion, ...dates })
        .map((row) => ({ ...row, sidechain: row.sidechain !== 0 }));
    },
    snippets(fts, candidates) {
      if (!candidates.length) return new Map();
      const expected = new Map(candidates.map((c) => [c.rowid, c.chunkId]));
      const rows = statements.snippets.all(fts, JSON.stringify([...expected.keys()]));
      return new Map(
        rows.filter((r) => expected.get(r.rowid) === r.chunkId).map((r) => [r.rowid, r.snippet]),
      );
    },
    semanticCandidates(vector, { limit, project, excludeSessionId, excludeProject, since, until }) {
      if (!embeddingModel(db)) return [];
      const byHash = cachedVectors();
      if (!byHash.size) return [];
      const { filter, params } = project
        ? projectParams(project)
        : { filter: "none" as const, params: {} };
      const rows = semanticStatement(filter).all({
        ...params,
        ...exclusionParams({ sessionId: excludeSessionId, project: excludeProject }),
        since: since ?? null,
        until: until ?? null,
      }) as (CandidateRow & { hash: string })[];
      const scored: SemanticCandidate[] = [];
      for (const { hash, ...row } of rows) {
        const v = byHash.get(hash);
        if (v) scored.push({ ...row, sidechain: row.sidechain !== 0, similarity: dot(vector, v) });
      }
      return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    },
    embeddingModel() {
      return embeddingModel(db);
    },
    useEmbeddingModel(model) {
      useEmbeddingModel(db, model);
    },
    dropEmbeddings() {
      dropEmbeddings(db);
    },
    missingEmbeddings(limit) {
      return missingEmbeddings(db, limit);
    },
    saveEmbeddings(rows) {
      saveEmbeddings(db, rows);
    },
    embeddingCounts() {
      return embeddingCounts(db);
    },
    chunkTexts(rowids) {
      if (!rowids.length) return new Map();
      const rows = statements.chunkTexts.all(JSON.stringify(rowids));
      return new Map(rows.map((r) => [r.rowid, r.text]));
    },
    recentSessions(since) {
      return new Set(statements.recentSessions.all(since).map((r) => r.sessionId));
    },
    countMatches(fts, { sessionId, project } = {}) {
      if (sessionId === undefined && project === undefined) {
        return statements.countMatches.get(fts)?.n ?? 0;
      }
      return (
        statements.countMatchesExcept.get({ fts, ...exclusionParams({ sessionId, project }) })?.n ??
        0
      );
    },
    findChunkKeys(hexPrefix, repeat) {
      if (!/^[0-9a-f]*$/.test(hexPrefix) || (repeat && !/^#\d+$/.test(repeat))) return [];
      // A bound "<hex>*" pattern lets SQLite use the chunk_key index for the prefix.
      const pattern = `${hexPrefix}*`;
      const rows = repeat
        ? statements.findRepeatKeys.all({ pattern, repeat })
        : statements.findKeys.all({ pattern });
      return rows.map((r) => r.key);
    },
    getChunks(chunkIds) {
      if (!chunkIds.length) return [];
      const rows = statements.getChunks.all(JSON.stringify(chunkIds));
      const byId = new Map(rows.map((r) => [r.chunkId, withoutRowid(r)]));
      return chunkIds.flatMap((chunkId) => {
        const chunk = byId.get(chunkId);
        return chunk ? [chunk] : [];
      });
    },
    getNeighbours(chunkId, around) {
      const target = statements.getChunk.get(chunkId);
      if (!target) return [];
      const params = { sourceId: target.sourceId, id: target.id, around };
      const before = statements.chunksBefore.all(params).reverse();
      const after = statements.chunksAfter.all(params);
      return [...before, target, ...after].map(withoutRowid);
    },
    getMeta(key) {
      return statements.getMeta.get(key)?.value;
    },
    setMeta(key, value) {
      statements.setMeta.run(key, value);
    },
    stats() {
      return statements.stats.all();
    },
    coverage(project) {
      const { filter, params } = project
        ? projectParams(project)
        : { filter: "none" as const, params: {} };
      return db.prepare<Partial<CandidateParams>, MonthCoverage>(coverageSql(filter)).all(params);
    },
    projectCount() {
      return statements.projectCount.get()?.n ?? 0;
    },
    projectActivity() {
      return db
        .prepare<[], ProjectActivity>(
          `SELECT project, count(*) AS chunks, max(ended_at) AS lastAt FROM chunks
           WHERE kind = 'transcript' AND project <> '' GROUP BY project ORDER BY lastAt DESC`,
        )
        .all();
    },
    projectExcerpts(folders, since, maxChars) {
      const rows = db
        .prepare<{ folders: string | null; since: string | null }, StoredChunkRow>(
          `SELECT p.id, p.chunk_key AS chunkId, p.source_id AS sourceId, p.kind, p.tool,
             p.session_id AS sessionId, p.project, p.started_at AS startedAt,
             p.ended_at AS endedAt, p.text
           FROM chunks p
           WHERE p.kind = 'transcript' AND p.sidechain = 0
             AND (@folders IS NULL OR p.project IN (SELECT value FROM json_each(@folders)))
             AND (@since IS NULL OR p.ended_at > @since)
           ORDER BY p.ended_at DESC, p.id DESC`,
        )
        .iterate({ folders: folders ? JSON.stringify(folders) : null, since: since ?? null });
      const kept: StoredChunk[] = [];
      let chars = 0;
      for (const row of rows) {
        if (chars + row.text.length > maxChars && kept.length) break;
        kept.push(withoutRowid(row));
        chars += row.text.length;
      }
      return kept.reverse();
    },
    chunkCount() {
      return statements.chunkCount.get()?.n ?? 0;
    },
    reset() {
      db.transaction(() => rebuild(db)).immediate();
    },
    optimize() {
      db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('optimize')");
      db.pragma("incremental_vacuum");
    },
    close() {
      db.close();
    },
  };
}
