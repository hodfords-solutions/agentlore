import { spawn } from "node:child_process";
import type { ModelRunner } from "../core/consolidate.js";
import { NO_HOOKS_ENV } from "./claude-code.js";

/**
 * Ask Claude Code in print mode (`claude -p`) for consolidation: no tools, no MCP servers, no
 * session saved (it would be indexed), and agentlore's own hooks off. It uses the user's Claude
 * Code login and quota.
 */

/** Stops a call that hangs. */
export const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;
/** Characters of claude's output quoted in an error. */
const OUTPUT_CHARS = 500;

export interface ClaudeRunnerOptions {
  /** A model alias or name, e.g. "sonnet"; Claude Code's default when undefined. */
  model?: string;
  /** Working directory: one without project files, so no CLAUDE.md is loaded. */
  cwd: string;
  command?: string;
  timeoutMs?: number;
}

export function claudeArgs(model?: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--tools",
    "",
    "--strict-mcp-config",
    ...(model ? ["--model", model] : []),
  ];
}

/** The answer's text from `claude -p --output-format json` output. */
export function claudeResult(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude printed no JSON result: ${stdout.slice(0, OUTPUT_CHARS)}`);
  }
  const { result, is_error: isError } = (parsed ?? {}) as { result?: unknown; is_error?: unknown };
  if (isError === true || typeof result !== "string") {
    throw new Error(`claude failed: ${String(result ?? stdout).slice(0, OUTPUT_CHARS)}`);
  }
  return result;
}

export function claudeRunner({
  model,
  cwd,
  command = "claude",
  timeoutMs = CLAUDE_TIMEOUT_MS,
}: ClaudeRunnerOptions): ModelRunner {
  return (prompt) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, claudeArgs(model), {
        cwd,
        env: { ...process.env, [NO_HOOKS_ENV]: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`claude did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (data: string) => {
        stdout += data;
      });
      child.stderr.setEncoding("utf8").on("data", (data: string) => {
        stderr += data;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error(`${command} not found: install Claude Code, or put it on the PATH.`)
            : error,
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new Error(
              `claude exited with ${code}: ${(stderr || stdout).trim().slice(-OUTPUT_CHARS)}`,
            ),
          );
          return;
        }
        try {
          resolve(claudeResult(stdout));
        } catch (error) {
          reject(error);
        }
      });
      // claude may exit before reading the whole prompt (bad login, bad flag): the exit code,
      // reported on "close", says why, so the broken pipe is not an error of its own.
      child.stdin.on("error", () => undefined);
      child.stdin.end(prompt);
    });
}
