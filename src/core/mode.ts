import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { errnoCode, errorMessage } from "./errors.js";
import { writePrivateFile } from "./files.js";
import { isWithin, normalizeProject } from "./project.js";

/** When "on", agents are asked to consult past sessions and prompt hooks add related excerpts. */
export type KnowledgeMode = "on" | "off";

/** The mode state file: a global setting and per-folder rules (absolute paths). */
export interface ModeState {
  global?: KnowledgeMode;
  paths?: Record<string, KnowledgeMode>;
}

export interface ResolvedMode {
  mode: KnowledgeMode;
  /** "default": neither a folder rule nor a global setting applied. */
  source: "path" | "global" | "default";
  rule?: string;
}

/** Pass `path.win32` or `path.posix` to pick a flavour. */
export type ModePathFlavour = Pick<typeof nodePath, "isAbsolute" | "resolve" | "sep">;

const isMode = (value: unknown): value is KnowledgeMode => value === "on" || value === "off";

/** The deepest folder rule containing `cwd`, else the global setting, else "off". */
export function resolveMode(
  state: ModeState,
  cwd: string,
  path: ModePathFlavour = nodePath,
): ResolvedMode {
  const dir = normalizeProject(cwd, path);
  let best: { rule: string; length: number; mode: KnowledgeMode } | undefined;
  if (dir && path.isAbsolute(dir)) {
    for (const [rule, mode] of Object.entries(state.paths ?? {})) {
      const normalized = normalizeProject(rule, path);
      if (!isMode(mode) || !normalized || !path.isAbsolute(normalized)) continue;
      if (!isWithin(normalized, dir, path)) continue;
      if (!best || normalized.length > best.length) {
        best = { rule: normalized, length: normalized.length, mode };
      }
    }
  }
  if (best) return { mode: best.mode, source: "path", rule: best.rule };
  if (isMode(state.global)) return { mode: state.global, source: "global" };
  return { mode: "off", source: "default" };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * For the prompt hook, which must never fail: a missing, unreadable or corrupt file reads as no
 * settings, and an invalid field or rule is dropped on its own.
 */
export function readModeState(file: string): ModeState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(raw)) return {};
  const { global, paths } = raw;
  const state: ModeState = {};
  if (isMode(global)) state.global = global;
  if (isRecord(paths)) {
    state.paths = Object.fromEntries(
      Object.entries(paths).filter((entry): entry is [string, KnowledgeMode] => isMode(entry[1])),
    );
  }
  return state;
}

/**
 * For `lore mode`, which writes the state back: a missing file is no settings, anything else
 * that cannot be kept as it is throws, so a write never drops the user's other rules.
 */
export function readModeStateStrict(file: string): ModeState {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return {};
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${errorMessage(error)})`);
  }
  const invalid = (what: string) => new Error(`${file}: ${what}`);
  if (!isRecord(raw)) throw invalid("the mode settings are not a JSON object");
  const { global, paths } = raw;
  if (global !== undefined && !isMode(global)) throw invalid('"global" must be "on" or "off"');
  if (paths !== undefined && !isRecord(paths)) throw invalid('"paths" is not an object');
  for (const [rule, mode] of Object.entries(paths ?? {})) {
    if (!isMode(mode)) throw invalid(`the rule for ${rule} must be "on" or "off"`);
  }
  return raw as ModeState;
}

/** Atomic write: a private temporary file renamed over `file`. */
export function writeModeState(file: string, state: ModeState): void {
  writePrivateFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function setGlobalMode(state: ModeState, mode: KnowledgeMode): ModeState {
  return { ...state, global: mode };
}

/** Set, or remove when `mode` is undefined, the rule for `dir` and any other spelling of it. */
export function setPathMode(
  state: ModeState,
  dir: string,
  mode: KnowledgeMode | undefined,
  path: ModePathFlavour = nodePath,
): ModeState {
  const key = normalizeProject(dir, path) ?? dir;
  const paths = Object.fromEntries(
    Object.entries(state.paths ?? {}).filter(([rule]) => normalizeProject(rule, path) !== key),
  );
  if (mode) paths[key] = mode;
  return { ...state, paths };
}
