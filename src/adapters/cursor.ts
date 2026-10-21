import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import { errnoCode, errorMessage } from "../core/errors.js";
import type {
  Adapter,
  Checkpoint,
  Discovery,
  ReadBatch,
  ReadOptions,
  SourceRecord,
  SourceRef,
} from "../core/types.js";
import { parseJson } from "./fs.js";

const TOOL = "cursor";
const PREFIX = `${TOOL}:`;

/** Messages (bubbles) looked up per batch: bounds memory on very long conversations. */
const DEFAULT_BATCH_MESSAGES = 200;
/** A Lexical `richText` larger than this is not parsed (it is only a fallback for empty text). */
const MAX_RICH_TEXT_CHARS = 1_000_000;

/** Cursor's `User` folder, holding `globalStorage/state.vscdb` and `workspaceStorage/`. */
export function cursorUserDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Cursor", "User");
  if (platform === "win32") {
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "User");
  }
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Cursor", "User");
}

export interface OpenedDb {
  db: Database.Database;
  /** "readonly" sees Cursor's WAL writes; "immutable" uses no locks or side files, may be stale. */
  mode: "readonly" | "immutable";
}

/**
 * Called when Cursor's database could only be opened as immutable while Cursor may be writing, or
 * when a workspace could not be read for an unexpected reason.
 */
export type StaleWarning = (message: string) => void;

/** A `StaleWarning` printing each distinct message once on stderr (stdout carries MCP messages). */
function warnOnce(): StaleWarning {
  const seen = new Set<string>();
  return (message) => {
    if (seen.has(message)) return;
    seen.add(message);
    console.error(message);
  };
}

/** The SQLite or file system error code of `error`, or of the error it wraps. */
const codeOf = (error: unknown): string | undefined =>
  errnoCode(error) ?? (error instanceof Error ? errnoCode(error.cause) : undefined);

const probe = (db: Database.Database) => db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();

function openImmutable(path: string): Database.Database {
  let db: Database.Database | undefined;
  try {
    db = new Database(`${pathToFileURL(path).href}?immutable=1`, {
      readonly: true,
      fileMustExist: true,
    });
    probe(db);
    return db;
  } catch (error) {
    db?.close();
    throw new Error(
      `cannot open ${path} as immutable (SQLite URI filenames need SQLITE_USE_URI=1): ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * Open a Cursor database without creating any file next to it: a plain read-only connection would
 * create `-wal`/`-shm` files, so it is used only when both exist; otherwise it opens immutable (and
 * `warn`s if a `-wal` exists). Immutable needs `SQLITE_USE_URI=1` set before better-sqlite3 loads.
 */
export function openCursorDb(path: string, warn: StaleWarning = warnOnce()): OpenedDb {
  if (!existsSync(`${path}-wal`)) return { db: openImmutable(path), mode: "immutable" };
  let reason = "its -shm file is missing";
  if (existsSync(`${path}-shm`)) {
    let db: Database.Database | undefined;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
      db.pragma("query_only = ON");
      probe(db);
      return { db, mode: "readonly" };
    } catch (error) {
      db?.close();
      reason = errorMessage(error);
    }
  }
  const immutable = openImmutable(path);
  warn(
    `cursor: ${path} could not be opened read-only (${reason}); read as immutable, results may be stale while Cursor is running`,
  );
  return { db: immutable, mode: "immutable" };
}

function withDb<T>(path: string, warn: StaleWarning, fn: (db: Database.Database) => T): T {
  const { db } = openCursorDb(path, warn);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Keys of one prefix, as an index range scan (`LIKE` would scan the whole, large table). */
const range = (prefix: string) => [`${prefix}:`, `${prefix};`] as const;

/** Rows of `cursorDiskKV` as `(key, v)`, `v` the value as JSON text (a BLOB is read as text). */
const rows = (where: string) =>
  `(SELECT key, CAST(value AS TEXT) AS v FROM cursorDiskKV WHERE ${where})`;

/** Each composer's `[lastUpdatedAt, createdAt, headers type, headers count]`, parsing `v` once. */
const LIST_COMPOSERS = `
  SELECT substr(key, ${"composerData:".length + 1}) AS id,
         CASE WHEN json_valid(v) THEN
           json_array(json_extract(v, '$.lastUpdatedAt'), json_extract(v, '$.createdAt'),
                      json_type(v, '$.fullConversationHeadersOnly'),
                      json_array_length(v, '$.fullConversationHeadersOnly')) END AS fields
  FROM ${rows("key >= ? AND key < ?")} ORDER BY key`;

/** 1 when a header of the composer (first key) has no stored message (second key || bubbleId). */
const HAS_GAP = `
  SELECT EXISTS (
    SELECT 1 FROM cursorDiskKV AS c,
                  json_each(CAST(c.value AS TEXT), '$.fullConversationHeadersOnly') AS h
    WHERE c.key = ? AND NOT EXISTS (
      SELECT 1 FROM cursorDiskKV AS b WHERE b.key = ? || json_extract(h.value, '$.bubbleId'))
  ) AS gap`;

/** `fields` is NULL for a value that is not valid JSON; no row for a missing key. */
const GET_COMPOSER = `
  SELECT CASE WHEN json_valid(v) THEN
           json_extract(v, '$.name', '$.createdAt', '$.lastUpdatedAt',
                        '$.fullConversationHeadersOnly') END AS fields
  FROM ${rows("key = ?")}`;

/** Only indexed fields: a bubble's tool calls, diffs and file contents (MBs) stay in SQLite. */
const GET_BUBBLE = `
  SELECT CASE WHEN json_valid(v) THEN
           json_extract(v, '$.type', '$.text', '$.richText', '$.createdAt') END AS fields
  FROM ${rows("key = ?")}`;

const ComposerFields = z.tuple([z.unknown(), z.unknown(), z.unknown(), z.unknown()]);
const BubbleFields = z.tuple([z.unknown(), z.unknown(), z.unknown(), z.unknown()]);

const Headers = z.array(z.object({ bubbleId: z.string() }).loose());

/** A message a header points to, as read; `invalid` when its value is not valid JSON. */
type Bubble =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "ok"; type: unknown; text: string; createdAt: unknown };

/** Messages read so far; `lastHash` detects the last reply still being streamed into. */
const CursorCheckpoint = z.object({
  messages: z.number().int().nonnegative(),
  first: z.string(),
  last: z.string(),
  lastHash: z.string(),
});
type CursorCheckpoint = z.infer<typeof CursorCheckpoint>;

const ROLES: Record<number, SourceRecord["role"]> = { 1: "user", 2: "assistant" };

/** After this long without updates, a header's missing message is skipped instead of waited for. */
const SETTLE_MS = 24 * 60 * 60 * 1000;

/** Version of a composer whose value cannot be read: kept (not pruned) until it is readable. */
const MALFORMED_VERSION = "malformed";

export interface CursorAdapterOptions {
  /** Current time in epoch ms (injectable for tests). */
  now?: () => number;
  /** Where warnings go; by default each distinct one is printed once on stderr. */
  warn?: StaleWarning;
}

/**
 * Cursor conversations ("composers"), one source each, read incrementally. Only user and assistant
 * text is indexed; tool steps, tool output and thinking are not.
 */
export function createCursorAdapter(
  userDir = cursorUserDir(),
  { now = Date.now, warn = warnOnce() }: CursorAdapterOptions = {},
): Adapter {
  const globalDb = join(userDir, "globalStorage", "state.vscdb");
  const workspaces = join(userDir, "workspaceStorage");
  // Workspaces read so far, so a long-running MCP server re-reads only those whose files changed.
  const cache = new Map<string, WorkspaceEntry>();
  let projects: Map<string, string> | undefined;
  return {
    tool: TOOL,
    async discover() {
      if (!existsSync(globalDb)) return { sources: [], complete: true, missingRoot: globalDb };
      projects = mapProjects(workspaces, cache, warn);
      return withDb(globalDb, warn, (db) => listComposers(db, now()));
    },
    read(source, checkpoint, options) {
      projects ??= mapProjects(workspaces, cache, warn);
      return readComposer(globalDb, projects, source, checkpoint, options, now(), warn);
    },
  };
}

/**
 * One source per composer with messages. The version ends in `:gap` while a recent conversation
 * has a header without its message (so it changes when it arrives), and `:settled` once a day old.
 */
function listComposers(db: Database.Database, now: number): Discovery {
  const sources: SourceRef[] = [];
  const hasGap = db.prepare(HAS_GAP).pluck();
  const query = db.prepare(LIST_COMPOSERS);
  for (const row of query.iterate(...range("composerData")) as Iterable<{
    id: string;
    fields: string | null;
  }>) {
    const id = PREFIX + row.id;
    const [updated, created, headersType, messages] =
      (row.fields ? (parseJson(row.fields) as unknown[] | undefined) : undefined) ?? [];
    // Unreadable, but listed with a fixed version so its indexed data is not pruned.
    if (!row.fields || (headersType != null && headersType !== "array")) {
      sources.push({ id, version: MALFORMED_VERSION });
      continue;
    }
    // Empty drafts, and newer conversations kept only in an opaque form (no headers), are skipped.
    if (typeof messages !== "number" || messages === 0) continue;
    const time = typeof updated === "number" ? updated : Number(created) || 0;
    let state = "";
    if (now - time > SETTLE_MS) state = ":settled";
    else if (hasGap.get(`composerData:${row.id}`, `bubbleId:${row.id}:`)) state = ":gap";
    sources.push({ id, version: `${time}:${messages}${state}` });
  }
  return { sources, complete: true };
}

async function* readComposer(
  path: string,
  projects: Map<string, string>,
  source: SourceRef,
  checkpoint: Checkpoint | undefined,
  { batchSize = DEFAULT_BATCH_MESSAGES }: ReadOptions,
  now: number,
  warn: StaleWarning,
): AsyncGenerator<ReadBatch> {
  const composerId = source.id.slice(PREFIX.length);
  const { db } = openCursorDb(path, warn);
  try {
    const row = db.prepare(GET_COMPOSER).get(`composerData:${composerId}`) as
      | { fields: string | null }
      | undefined;
    if (!row) {
      // Deleted since discovery: nothing of it remains valid.
      yield { records: [], checkpoint: null, reset: true, skipped: 0 };
      return;
    }
    const fields = row.fields ? ComposerFields.safeParse(parseJson(row.fields)).data : undefined;
    const headers = fields ? Headers.safeParse(fields[3]).data : undefined;
    if (!fields || !headers) {
      // Unreadable now (perhaps caught mid-write): keep what was indexed, retry on next change.
      yield { records: [], checkpoint: checkpoint ?? null, reset: false, skipped: 1 };
      return;
    }
    const [name, created, updated] = fields;
    const ids = headers.map((h) => h.bubbleId);
    const getBubble = db.prepare(GET_BUBBLE);
    const bubble = (id: string): Bubble => {
      const found = getBubble.get(`bubbleId:${composerId}:${id}`) as
        | { fields: string | null }
        | undefined;
      if (!found) return { status: "missing" };
      const values = found.fields
        ? BubbleFields.safeParse(parseJson(found.fields)).data
        : undefined;
      if (!values) return { status: "invalid" };
      const [type, text, richText, createdAt] = values;
      return { status: "ok", type, text: messageText(text, richText), createdAt };
    };

    const previous = CursorCheckpoint.safeParse(checkpoint).data;
    const resumable = previous !== undefined && continues(previous, ids, bubble);
    const base: Omit<SourceRecord, "role" | "timestamp" | "text"> = {
      kind: "transcript",
      tool: TOOL,
      sessionId: composerId,
      project: projects.get(composerId) ?? "",
      ...(typeof name === "string" && name ? { title: name } : {}),
    };
    const fallbackTime = isoTime(created) ?? "";
    const lastUpdate = typeof updated === "number" ? updated : Number(created) || 0;
    const settled = now - lastUpdate > SETTLE_MS;

    let state: CursorCheckpoint = resumable
      ? { ...previous }
      : { messages: 0, first: ids[0] ?? "", last: "", lastHash: "" };
    let reset = !resumable;
    let isFirstBatch = true;
    while (state.messages < ids.length) {
      const end = Math.min(state.messages + Math.max(1, batchSize), ids.length);
      const records: SourceRecord[] = [];
      let skipped = 0;
      let waiting = false;
      while (state.messages < end) {
        const id = ids[state.messages] as string;
        const message = bubble(id);
        if (message.status === "missing") {
          // Cursor may store a header before its message: wait for it until settled.
          if (!settled) {
            waiting = true;
            break;
          }
        } else if (message.status === "invalid") {
          skipped++;
        } else {
          const role = typeof message.type === "number" ? ROLES[message.type] : undefined;
          // Tool steps and other messages without text yield nothing.
          if (role && message.text) {
            const timestamp = isoTime(message.createdAt) ?? fallbackTime;
            records.push({ ...base, role, timestamp, text: message.text });
          }
        }
        state = {
          ...state,
          messages: state.messages + 1,
          last: id,
          lastHash: fingerprint(message),
        };
      }
      yield { records, checkpoint: state, reset, skipped };
      reset = false;
      isFirstBatch = false;
      if (waiting) return;
    }
    if (isFirstBatch) yield { records: [], checkpoint: state, reset, skipped: 0 };
  } finally {
    db.close();
  }
}

/** What identifies a message's indexed content; changes while Cursor streams a reply into it. */
function fingerprint(message: Bubble): string {
  if (message.status !== "ok") return message.status;
  return createHash("sha1")
    .update(`${String(message.type)}\0${message.text}`)
    .digest("hex");
}

/** True when the checkpointed messages are still the conversation's prefix, the last unchanged. */
function continues(
  previous: CursorCheckpoint,
  ids: string[],
  bubble: (id: string) => Bubble,
): boolean {
  if (previous.messages === 0) return true;
  return (
    previous.messages <= ids.length &&
    ids[0] === previous.first &&
    ids[previous.messages - 1] === previous.last &&
    fingerprint(bubble(previous.last)) === previous.lastHash
  );
}

function messageText(text: unknown, richText: unknown): string {
  if (typeof text === "string" && text.trim()) return text.trim();
  if (typeof richText !== "string" || richText.length > MAX_RICH_TEXT_CHARS) return "";
  return lexicalText(parseJson(richText)).trim();
}

/** Plain text of a Lexical editor state: text nodes joined, one line per block. */
function lexicalText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const { root, text, children } = node as { root?: unknown; text?: unknown; children?: unknown };
  if (root) return lexicalText(root);
  if (typeof text === "string") return text;
  if (!Array.isArray(children)) return "";
  const isRoot = (node as { type?: unknown }).type === "root";
  return children.map(lexicalText).join(isRoot ? "\n" : "");
}

function isoTime(value: unknown): string | undefined {
  const time =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

const WorkspaceJson = z.object({ folder: z.string().optional(), workspace: z.string().optional() });
const ComposerList = z.object({
  allComposers: z.array(z.object({ composerId: z.string() }).loose()),
});

interface WorkspaceEntry {
  /** Changes whenever the workspace's files change: their sizes and modification times. */
  stamp: string;
  project: string | undefined;
  composerIds: string[];
}

function workspaceStamp(dir: string): string {
  return ["workspace.json", "state.vscdb", "state.vscdb-wal"]
    .map((file) => {
      try {
        const info = statSync(join(dir, file));
        return `${info.size}:${info.mtimeMs}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

/**
 * Conversation id → project folder: each `workspaceStorage/<hash>/workspace.json` names the folder
 * and its `state.vscdb` lists the conversations. Best effort. Remote folders get no project: their
 * paths are on another machine and must not be confused with a local folder of the same path.
 */
function mapProjects(
  root: string,
  cache: Map<string, WorkspaceEntry>,
  warn: StaleWarning,
): Map<string, string> {
  const projects = new Map<string, string>();
  let hashes: string[];
  try {
    hashes = readdirSync(root).sort();
  } catch (error) {
    if (codeOf(error) !== "ENOENT") {
      warn(`cursor: cannot list ${root}, conversations get no project: ${errorMessage(error)}`);
    }
    return projects;
  }
  const previous = new Map(cache);
  cache.clear();
  for (const hash of hashes) {
    const dir = join(root, hash);
    const stamp = workspaceStamp(dir);
    let entry = previous.get(hash);
    if (entry?.stamp !== stamp) {
      const read = readWorkspace(dir, warn);
      entry = read && { stamp, ...read };
    }
    // A workspace that could not be read is not cached: it is read again next time.
    if (!entry) continue;
    cache.set(hash, entry);
    if (!entry.project) continue;
    for (const composerId of entry.composerIds) projects.set(composerId, entry.project);
  }
  return projects;
}

/** Codes of a workspace being created, written or removed, or of a stray file such as .DS_Store. */
const TRANSIENT = new Set(["ENOENT", "ENOTDIR", "SQLITE_BUSY"]);

/** The workspace's folder and conversations; undefined when it could not be read. */
function readWorkspace(dir: string, warn: StaleWarning): Omit<WorkspaceEntry, "stamp"> | undefined {
  try {
    const project = workspaceFolder(join(dir, "workspace.json"));
    if (!project) return { project, composerIds: [] };
    const path = join(dir, "state.vscdb");
    // Not created yet: opening it as immutable would only fail with a less precise code.
    if (!existsSync(path)) return undefined;
    const value = withDb(path, warn, (db) =>
      db
        .prepare("SELECT CAST(value AS TEXT) AS value FROM ItemTable WHERE key = ?")
        .get("composer.composerData"),
    ) as { value: string } | undefined;
    const list = ComposerList.safeParse(parseJson(value?.value ?? "")).data;
    return { project, composerIds: (list?.allComposers ?? []).map((c) => c.composerId) };
  } catch (error) {
    // Retried next discovery either way.
    if (!TRANSIENT.has(codeOf(error) ?? "")) {
      warn(`cursor: cannot read workspace ${dir}: ${errorMessage(error)}`);
    }
    return undefined;
  }
}

function workspaceFolder(path: string): string | undefined {
  const json = WorkspaceJson.safeParse(parseJson(readFileSync(path, "utf8"))).data;
  if (json?.folder) return uriPath(json.folder);
  if (json?.workspace) {
    const file = uriPath(json.workspace);
    return file ? dirname(file) : undefined;
  }
  return undefined;
}

/**
 * Local path of a `file://` URI, with an upper-case drive letter on Windows (VS Code writes
 * `c%3A`, other tools `C:`). Undefined for remote and malformed URIs.
 */
export function uriPath(uri: string, windows = process.platform === "win32"): string | undefined {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return undefined;
    const path = fileURLToPath(url, { windows });
    return windows ? path.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : path;
  } catch {
    return undefined;
  }
}
