import { errorMessage } from "./errors.js";
import { indexAll } from "./indexer.js";
import { withLock } from "./lock.js";
import type { Store } from "./store.js";
import type { Adapter } from "./types.js";

export const STALE_AFTER_MS = 10 * 60 * 1000;
/** Well under MCP client timeouts; the refresh resumes next time. */
export const REFRESH_BUDGET_MS = 8 * 1000;

export interface Runtime {
  store: Store;
  adapters: Adapter[];
  lockPath: string;
}

export type Freshness =
  | "never-indexed"
  | "fresh"
  | "refreshed"
  | "partial"
  | "busy"
  | "refresh-failed";

const STALE_NOTES: Partial<Record<Freshness, string>> = {
  busy: "(note: index refresh in progress; results may be slightly stale)",
  partial: "(note: index refresh not finished yet; results may be slightly stale)",
  "refresh-failed": "(note: index refresh failed; results may be stale)",
};

export function freshnessNote(freshness: Freshness): string | undefined {
  return STALE_NOTES[freshness];
}

const isFresh = (last: string) => Date.now() - Date.parse(last) < STALE_AFTER_MS;

/**
 * Incrementally re-index a stale index within `budgetMs`. Never runs the first full backfill (too
 * slow for an MCP call) and never throws, so callers can still search the existing index.
 */
export async function ensureFresh(
  { store, adapters, lockPath }: Runtime,
  { budgetMs = REFRESH_BUDGET_MS }: { budgetMs?: number } = {},
): Promise<Freshness> {
  try {
    const last = store.getMeta("lastIndexedAt");
    if (!last) return "never-indexed";
    if (isFresh(last)) return "fresh";
    const deadline = Date.now() + budgetMs;
    const result = await withLock(lockPath, async (touch): Promise<Freshness> => {
      // Another process may have refreshed it meanwhile.
      const current = store.getMeta("lastIndexedAt");
      if (current && isFresh(current)) return "fresh";
      const stats = await indexAll(store, adapters, { heartbeat: touch, deadline });
      return stats.complete ? "refreshed" : "partial";
    });
    return result ?? "busy";
  } catch (error) {
    console.error(`agentlore: index refresh failed: ${errorMessage(error)}`);
    return "refresh-failed";
  }
}
