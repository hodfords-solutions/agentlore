import { createReadStream } from "node:fs";

const NEWLINE = 0x0a;

const DEFAULT_BATCH_LINES = 500;

/** A single transcript line can be several MB, so a line count alone does not bound memory. */
const DEFAULT_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * Longer lines are dropped (counted as skipped) rather than buffered and decoded whole: far above
 * the 1 MB of text the indexer keeps of a record, far below V8's string limit.
 */
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/** True for a raw line (without "\n") with nothing to index; skips decoding and parsing it. */
export type SkipLine = (raw: Buffer) => boolean;

interface BatchOptions {
  maxLines?: number;
  maxBytes?: number;
  maxLineBytes?: number;
  skipLine?: SkipLine;
}

interface LineBatch {
  lines: string[];
  offset: number;
  /** Lines dropped for being longer than `maxLineBytes`. */
  skipped: number;
}

/**
 * Stream complete lines from byte `offset` in batches bounded by `maxLines` and `maxBytes`.
 * A final line without "\n" is left for the next call: the writer may still be appending.
 */
export async function* readLineBatches(
  path: string,
  offset: number,
  {
    maxLines = DEFAULT_BATCH_LINES,
    maxBytes = DEFAULT_BATCH_BYTES,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    skipLine,
  }: BatchOptions = {},
): AsyncGenerator<LineBatch> {
  if (maxLines < 1) throw new RangeError(`maxLines must be at least 1, got ${maxLines}`);
  if (maxBytes < 1) throw new RangeError(`maxBytes must be at least 1, got ${maxBytes}`);
  if (maxLineBytes < 1) {
    throw new RangeError(`maxLineBytes must be at least 1, got ${maxLineBytes}`);
  }
  let lines: string[] = [];
  let skipped = 0;
  let bytesInBatch = 0;
  let position = offset;
  let yielded = offset;
  // Concatenated once when "\n" arrives, so a very long line costs O(n), not O(n^2).
  let pending: Buffer[] = [];
  // Bytes of the current line so far, buffered in `pending` unless it is too long.
  let lineBytes = 0;

  for await (const chunk of createReadStream(path, { start: offset }) as AsyncIterable<Buffer>) {
    let start = 0;
    let newline = chunk.indexOf(NEWLINE, start);
    while (newline !== -1) {
      const piece = chunk.subarray(start, newline);
      lineBytes += piece.length;
      position += lineBytes + 1;
      if (lineBytes > maxLineBytes) {
        skipped++;
      } else {
        const bytes = pending.length ? Buffer.concat([...pending, piece]) : piece;
        let line = skipLine?.(bytes) ? "" : bytes.toString("utf8");
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.trim() !== "") {
          lines.push(line);
          bytesInBatch += bytes.length;
        }
      }
      pending = [];
      lineBytes = 0;
      if (lines.length >= maxLines || bytesInBatch >= maxBytes) {
        yield { lines, offset: position, skipped };
        yielded = position;
        lines = [];
        skipped = 0;
        bytesInBatch = 0;
      }
      start = newline + 1;
      newline = chunk.indexOf(NEWLINE, start);
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      lineBytes += tail.length;
      // Drop what was buffered once the line is too long; only its length is still counted.
      if (lineBytes > maxLineBytes) pending = [];
      else pending.push(tail);
    }
  }
  if (lines.length || position !== yielded) yield { lines, offset: position, skipped };
}
