import { randomUUID } from "node:crypto";
import {
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { errnoCode } from "./errors.js";

const STALE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
/** Indexers call `touch` after every batch; throttle the mtime writes. */
const TOUCH_INTERVAL_MS = 1000;

/** Test seam: `beforeTakeover` runs just before a stale lock is taken over. */
export interface LockOptions {
  beforeTakeover?: () => void;
}

interface Holder {
  raw: string;
  mtimeMs: number;
}

/**
 * Returns `undefined` if a live holder has the lock. A lock whose process is gone, or without a
 * readable pid that went unrefreshed for STALE_MS, is taken over, so long-running `fn`s must call
 * `touch()`. `touch()` throws once the lock was lost, so the holder stops writing.
 */
export async function withLock<T>(
  path: string,
  fn: (touch: () => void) => Promise<T>,
  options: LockOptions = {},
): Promise<T | undefined> {
  const token = randomUUID();
  if (!tryAcquire(path, token, options)) return undefined;
  let touchedAt = Number.NEGATIVE_INFINITY;
  let lost: Error | undefined;
  const throttledTouch = () => {
    if (lost) throw lost;
    const now = Date.now();
    if (now - touchedAt < TOUCH_INTERVAL_MS) return;
    touchedAt = now;
    try {
      touch(path, token);
    } catch (error) {
      lost = error instanceof Error ? error : new Error(String(error));
      throw lost;
    }
  };
  try {
    return await fn(throttledTouch);
  } finally {
    release(path, token);
  }
}

function tryAcquire(path: string, token: string, options: LockOptions): boolean {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, token }), {
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
    const holder = readHolder(path);
    if (!holder) continue; // released meanwhile
    if (!isStale(holder)) return false;
    options.beforeTakeover?.();
    if (!removeStale(path, token, holder)) return false;
  }
  return false;
}

/** Rename aside so only one contender removes it; put back a lock replaced meanwhile. */
function removeStale(path: string, token: string, holder: Holder): boolean {
  const aside = `${path}.${token}.stale`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return true;
    throw error;
  }
  const raw = readFileSync(aside, "utf8");
  if (raw !== holder.raw) putBack(aside, path, raw);
  rmSync(aside, { force: true });
  return raw === holder.raw;
}

/**
 * Restore a newer holder's lock moved aside by mistake, unless another contender already created
 * one (EEXIST). Without hard links, recreate it exclusively with the same content (pid, token).
 * On any other failure the aside copy is kept and the error thrown; that holder's next `touch`
 * then reports the lost lock.
 */
function putBack(aside: string, path: string, raw: string): void {
  try {
    linkSync(aside, path);
    return;
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return;
  }
  try {
    writeFileSync(path, raw, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
  }
}

function readHolder(path: string): Holder | undefined {
  try {
    const { mtimeMs } = statSync(path);
    return { raw: readFileSync(path, "utf8"), mtimeMs };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * A holder whose process is alive is never stale, even unrefreshed for long (its machine may
 * have slept). The mtime rule only covers a lock without a pid, e.g. empty right after creation.
 */
function isStale(holder: Holder): boolean {
  const pid = parseHolder(holder.raw)?.pid;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return !isAlive(pid);
  return Date.now() - holder.mtimeMs >= STALE_MS;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return errnoCode(error) !== "ESRCH";
  }
}

function touch(path: string, token: string): void {
  const holder = readHolder(path);
  if (parseHolder(holder?.raw ?? "")?.token !== token) {
    throw new Error(`agentlore lost the index lock at ${path}; another indexer took it over.`);
  }
  const now = new Date();
  utimesSync(path, now, now);
}

function release(path: string, token: string): void {
  const holder = readHolder(path);
  if (holder && parseHolder(holder.raw)?.token === token) rmSync(path, { force: true });
}

function parseHolder(raw: string): { pid?: unknown; token?: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}
