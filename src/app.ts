import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createAntigravityAdapter } from "./adapters/antigravity.js";
import { createClaudeAdapter } from "./adapters/claude.js";
import { createClaudeHistoryAdapter } from "./adapters/claude-history.js";
import { createCodexAdapter } from "./adapters/codex.js";
import { createCursorAdapter } from "./adapters/cursor.js";
import { createMemoryAdapter } from "./adapters/memory.js";
import { type ResolvedMode, readModeState, resolveMode } from "./core/mode.js";
import type { Runtime } from "./core/runtime.js";
import { openStore, type Store } from "./core/store.js";
import type { Adapter } from "./core/types.js";

/**
 * AGENTLORE_HOME or ~/.agentlore, absolute: SQLite accepts `file:` URIs (for Cursor's database),
 * and an absolute path is never taken for one.
 */
export function loreHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AGENTLORE_HOME ?? join(homedir(), ".agentlore"));
}

export function indexPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(loreHome(env), "index.db");
}

/** A user's own decision and correction words (see `loadExtraWords`). */
export function wordsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(loreHome(env), "words.json");
}

/** Project memory notes (docs/adr/0004): user data, never rebuilt. */
export function memoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(loreHome(env), "memory");
}

export function modePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(loreHome(env), "mode.json");
}

/** The effective knowledge mode for a folder; "off" when the mode file is missing or invalid. */
export function currentMode(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMode {
  return resolveMode(readModeState(modePath(env)), cwd);
}

/** The existing index opened read-only, or undefined; creates nothing. */
export function openIndexReadOnly(env: NodeJS.ProcessEnv = process.env): Store | undefined {
  const path = indexPath(env);
  return existsSync(path) ? openStore(path, { readonly: true }) : undefined;
}

/**
 * Adapters for every supported tool; AGENTLORE_<TOOL>_DIR overrides each data location. With a
 * store, Claude Code's prompt history skips sessions it already has from transcripts.
 */
export function defaultAdapters(env: NodeJS.ProcessEnv = process.env, store?: Store): Adapter[] {
  const claudeDir = env.AGENTLORE_CLAUDE_DIR || join(homedir(), ".claude", "projects");
  return [
    createClaudeAdapter(claudeDir),
    createClaudeHistoryAdapter(
      env.AGENTLORE_CLAUDE_HISTORY || join(dirname(claudeDir), "history.jsonl"),
      claudeDir,
      () => store?.sessionIds("claude") ?? new Set(),
    ),
    createCodexAdapter(env.AGENTLORE_CODEX_DIR || undefined),
    createCursorAdapter(env.AGENTLORE_CURSOR_DIR || undefined),
    createAntigravityAdapter(env.AGENTLORE_ANTIGRAVITY_DIR || undefined),
    createMemoryAdapter(memoryPath(env)),
  ];
}

const POSIX = process.platform !== "win32";
/** The index holds excerpts of every transcript: only the owner may read it. */
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

function withPrivateUmask<T>(fn: () => T): T {
  if (!POSIX) return fn();
  let previous: number | undefined;
  try {
    previous = process.umask(0o077);
  } catch {
    // process.umask cannot be changed in worker threads; files are chmodded afterwards anyway.
  }
  try {
    return fn();
  } finally {
    if (previous !== undefined) process.umask(previous);
  }
}

/** `home` is chmodded only when agentlore created it: it may be a shared folder such as ~/Documents. */
function restrictPermissions(home: string | undefined, files: string[]): void {
  if (!POSIX) return;
  if (home) chmodSync(home, PRIVATE_DIR);
  for (const file of files) if (existsSync(file)) chmodSync(file, PRIVATE_FILE);
}

/**
 * Composition root for the CLI and MCP server: opens (creating if needed) the index with the
 * default adapters, a newly created home 0700 and files 0600. The caller must close the store.
 */
export function openDefault(env: NodeJS.ProcessEnv = process.env): Runtime {
  const home = loreHome(env);
  const dbPath = indexPath(env);
  const lockPath = join(home, "index.lock");
  const created = mkdirSync(home, { recursive: true, mode: PRIVATE_DIR });
  const store = withPrivateUmask(() => openStore(dbPath));
  // SQLite creates later WAL files with the database file's permissions.
  try {
    restrictPermissions(created && home, [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, lockPath]);
  } catch (error) {
    store.close();
    throw error;
  }
  return { store, adapters: defaultAdapters(env, store), lockPath };
}

/** `openDefault` for read/refresh commands: undefined, creating nothing, when there is no index. */
export function openExisting(env: NodeJS.ProcessEnv = process.env): Runtime | undefined {
  return existsSync(indexPath(env)) ? openDefault(env) : undefined;
}
