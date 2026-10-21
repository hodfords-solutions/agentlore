import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { errnoCode, errorMessage } from "../core/errors.js";
import type { KnowledgeMode } from "../core/mode.js";
import { expandHome } from "../core/project.js";
import { type PromptTuning, promptContext } from "../core/prompt-context.js";
import type { Store } from "../core/store.js";

/** Claude Code's hooks and their install: https://code.claude.com/docs/en/hooks */

/** agentlore's Claude Code hooks: the event and the `lore hook` subcommand that handles it. */
export const CLAUDE_HOOKS = [
  { event: "UserPromptSubmit", name: "claude-prompt" },
  { event: "SessionStart", name: "claude-session-start" },
  { event: "Stop", name: "claude-stop" },
  { event: "SessionEnd", name: "claude-session-end" },
] as const;
export type ClaudeHookName = (typeof CLAUDE_HOOKS)[number]["name"];
const PROMPT_EVENT = CLAUDE_HOOKS[0].event;
const PROMPT_HOOK = CLAUDE_HOOKS[0].name;
/** Identifies agentlore's hooks in settings.json: our CLI script, maybe quoted, then the hook. */
const OUR_COMMAND = new RegExp(
  `cli[\\\\/]index\\.js"?\\s+hook (?:${CLAUDE_HOOKS.map((h) => h.name).join("|")})\\s*$`,
);
/** Seconds Claude Code waits for a hook (its default is 60). */
export const CLAUDE_HOOK_TIMEOUT = 5;
/** Set in the environment of sessions agentlore starts itself: its hooks then do nothing. */
export const NO_HOOKS_ENV = "AGENTLORE_NO_HOOKS";

export interface PromptHookDeps {
  modeFor(cwd: string): KnowledgeMode;
  /** The index, read-only, or undefined if none. The hook closes it. */
  openIndex(): Store | undefined;
  tuning?: Partial<PromptTuning>;
  /** A line to add before any excerpts, e.g. which project notes changed (see the memory hooks). */
  notice?: (input: { cwd: string; sessionId?: string }) => string | undefined;
}

/**
 * Nearest folder at or above `cwd` containing `.git`. Undefined outside a repository or when the
 * repository is the home folder (dotfiles), which is not one project.
 */
export function gitRoot(cwd: string, home: string = homedir()): string | undefined {
  const top = path.resolve(home);
  let dir = path.resolve(cwd);
  if (dir === top) return undefined;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir === top ? undefined : dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The main repository of a linked worktree (whose `.git` file points to
 * `<main>/.git/worktrees/<name>`), else `root` itself.
 */
export function mainWorktree(root: string): string {
  let gitFile: string;
  try {
    gitFile = readFileSync(path.join(root, ".git"), "utf8");
  } catch {
    // A .git folder (EISDIR), or gone.
    return root;
  }
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile)?.[1];
  if (!gitdir) return root;
  const worktrees = path.dirname(path.resolve(root, gitdir));
  const dotGit = path.dirname(worktrees);
  if (path.basename(worktrees) !== "worktrees" || path.basename(dotGit) !== ".git") return root;
  return path.dirname(dotGit);
}

/**
 * A session's project: its repository (a worktree's main one), else the folder, unless that is
 * home or a filesystem root.
 */
export function sessionProject(cwd: string, home: string = homedir()): string | undefined {
  const root = gitRoot(cwd, home);
  if (root) return mainWorktree(root);
  const dir = path.resolve(cwd);
  if (dir === path.resolve(home) || path.dirname(dir) === dir) return undefined;
  return dir;
}

interface PromptHookInput {
  prompt: string;
  cwd: string;
  sessionId?: string;
}

function parseInput(stdin: string): PromptHookInput {
  const raw: unknown = JSON.parse(stdin);
  if (typeof raw !== "object" || raw === null) throw new Error("hook input is not an object");
  const { prompt, cwd, session_id: sessionId } = raw as Record<string, unknown>;
  if (typeof prompt !== "string") throw new Error("hook input has no prompt");
  if (typeof cwd !== "string" || !cwd) throw new Error("hook input has no cwd");
  return { prompt, cwd, sessionId: typeof sessionId === "string" ? sessionId : undefined };
}

/**
 * Handle one UserPromptSubmit call and return the stdout JSON, or "" to add nothing. On a throw
 * the caller must print nothing and exit 0, so a failure never blocks the user's prompt.
 */
export function claudePromptHook(stdin: string, deps: PromptHookDeps): string {
  const input = parseInput(stdin);
  if (deps.modeFor(input.cwd) !== "on") return "";
  const notice = deps.notice?.(input);
  const store = deps.openIndex();
  let context: string | undefined;
  if (store) {
    try {
      context = promptContext(store, input.prompt, {
        excludeSessionId: input.sessionId,
        tuning: deps.tuning,
      });
    } finally {
      store.close();
    }
  }
  const added = [notice, context].filter(Boolean).join("\n\n");
  if (!added) return "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: PROMPT_EVENT, additionalContext: added },
  });
}

const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

/** Double-quoted for a POSIX shell: `"`, `\\`, `$` and backticks escaped. */
const doubleQuote = (arg: string) => `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;

const posixQuote = (arg: string) => (PLAIN_WORD.test(arg) ? arg : doubleQuote(arg));

/**
 * The hook command, with absolute paths so it works without a PATH. On Windows (Git Bash or cmd)
 * paths use forward slashes, which both accept and bash does not treat as escapes, and are quoted.
 */
export function hookCommand(
  execPath: string,
  cliPath: string,
  platform: "posix" | "win32" = process.platform === "win32" ? "win32" : "posix",
): string {
  const quote =
    platform === "win32" ? (arg: string) => doubleQuote(arg.replace(/\\/g, "/")) : posixQuote;
  return `${quote(execPath)} ${quote(cliPath)} hook ${PROMPT_HOOK}`;
}

/** Another hook's command, from the prompt hook's (see `hookCommand`). */
const commandFor = (promptCommand: string, name: ClaudeHookName) =>
  promptCommand.replace(new RegExp(`${PROMPT_HOOK}\\s*$`), name);

/** The node and script paths of a hook command written by `hookCommand`. */
export function hookCommandPaths(command: string): string[] {
  const word = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  const words = [...command.matchAll(word)].map(([, quoted, plain]) =>
    quoted === undefined ? (plain as string) : quoted.replace(/\\(["\\$`])/g, "$1"),
  );
  return words.slice(0, 2);
}

/** $CLAUDE_CONFIG_DIR/settings.json (leading `~` expanded), else ~/.claude/settings.json. */
export function claudeSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return path.join(home, ".claude", "settings.json");
  return path.resolve(expandHome(dir, home), "settings.json");
}

type Json = Record<string, unknown>;
interface HookEntry {
  type?: unknown;
  command?: unknown;
}
interface HookGroup {
  hooks?: unknown;
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Throws when the file is not valid Claude Code settings. */
function readSettings(file: string): { text?: string; settings?: Json } {
  const text = readText(file);
  if (text === undefined) return {};
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${errorMessage(error)}); nothing was changed.`);
  }
  const invalid = (what: string) =>
    new Error(`${file}: ${what}; nothing was changed. Fix it, then try again.`);
  if (!isObject(settings)) throw invalid("the settings are not a JSON object");
  if (settings.hooks !== undefined && !isObject(settings.hooks)) {
    throw invalid('"hooks" is not an object');
  }
  for (const { event } of CLAUDE_HOOKS) {
    const groups = (settings.hooks as Json | undefined)?.[event];
    if (groups !== undefined && !Array.isArray(groups)) {
      throw invalid(`"hooks.${event}" is not an array`);
    }
  }
  return { text, settings };
}

const isOurs = (entry: unknown): boolean => {
  const { type, command } = (isObject(entry) ? entry : {}) as HookEntry;
  return type === "command" && typeof command === "string" && OUR_COMMAND.test(command);
};

const entriesOf = (group: unknown): unknown[] => {
  const hooks = isObject(group) ? (group as HookGroup).hooks : undefined;
  return Array.isArray(hooks) ? hooks : [];
};

/** The event's hook groups without agentlore's hooks; groups left empty are dropped. */
function withoutOurs(groups: unknown[]): unknown[] {
  return groups.flatMap((group) => {
    const entries = entriesOf(group);
    if (!entries.some(isOurs)) return [group];
    const rest = entries.filter((entry) => !isOurs(entry));
    return rest.length ? [{ ...(group as Json), hooks: rest }] : [];
  });
}

const BACKUP_INFIX = ".agentlore-backup-";
/** Backups of a settings file kept; older ones are deleted. */
export const KEPT_BACKUPS = 3;

const backupPath = (file: string, now: Date) =>
  `${file}${BACKUP_INFIX}${now.toISOString().replace(/[:.]/g, "-")}`;

/** Backup names sort by time. */
function pruneBackups(file: string): void {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + BACKUP_INFIX;
  const backups = readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort();
  for (const name of backups.slice(0, -KEPT_BACKUPS)) rmSync(path.join(dir, name), { force: true });
}

export interface WriteOptions {
  now?: Date;
  /** Called just before the rename (tests use it to race the write). */
  beforeRename?: () => void;
}

/**
 * Back up, then atomically replace a settings file, keeping its mode and any symlink. Refuses if
 * the file changed since it was read as `original` (Claude Code or the user saved it).
 */
function writeSettings(
  file: string,
  settings: Json,
  original: string | undefined,
  { now = new Date(), beforeRename }: WriteOptions,
): string | undefined {
  let target = file;
  let mode = 0o600;
  let backup: string | undefined;
  if (original === undefined) {
    mkdirSync(path.dirname(file), { recursive: true });
  } else {
    target = realpathSync(file);
    mode = statSync(target).mode & 0o777;
    backup = backupPath(file, now);
    copyFileSync(target, backup);
  }
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
    // The mode given to writeFileSync is reduced by the umask.
    if (process.platform !== "win32") chmodSync(tmp, mode);
    beforeRename?.();
    if (readText(target) !== original) {
      throw new Error(
        `${file} changed while agentlore was editing it; nothing was changed. Try again.`,
      );
    }
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    // Nothing was changed: the copy is not a backup of anything.
    if (backup) rmSync(backup, { force: true });
    throw error;
  }
  // Only now: a refused attempt must not rotate out older backups.
  if (backup) pruneBackups(file);
  return backup;
}

export interface SettingsChange {
  /** False when the file was already as wanted (not written). */
  changed: boolean;
  backup?: string;
}

const changed = (backup: string | undefined): SettingsChange =>
  backup ? { changed: true, backup } : { changed: true };

/**
 * Add agentlore's hooks (CLAUDE_HOOKS) to a settings file, keeping everything else; older agentlore
 * hooks are replaced. `command` is the prompt hook's (see `hookCommand`); the others differ only
 * in the hook name. Throws, writing nothing, on invalid settings or a concurrent edit.
 */
export function installClaudeHook(
  file: string,
  command: string,
  options: WriteOptions = {},
): SettingsChange {
  const { text, settings = {} } = readSettings(file);
  const hooks = (settings.hooks ?? {}) as Json;
  const wanted = (name: ClaudeHookName) => ({
    type: "command",
    command: commandFor(command, name),
    timeout: CLAUDE_HOOK_TIMEOUT,
  });
  const current = CLAUDE_HOOKS.every(({ event, name }) => {
    const ours = ((hooks[event] ?? []) as unknown[]).flatMap(entriesOf).filter(isOurs);
    return ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(wanted(name));
  });
  if (current) return { changed: false };
  const updated: Json = { ...settings, hooks: { ...hooks } };
  for (const { event, name } of CLAUDE_HOOKS) {
    const groups = (hooks[event] ?? []) as unknown[];
    (updated.hooks as Json)[event] = [...withoutOurs(groups), { hooks: [wanted(name)] }];
  }
  return changed(writeSettings(file, updated, text, options));
}

/** Remove agentlore's hooks from a Claude Code settings file, keeping everything else. */
export function uninstallClaudeHook(file: string, options: WriteOptions = {}): SettingsChange {
  const { text, settings } = readSettings(file);
  const hooks = settings?.hooks as Json | undefined;
  const ours = (event: string) =>
    ((hooks?.[event] ?? []) as unknown[]).flatMap(entriesOf).some(isOurs);
  if (!settings || !hooks || !CLAUDE_HOOKS.some(({ event }) => ours(event))) {
    return { changed: false };
  }
  // Edited in place, so every other key keeps its position in the file.
  const updated = structuredClone(settings);
  const updatedHooks = updated.hooks as Json;
  for (const { event } of CLAUDE_HOOKS) {
    if (!ours(event)) continue;
    const rest = withoutOurs(hooks[event] as unknown[]);
    if (rest.length) updatedHooks[event] = rest;
    else delete updatedHooks[event];
  }
  if (!Object.keys(updatedHooks).length) delete updated.hooks;
  return changed(writeSettings(file, updated, text, options));
}

export interface HookStatus {
  installed: boolean;
  /** The prompt hook's command. */
  command?: string;
  /** Command paths that no longer exist (Node or agentlore moved or uninstalled). */
  missing?: string[];
  /** Events without agentlore's hook, e.g. after an install by an older agentlore. */
  missingEvents?: string[];
}

/**
 * Whether agentlore's hooks are in a settings file, the prompt hook's command, and whether they
 * can run. Throws on invalid settings rather than reporting them as "not installed".
 */
export function claudeHookStatus(file: string): HookStatus {
  const hooks = readSettings(file).settings?.hooks as Json | undefined;
  const ourEntry = (event: string) =>
    ((hooks?.[event] ?? []) as unknown[]).flatMap(entriesOf).find(isOurs) as HookEntry | undefined;
  const ours = ourEntry(PROMPT_EVENT);
  if (!ours) return { installed: false };
  const command = ours.command as string;
  const status: HookStatus = { installed: true, command };
  const missing = hookCommandPaths(command).filter((p) => !existsSync(p));
  if (missing.length) status.missing = missing;
  const missingEvents = CLAUDE_HOOKS.filter(({ event }) => !ourEntry(event)).map((h) => h.event);
  if (missingEvents.length) status.missingEvents = missingEvents;
  return status;
}
