import type { CitationCheck } from "./citations.js";
import type { Provenance } from "./provenance.js";

/** Id of the tool a source belongs to (e.g. "claude", "codex"), chosen by its adapter. */
export type Tool = string;

export type ChunkKind = "transcript" | "note" | "code";

/** One unit of text read from a source, normalized across tools. */
export interface SourceRecord {
  kind: ChunkKind;
  tool: Tool;
  sessionId?: string;
  /** A note's heading or a code file's path. */
  title?: string;
  /** "agent" is a prompt another agent wrote, e.g. a parent agent's task for a subagent. */
  role?: "user" | "assistant" | "agent";
  meta?: TranscriptMeta;
  /** The repo or folder it belongs to (for transcripts, the session's working directory). */
  project: string;
  /** ISO 8601. */
  timestamp: string;
  text: string;
}

export interface TranscriptMeta {
  /** A subagent's record: indexed, but ranked below the main sessions. */
  sidechain?: boolean;
}

/** Consecutive records of one kind and group (session or document), the unit we index. */
export interface Chunk {
  kind: ChunkKind;
  tool: Tool;
  /** The session id, else the document title, else "". */
  sessionId: string;
  project: string;
  startedAt: string;
  endedAt: string;
  text: string;
  /** Made from subagent records; a top-level field because store and ranking use it. */
  sidechain?: boolean;
}

/** A stored chunk with its stable id (see `chunkKey`). */
export interface StoredChunk extends Chunk {
  chunkId: string;
  sourceId: string;
}

/** A full-text match; matched terms in `snippet` are in [brackets]. */
export interface SearchHit {
  chunkId: string;
  kind: ChunkKind;
  tool: Tool;
  project: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  snippet: string;
  /** bm25: lower is better. */
  score: number;
  /** Who said the matched part of a transcript chunk (see `provenance`). */
  said?: Provenance;
  /** The file `said.cites` names is gone or changed since (see `checkCitation`). */
  citation?: CitationCheck;
  /** A later hit that seems to correct this one (see `corrections`). */
  correctedBy?: string;
  /** Found by meaning (embeddings), not by the query's words. */
  semantic?: boolean;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Where an adapter stopped reading a source (e.g. a byte offset); shape is adapter-private. */
export type Checkpoint = Json;

/** One readable unit of a tool's data: a transcript file, a database row, a notes file… */
export interface SourceRef {
  /** Stable, unique id, e.g. an absolute path or `cursor:<db>#<id>`. */
  id: string;
  /** Changes whenever the source changes; equal versions are skipped. */
  version: string;
}

export interface Discovery {
  sources: SourceRef[];
  /** False when some sources could not be listed, so absent ones must not be pruned. */
  complete: boolean;
  /** Set when the location the sources are read from does not exist. */
  missingRoot?: string;
}

export interface ReadOptions {
  /** Max size of one batch (lines for JSONL sources); bounds memory. */
  batchSize?: number;
}

/** New records of a source and the checkpoint just after them. */
export interface ReadBatch {
  records: SourceRecord[];
  checkpoint: Checkpoint;
  /** Discard everything indexed earlier from this source first. */
  reset: boolean;
  /** Records that could not be parsed or did not match the expected schema. */
  skipped: number;
}

/** Turns one tool's data into normalized records; redaction, chunking and storage are the core's. */
export interface Adapter {
  tool: Tool;
  /**
   * False when a source that disappears was deleted on purpose (the user's own notes): it is removed
   * from the index instead of archived (see `Store.archiveSource`). True by default.
   */
  archiveDeleted?: boolean;
  discover(): Promise<Discovery>;
  /**
   * Read what is new since `checkpoint` (everything when undefined), in batches. A source that
   * cannot be appended to yields `reset: true` on its first batch. May yield nothing.
   */
  read(
    source: SourceRef,
    checkpoint: Checkpoint | undefined,
    options: ReadOptions,
  ): AsyncIterable<ReadBatch>;
}
