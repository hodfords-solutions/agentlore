import { labelField, SHORT_ID_LENGTH } from "./format.js";
import type { Store } from "./store.js";
import type { StoredChunk } from "./types.js";

export const DEFAULT_AROUND = 1;
export const MAX_AROUND = 3;
/** A whole chunk (MAX_CHUNK_CHARS in chunk.ts). */
const TARGET_CHARS = 3200;
const PER_SIDE_CHARS = 2800;
/** ~3,000 tokens. */
export const MAX_CONTEXT_CHARS = 12_000;

/** Text budget for `around` chunks per side, capped at MAX_CONTEXT_CHARS. */
export const contextChars = (around: number): number =>
  Math.min(MAX_CONTEXT_CHARS, TARGET_CHARS + PER_SIDE_CHARS * around);
const MIN_ID_LENGTH = 6;
const ID = new RegExp(`^([0-9a-f]{${MIN_ID_LENGTH},40})(#[1-9]\\d{0,5})?$`);

export type ContextResult = { ok: true; chunks: StoredChunk[] } | { ok: false; message: string };

const TRUNCATED = "…";

/**
 * The chunk with this id (any key prefix) and up to `around` same-session neighbours per side,
 * nearest first while they fit in `contextChars(around)`.
 */
export function getContext(store: Store, id: string, around = DEFAULT_AROUND): ContextResult {
  const match = ID.exec(id.trim().toLowerCase());
  if (!match?.[1]) {
    return {
      ok: false,
      message: `Invalid id "${labelField(id.slice(0, 64))}": pass the ${SHORT_ID_LENGTH}-character id of a search result, e.g. 1a2b3c4d.`,
    };
  }
  const keys = store.findChunkKeys(match[1], match[2]);
  if (keys.length === 0) {
    return {
      ok: false,
      message: `No chunk with id ${match[0]}; the index may have changed since the search. Search again.`,
    };
  }
  if (keys.length > 1) {
    return { ok: false, message: `Id ${match[0]} matches several chunks; pass more characters.` };
  }
  const key = keys[0] as string;
  const side = Math.max(0, Math.min(MAX_AROUND, around));
  const all = store.getNeighbours(key, side);
  const index = all.findIndex((c) => c.chunkId === key);
  const target = all[index];
  if (!target) return { ok: false, message: `No chunk with id ${match[0]}.` };
  const sameSession = (c: StoredChunk | undefined) => c?.sessionId === target.sessionId;

  let budget = contextChars(side);
  const take = (c: StoredChunk): StoredChunk | undefined => {
    if (c.text.length > budget) return undefined;
    budget -= c.text.length;
    return c;
  };
  const first =
    target.text.length > budget
      ? { ...target, text: target.text.slice(0, budget - TRUNCATED.length) + TRUNCATED }
      : target;
  budget -= first.text.length;
  const before: StoredChunk[] = [];
  const after: StoredChunk[] = [];
  let [b, a] = [index - 1, index + 1];
  let [bOpen, aOpen] = [true, true];
  while (bOpen || aOpen) {
    if (bOpen) {
      const c = all[b--];
      const kept = sameSession(c) && c ? take(c) : undefined;
      if (kept) before.unshift(kept);
      else bOpen = false;
    }
    if (aOpen) {
      const c = all[a++];
      const kept = sameSession(c) && c ? take(c) : undefined;
      if (kept) after.push(kept);
      else aOpen = false;
    }
  }
  return { ok: true, chunks: [...before, first, ...after] };
}
