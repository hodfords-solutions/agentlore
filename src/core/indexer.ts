import { ARCHIVED_VERSION } from "./archive.js";
import { chunkRecords } from "./chunk.js";
import { errorMessage } from "./errors.js";
import { normalizeProject } from "./project.js";
import { redact } from "./redact.js";
import { CheckpointConflictError, type Store } from "./store.js";
import type { Adapter, Discovery, SourceRecord, SourceRef } from "./types.js";

export interface IndexFailure {
  /** Source id, or the tool name when listing failed. */
  source: string;
  message: string;
}

export interface IndexStats {
  /** Sources with new content. */
  sources: number;
  chunks: number;
  skipped: number;
  /** Sources whose transcript no longer exists: kept, from the archive (see `Store.archiveSource`). */
  archived: number;
  /** Sources rewritten in place, whose earlier chunks were discarded. */
  resets: number;
  /** Tools whose source location does not exist (e.g. not installed). */
  missing: { tool: string; root: string }[];
  /** Unreadable sources or adapters; retried next run. */
  errors: number;
  failures: IndexFailure[];
  /** False when the run stopped at the deadline. */
  complete: boolean;
}

export type ProgressFn = (event: { tool: string; done: number; total: number }) => void;

export interface IndexOptions {
  batchSize?: number;
  /** Called after every source and batch, e.g. to refresh the index lock. */
  heartbeat?: () => void;
  /** Epoch ms after which the run stops at the next boundary, without pruning. */
  deadline?: number;
  onProgress?: ProgressFn;
  /** Run `Store.optimize` after a run that reset sources; for full runs only. */
  maintain?: boolean;
  /**
   * Record the run as `lastIndexedAt` (default true). False when indexing only some adapters, which
   * must not make the rest look fresh.
   */
  record?: boolean;
}

/** Failures kept with their message; the rest are only counted. */
export const MAX_FAILURES = 20;

/** Version recorded while a source is partly indexed, so the next run resumes it. */
const INCOMPLETE_VERSION = "";

/** Records are cut to this length before redaction, bounding its cost. */
export const MAX_RECORD_CHARS = 1_000_000;
export const TRUNCATED_MARKER = "\n[TRUNCATED: record over 1 MB]";

function truncate(text: string): string {
  if (text.length <= MAX_RECORD_CHARS) return text;
  let end = MAX_RECORD_CHARS;
  // Do not cut between the two halves of a surrogate pair.
  const before = text.charCodeAt(end - 1);
  if (before >= 0xd800 && before <= 0xdbff) end -= 1;
  return text.slice(0, end) + TRUNCATED_MARKER;
}

const prepareRecord = (r: SourceRecord): SourceRecord => ({
  ...r,
  project: normalizeProject(r.project) ?? "",
  text: redact(truncate(r.text)),
});

/**
 * Index what changed in every adapter's sources, then archive sources that no longer exist.
 * Failing sources are counted and skipped; `lastIndexedAt` is set only on a complete run.
 */
export async function indexAll(
  store: Store,
  adapters: Adapter[],
  options: IndexOptions = {},
): Promise<IndexStats> {
  const stats: IndexStats = {
    sources: 0,
    chunks: 0,
    skipped: 0,
    archived: 0,
    resets: 0,
    missing: [],
    errors: 0,
    failures: [],
    complete: true,
  };
  const fail = (source: string, error: unknown) => {
    stats.errors++;
    if (stats.failures.length < MAX_FAILURES) {
      stats.failures.push({ source, message: errorMessage(error) });
    }
  };
  const expired = () => options.deadline !== undefined && Date.now() >= options.deadline;
  const stopped = () => ({ ...stats, complete: false });

  for (const adapter of adapters) {
    if (expired()) return stopped();
    const discovery = await discoverSafely(adapter, fail);
    if (!discovery) continue;
    const { sources } = discovery;
    if (discovery.missingRoot)
      stats.missing.push({ tool: adapter.tool, root: discovery.missingRoot });

    for (const [i, source] of sources.entries()) {
      if (expired()) return stopped();
      options.onProgress?.({ tool: adapter.tool, done: i + 1, total: sources.length });
      const outcome = await indexSource(store, adapter, source, options, expired);
      options.heartbeat?.();
      if (outcome.status === "failed") fail(source.id, outcome.error);
      else if (outcome.status !== "unchanged") stats.sources++;
      stats.chunks += outcome.chunks;
      stats.skipped += outcome.skipped;
      if (outcome.reset) stats.resets++;
      if (outcome.status === "partial") return stopped();
    }

    if (expired()) return stopped();
    // Some sources could not be listed: missing ones may still exist, keep them.
    if (discovery.complete) stats.archived += archiveMissing(store, adapter, sources);
  }

  if (options.maintain && stats.resets > 0) store.optimize();
  if (options.record !== false) store.setMeta("lastIndexedAt", new Date().toISOString());
  return stats;
}

/** The adapter's sources, or undefined when listing failed; an incomplete list is an error. */
async function discoverSafely(
  adapter: Adapter,
  fail: (source: string, error: unknown) => void,
): Promise<Discovery | undefined> {
  try {
    const discovery = await adapter.discover();
    if (!discovery.complete) fail(adapter.tool, "some sources could not be listed");
    return discovery;
  } catch (error) {
    // Without a complete list we cannot tell deleted sources apart, so nothing is pruned.
    fail(adapter.tool, error);
    return undefined;
  }
}

interface SourceOutcome {
  /** "partial" (deadline) and "failed" both resume from the last checkpoint next run. */
  status: "unchanged" | "done" | "partial" | "failed";
  /** Counts of the batches saved, even if the source then failed. */
  chunks: number;
  skipped: number;
  reset?: boolean;
  error?: unknown;
}

const UNCHANGED: SourceOutcome = { status: "unchanged", chunks: 0, skipped: 0 };

/** Index what is new in one source, saving a checkpoint after every batch. Never throws. */
async function indexSource(
  store: Store,
  adapter: Adapter,
  source: SourceRef,
  options: IndexOptions,
  expired: () => boolean,
): Promise<SourceOutcome> {
  const outcome: SourceOutcome = { status: "done", chunks: 0, skipped: 0 };
  try {
    const stored = store.getSource(source.id);
    if (stored?.version === source.version) return UNCHANGED;
    // An archived transcript that exists again is read in full, replacing the archived chunks.
    const revived = stored?.version === ARCHIVED_VERSION;
    const previous = revived ? undefined : stored;
    const row = { id: source.id, tool: adapter.tool, checkpoint: previous?.checkpoint ?? null };
    // Each save checks the stored checkpoint is still the one this run read: another process
    // indexing the same source meanwhile would otherwise append the same lines twice.
    let expectedCheckpoint = stored?.checkpoint;
    let first = true;
    const batches = adapter.read(source, previous?.checkpoint, { batchSize: options.batchSize });
    for await (const batch of batches) {
      // Redaction happens here, in the core, so that it applies to every adapter alike.
      const chunks = chunkRecords(batch.records.map(prepareRecord));
      row.checkpoint = batch.checkpoint;
      const reset = batch.reset || (revived && first);
      store.saveSource({ ...row, version: INCOMPLETE_VERSION }, chunks, {
        reset,
        expectedCheckpoint,
      });
      expectedCheckpoint = row.checkpoint;
      first = false;
      if (reset && stored) outcome.reset = true;
      outcome.chunks += chunks.length;
      outcome.skipped += batch.skipped;
      options.heartbeat?.();
      if (expired()) return { ...outcome, status: "partial" };
    }
    store.saveSource({ ...row, version: source.version }, [], {
      reset: revived && first,
      expectedCheckpoint,
    });
    return outcome;
  } catch (error) {
    // Another process saved this source meanwhile: resume from its checkpoint next run.
    if (error instanceof CheckpointConflictError) return { ...outcome, status: "partial" };
    return { ...outcome, status: "failed", error };
  }
}

/**
 * Archive indexed sources of the tool that were not discovered; returns how many. Those of an
 * adapter that does not archive are removed instead (and not counted).
 */
function archiveMissing(store: Store, adapter: Adapter, sources: SourceRef[]): number {
  const present = new Set(sources.map((s) => s.id));
  let archived = 0;
  for (const id of store.listSourceIds(adapter.tool)) {
    if (present.has(id)) continue;
    if (adapter.archiveDeleted === false) {
      store.removeSource(id);
      continue;
    }
    store.archiveSource(id);
    archived++;
  }
  return archived;
}
