import { createHash } from "node:crypto";
import type { Chunk, SourceRecord } from "./types.js";

/** ~800 tokens. */
const MAX_CHUNK_CHARS = 3200;
const SEPARATOR = "\n\n";
/** Leaves room for text after the longest role prefix ("assistant: "). */
const MIN_CHUNK_CHARS = 32;

const prefix = (r: SourceRecord) => (r.role ? `${r.role}: ` : "");
const format = (r: SourceRecord) => prefix(r) + r.text;
/** A session, else a document, else the whole source. */
const groupOf = (r: SourceRecord) => r.sessionId ?? r.title ?? "";
const isSidechain = (r: SourceRecord) => r.meta?.sidechain === true;

function splitOversized(r: SourceRecord, max: number): SourceRecord[] {
  if (format(r).length <= max) return [r];
  const size = max - prefix(r).length;
  const parts: SourceRecord[] = [];
  let start = 0;
  while (start < r.text.length) {
    let end = Math.min(start + size, r.text.length);
    // Do not split a surrogate pair.
    const before = r.text.charCodeAt(end - 1);
    if (end < r.text.length && before >= 0xd800 && before <= 0xdbff) end -= 1;
    parts.push({ ...r, text: r.text.slice(start, end) });
    start = end;
  }
  return parts;
}

/** Pack consecutive records of one source sharing kind, group, project and side chain. */
export function chunkRecords(records: SourceRecord[], max = MAX_CHUNK_CHARS): Chunk[] {
  if (max < MIN_CHUNK_CHARS) {
    throw new RangeError(`max must be at least ${MIN_CHUNK_CHARS} characters, got ${max}`);
  }
  const chunks: Chunk[] = [];
  let current: SourceRecord[] = [];
  let length = 0;

  const flush = () => {
    const head = current[0];
    const tail = current[current.length - 1];
    if (!head || !tail) return;
    chunks.push({
      kind: head.kind,
      tool: head.tool,
      sessionId: groupOf(head),
      project: head.project,
      startedAt: head.timestamp,
      endedAt: tail.timestamp,
      text: current.map(format).join(SEPARATOR),
      ...(isSidechain(head) ? { sidechain: true } : {}),
    });
    current = [];
    length = 0;
  };
  const continuesChunk = (part: SourceRecord) => {
    const head = current[0];
    return (
      !head ||
      (head.kind === part.kind &&
        groupOf(head) === groupOf(part) &&
        head.project === part.project &&
        isSidechain(head) === isSidechain(part))
    );
  };

  for (const record of records) {
    for (const part of splitOversized(record, max)) {
      const partLength = format(part).length;
      if (
        current.length &&
        (!continuesChunk(part) || length + SEPARATOR.length + partLength > max)
      ) {
        flush();
      }
      length = current.length ? length + SEPARATOR.length + partLength : partLength;
      current.push(part);
    }
  }
  flush();
  return chunks;
}

/**
 * Content address, so a re-index keeps the ids of unchanged chunks. Not a stable position:
 * boundaries depend on batching.
 */
/** The key of a chunk's text alone, whatever its source (see docs/adr/0001, rule 5). */
export function textHash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export function chunkKey(sourceId: string, text: string): string {
  return createHash("sha1").update(`${sourceId}\0${text}`).digest("hex");
}
