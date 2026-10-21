import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { parseClaudeLines } from "../adapters/claude.js";
import { errnoCode } from "../core/errors.js";
import { writePrivateFile } from "../core/files.js";
import { readNotes } from "../core/memory.js";
import type { KnowledgeMode } from "../core/mode.js";
import { DEFAULT_PHRASES, type Phrases } from "../core/provenance.js";
import { startContext } from "../core/recall.js";
import { sessionProject } from "./claude-code.js";

/**
 * Claude Code hooks for project memory (docs/adr/0004), active where knowledge mode is on:
 * `SessionStart` adds the project's memory; `Stop` asks the agent to save what it learned once
 * the user made a decision or the session covered enough new ground; `SessionEnd` indexes the
 * session; and each prompt tells an open session which notes changed since its last prompt.
 */

/** Transcript growth (bytes of JSONL) between two requests to save what was learned. */
export const NUDGE_BYTES = 250_000;
/** Sessions whose last request is older than this are dropped from the state file. */
const NUDGE_STATE_DAYS = 30;
/** How a `remember` call appears in a Claude Code transcript (`mcp__<server>__<tool>`). */
const REMEMBER_CALL = "agentlore__remember";

export const DECISION_REASON =
  "agentlore (knowledge mode): the user made a decision in this session. Before you stop, save it to the project memory with the agentlore `remember` tool: the decision and its reason, `recall` first and merge, short and factual, no secrets. If it is already saved or not about this project, just stop. Without those tools (an MCP server started before they existed), use `lore memory show [topic]` and `lore memory save <topic> --by agent` with the note on stdin. Do not mention this request unless you saved something.";

export const CORRECTION_REASON =
  'agentlore (knowledge mode): the user corrected you in this session. If the correction shows how they want you to work or talk (not a fact about this project), save it to their user profile, shared by all projects: the agentlore `remember` tool with topic "user", `recall` topic "user" first and merge, short, no secrets. If it was a project fact or decision, save that to the project notes instead. If it is already saved or not worth keeping, just stop. Without those tools, use `lore memory show user` and `lore memory save user --by agent` with the profile on stdin. Do not mention this request unless you saved something.';

export const NUDGE_REASON =
  "agentlore (knowledge mode): this session covered new ground. Before you stop, save what other sessions should know about this project (decisions and their reasons, schema, business rules, how things work, pitfalls) with the agentlore `remember` tool: `recall` first and merge, one topic per call, short and factual, no secrets. If nothing durable was learned, just stop. Without those tools (an MCP server started before they existed), use `lore memory show [topic]` and `lore memory save <topic> --by agent` with the note on stdin. Do not mention this request unless you saved something.";

type Json = Record<string, unknown>;

function parseObject(stdin: string): Json {
  const raw: unknown = JSON.parse(stdin);
  if (typeof raw !== "object" || raw === null) throw new Error("hook input is not an object");
  return raw as Json;
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

export interface SessionStartDeps {
  modeFor(cwd: string): KnowledgeMode;
  memoryRoot: string;
  /** JSON file of when each session last saw the notes (see `notesChangedNotice`). */
  sessionsPath?: string;
  now?: () => Date;
  /** The project of a working directory; `sessionProject` by default. */
  projectOf?: (cwd: string) => string | undefined;
}

/** Handle one SessionStart call: the stdout JSON, or "" to add nothing. */
export function claudeSessionStartHook(stdin: string, deps: SessionStartDeps): string {
  const input = parseObject(stdin);
  const cwd = text(input.cwd);
  if (!cwd || deps.modeFor(cwd) !== "on") return "";
  // Outside a project (the home folder), the session still gets the user profile.
  const project = (deps.projectOf ?? sessionProject)(cwd);
  const sessionId = text(input.session_id);
  if (sessionId && deps.sessionsPath) markSeen(deps.sessionsPath, sessionId, deps.now?.());
  const context = startContext(deps.memoryRoot, project);
  if (!context) return "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  });
}

export interface StopDeps {
  modeFor(cwd: string): KnowledgeMode;
  /** JSON file remembering each session's transcript size at its last request. */
  statePath: string;
  /** The notes-seen file of `SessionStartDeps`: a session that saved a note has seen it. */
  sessionsPath?: string;
  /** Decision words, the language packs' plus the user's. */
  phrases?: Phrases;
  now?: () => Date;
}

/** Per session: when it was last handled, and for `Stop`, the transcript size then. */
interface SessionState {
  [sessionId: string]: { at: string; bytes?: number };
}

function readState(file: string): SessionState {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as SessionState)
      : {};
  } catch {
    return {};
  }
}

function markSeen(
  file: string,
  sessionId: string,
  now: Date = new Date(),
  state: SessionState = readState(file),
): void {
  state[sessionId] = { at: now.toISOString() };
  writeState(file, state, now);
}

function writeState(file: string, state: SessionState, now: Date): void {
  const cutoff = now.getTime() - NUDGE_STATE_DAYS * 86_400_000;
  const kept = Object.fromEntries(
    Object.entries(state).filter(
      ([, v]) => typeof v?.at === "string" && Date.parse(v.at) >= cutoff,
    ),
  );
  writePrivateFile(file, JSON.stringify(kept));
}

/** Bytes `from`..`to` of a file as text. */
function readRange(file: string, from: number, to: number): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, to - from));
    const read = readSync(fd, buffer, 0, buffer.length, from);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Whether a user turn among these transcript lines decides something, or corrects the agent. */
function userSaid(
  lines: string,
  transcript: string,
  phrases: Phrases,
): { decided: boolean; corrected: boolean } {
  const turns = parseClaudeLines(lines.split("\n"), transcript, {})
    .records.filter((r) => r.role === "user")
    .map((r) => r.text);
  return {
    decided: turns.some((t) => phrases.decides(t)),
    corrected: turns.some((t) => phrases.corrects(t)),
  };
}

/**
 * Handle one Stop call: a JSON asking the agent to save what it learned, or "" to let it stop.
 * It asks when a user turn since the last request decides something or corrects the agent (for
 * the user profile), or after NUDGE_BYTES of new transcript; never twice in a row
 * (`stop_hook_active`), and not when the agent saved a note since the last request.
 */
export function claudeStopHook(stdin: string, deps: StopDeps): string {
  const input = parseObject(stdin);
  const cwd = text(input.cwd);
  const sessionId = text(input.session_id);
  const transcript = text(input.transcript_path);
  if (!cwd || !sessionId || !transcript || input.stop_hook_active === true) return "";
  if (deps.modeFor(cwd) !== "on") return "";
  let size: number;
  try {
    size = statSync(transcript).size;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return "";
    throw error;
  }
  const state = readState(deps.statePath);
  const last = Math.min(state[sessionId]?.bytes ?? 0, size);
  if (size === last) return "";
  const lines = readRange(transcript, last, size);
  const now = deps.now?.() ?? new Date();
  const record = () => {
    state[sessionId] = { bytes: size, at: now.toISOString() };
    writeState(deps.statePath, state, now);
  };
  if (lines.includes(REMEMBER_CALL)) {
    record();
    if (deps.sessionsPath) markSeen(deps.sessionsPath, sessionId, now);
    return "";
  }
  const said = userSaid(lines, transcript, deps.phrases ?? DEFAULT_PHRASES);
  if (!said.decided && !said.corrected && size - last < NUDGE_BYTES) return "";
  record();
  const reason = said.corrected ? CORRECTION_REASON : said.decided ? DECISION_REASON : NUDGE_REASON;
  return JSON.stringify({ decision: "block", reason });
}

export interface NoticeDeps {
  memoryRoot: string;
  sessionsPath: string;
  projectOf?: (cwd: string) => string | undefined;
  now?: () => Date;
}

/**
 * For an open session, the project's notes changed since its last prompt (or its start), as one
 * line; undefined when none did. Each call records the prompt as seen.
 */
export function notesChangedNotice(
  { cwd, sessionId }: { cwd: string; sessionId?: string },
  deps: NoticeDeps,
): string | undefined {
  if (!sessionId) return undefined;
  const project = (deps.projectOf ?? sessionProject)(cwd);
  if (!project) return undefined;
  const state = readState(deps.sessionsPath);
  const seen = state[sessionId]?.at;
  const now = deps.now?.() ?? new Date();
  markSeen(deps.sessionsPath, sessionId, now, state);
  if (!seen) return undefined;
  const changed = readNotes(deps.memoryRoot, project).filter((n) => n.updated > seen);
  if (!changed.length) return undefined;
  const list = changed.map(
    (n) => `${n.topic} (by ${n.by}, ${n.updated.slice(0, 16).replace("T", " ")} UTC)`,
  );
  return `agentlore: this project's notes changed since your last prompt: ${list.join(", ")}. Call \`recall\` with a topic to read the new version before relying on what you knew.`;
}

export interface SessionEndDeps {
  modeFor(cwd: string): KnowledgeMode;
  /** Starts `lore index` in the background, so the session is searchable at once. */
  startIndex(): void;
}

/** Handle one SessionEnd call: index the session where knowledge mode is on. Prints nothing. */
export function claudeSessionEndHook(stdin: string, deps: SessionEndDeps): string {
  const cwd = text(parseObject(stdin).cwd);
  if (cwd && deps.modeFor(cwd) === "on") deps.startIndex();
  return "";
}
