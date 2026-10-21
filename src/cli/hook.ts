import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentMode, loreHome, memoryPath, openIndexReadOnly, wordsPath } from "../app.js";
import { errorMessage } from "../core/errors.js";
import { loadPhrases } from "../core/words.js";
import { claudePromptHook, NO_HOOKS_ENV } from "../integrations/claude-code.js";
import {
  claudeSessionEndHook,
  claudeSessionStartHook,
  claudeStopHook,
  notesChangedNotice,
} from "../integrations/claude-memory-hooks.js";
import { readStdin } from "./stdin.js";

/** Hook diagnostics only with AGENTLORE_DEBUG=1: hooks must stay silent. */
const debug = (message: string) => {
  if (process.env.AGENTLORE_DEBUG === "1") console.error(`agentlore hook: ${message}`);
};

const modeFor = (cwd: string) => currentMode(cwd).mode;
const sessionsPath = () => join(loreHome(), "state", "sessions.json");

/**
 * Run a hook handler on stdin and print its output. Never fails the user's session: any error
 * prints nothing and exits 0. Sessions agentlore starts itself (NO_HOOKS_ENV) get nothing.
 */
async function runHook(name: string, handle: (stdin: string) => string): Promise<void> {
  if (process.env[NO_HOOKS_ENV] === "1") return;
  const started = performance.now();
  try {
    const output = handle(await readStdin());
    if (output) process.stdout.write(`${output}\n`);
    debug(
      `${name}: ${output ? `added ${output.length} chars` : "nothing added"} in ${Math.round(performance.now() - started)} ms`,
    );
  } catch (error) {
    debug(`${name} failed: ${errorMessage(error)}`);
  }
}

/** `lore hook claude-prompt`: related excerpts for a prompt. */
export const runClaudePromptHook = () =>
  runHook("claude-prompt", (stdin) =>
    claudePromptHook(stdin, {
      modeFor,
      openIndex: () => openIndexReadOnly(),
      notice: (input) =>
        notesChangedNotice(input, { memoryRoot: memoryPath(), sessionsPath: sessionsPath() }),
    }),
  );

/** `lore hook claude-session-start`: the project's memory at the start of a session. */
export const runClaudeSessionStartHook = () =>
  runHook("claude-session-start", (stdin) =>
    claudeSessionStartHook(stdin, {
      modeFor,
      memoryRoot: memoryPath(),
      sessionsPath: sessionsPath(),
    }),
  );

/** `lore hook claude-stop`: ask the agent to save decisions and what it learned. */
export const runClaudeStopHook = () =>
  runHook("claude-stop", (stdin) =>
    claudeStopHook(stdin, {
      modeFor,
      statePath: join(loreHome(), "state", "nudges.json"),
      sessionsPath: sessionsPath(),
      // A broken words file only loses the user's own words here; search reports it.
      phrases: loadPhrases(wordsPath(), () => undefined),
    }),
  );

/** `lore index` in a detached process: the hook returns at once and the session is not held up. */
function startIndex(): void {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "index.js");
  spawn(process.execPath, [cli, "index"], { detached: true, stdio: "ignore" }).unref();
}

/** `lore hook claude-session-end`: index the session that just ended. */
export const runClaudeSessionEndHook = () =>
  runHook("claude-session-end", (stdin) => claudeSessionEndHook(stdin, { modeFor, startIndex }));
