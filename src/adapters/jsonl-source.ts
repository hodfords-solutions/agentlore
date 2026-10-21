import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { z } from "zod";
import { errnoCode } from "../core/errors.js";
import type {
  Adapter,
  Checkpoint,
  Discovery,
  ReadBatch,
  ReadOptions,
  SourceRecord,
  SourceRef,
  Tool,
} from "../core/types.js";
import { findFiles } from "./fs.js";
import { readLineBatches, type SkipLine } from "./lines.js";

/** Per-file values a parser keeps between incremental reads. */
export type FileState = Record<string, string>;

export interface ParseResult {
  records: SourceRecord[];
  /** Lines that were not valid JSON or did not match the schema. */
  skipped: number;
}

export type ParseLines = (lines: string[], file: string, state: FileState) => ParseResult;

export interface JsonlAdapterOptions {
  tool: Tool;
  root: string;
  parseLines: ParseLines;
  /** Cheap raw-bytes pre-filter; must never drop a line that would yield a record. */
  skipLine?: SkipLine;
}

/** Leading bytes hashed to notice a file that was rewritten (not appended to) in place. */
const HEAD_BYTES = 1024;

const JsonlCheckpoint = z.object({
  offset: z.number().int().nonnegative(),
  /** A smaller file now was truncated or rewritten. */
  size: z.number().int().nonnegative(),
  headHash: z.string(),
  headLen: z.number().int().nonnegative(),
  state: z.record(z.string(), z.string()),
});
type JsonlCheckpoint = z.infer<typeof JsonlCheckpoint>;

const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");

/**
 * Each JSONL file is a source read incrementally from a byte offset; a file that shrank or whose
 * first bytes changed is read again from the start (`reset`).
 */
export function jsonlAdapter({ tool, root, parseLines, skipLine }: JsonlAdapterOptions): Adapter {
  return {
    tool,
    discover: () => discoverFiles(root),
    read: (source, checkpoint, options) =>
      readFile(source, checkpoint, options, parseLines, skipLine),
  };
}

async function discoverFiles(root: string): Promise<Discovery> {
  const { files, complete, rootMissing } = await findFiles(root, ".jsonl");
  const discovery: Discovery = { sources: [], complete };
  if (rootMissing) discovery.missingRoot = root;
  for (const path of files) {
    try {
      const info = await stat(path);
      discovery.sources.push({ id: path, version: `${info.size}:${Math.trunc(info.mtimeMs)}` });
    } catch (error) {
      // A file deleted since the listing is simply gone; any other failure may hide a file.
      if (errnoCode(error) !== "ENOENT") discovery.complete = false;
    }
  }
  return discovery;
}

async function* readFile(
  source: SourceRef,
  checkpoint: Checkpoint | undefined,
  { batchSize }: ReadOptions,
  parseLines: ParseLines,
  skipLine: SkipLine | undefined,
): AsyncGenerator<ReadBatch> {
  const path = source.id;
  const { size } = await stat(path);
  const previous = JsonlCheckpoint.safeParse(checkpoint).data;
  const head = await readHead(path, Math.min(HEAD_BYTES, size));
  const resumable = previous && size >= previous.size && !headChanged(previous, head);
  const reset = !resumable;
  const state: FileState = { ...(resumable ? previous.state : {}) };
  const headHash = sha1(head);
  const at = (offset: number): JsonlCheckpoint => ({
    offset,
    size,
    headHash,
    headLen: head.length,
    state: { ...state },
  });

  let offset = resumable ? previous.offset : 0;
  let isFirstBatch = true;
  for await (const batch of readLineBatches(path, offset, { maxLines: batchSize, skipLine })) {
    const { records, skipped } = parseLines(batch.lines, path, state);
    offset = batch.offset;
    yield {
      records,
      skipped: skipped + batch.skipped,
      checkpoint: at(offset),
      reset: reset && isFirstBatch,
    };
    isFirstBatch = false;
  }
  // No new line: still record the new head and size (and clear the file on a reset).
  if (isFirstBatch) yield { records: [], skipped: 0, checkpoint: at(offset), reset };
}

async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function headChanged(previous: JsonlCheckpoint, head: Buffer): boolean {
  if (previous.headLen === 0) return false;
  return (
    head.length < previous.headLen || sha1(head.subarray(0, previous.headLen)) !== previous.headHash
  );
}
