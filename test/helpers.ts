import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { onTestFinished } from "vitest";
import type { Store } from "../src/core/store.js";
import type { Chunk } from "../src/core/types.js";
import { CursorFixture } from "./cursor-fixture.js";

/**
 * A POSIX-style absolute path as agentlore stores and filters it on this OS: unchanged on POSIX,
 * resolved against the current drive on Windows (`/work/repo-a` → `C:\work\repo-a`).
 */
export const hostPath = (posixPath: string): string => path.resolve(posixPath);

/** `text` with regular-expression metacharacters escaped, to embed host paths in a RegExp. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Delete a temporary folder. Windows refuses to delete files a process still holds open (an
 * exiting child's index.db), so wait for children first and retry briefly.
 */
export const removeDir = (dir: string): void =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/**
 * A new empty folder under the OS temp folder, named `prefix` plus random characters, deleted
 * when the current test finishes (after its afterEach hooks, so stores they close are closed
 * first). Call it inside a test or a beforeEach hook.
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  onTestFinished(() => removeDir(dir));
  return dir;
}

/** Resolves once the process `pid` has exited (or after `timeoutMs`, to never hang a test). */
export async function waitForExit(pid: number | null | undefined, timeoutMs = 5000): Promise<void> {
  if (!pid) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(25);
  }
}

/** A transcript chunk with test defaults. */
export const chunk = (over: Partial<Chunk> = {}): Chunk => ({
  kind: "transcript",
  tool: "claude",
  sessionId: "s1",
  project: hostPath("/work/repo-a"),
  startedAt: "2026-06-03T02:51:45Z",
  endedAt: "2026-06-03T02:52:00Z",
  text: "",
  ...over,
});

/** Append chunks to source `id`, recorded as fully indexed. */
export function seed(store: Store, id: string, chunks: Chunk[]): void {
  const tool = chunks[0]?.tool ?? "claude";
  store.saveSource({ id, tool, version: "1", checkpoint: null }, chunks, { reset: false });
}

/**
 * A fresh copy of the fixtures in a temporary folder (pushed to `dirs` for cleanup), with every
 * agentlore location pointing into it: the environment for a sandboxed `lore` process.
 */
export function fixtureSandbox(dirs: string[]): NodeJS.ProcessEnv {
  const dir = mkdtempSync(path.join(tmpdir(), "lore-sandbox-"));
  dirs.push(dir);
  cpSync(path.join(import.meta.dirname, "fixtures"), dir, { recursive: true });
  const cursor = new CursorFixture(path.join(dir, "cursor"))
    .composer("cursor-s1", [
      ["m1", 1],
      ["m2", 2],
    ])
    .bubble("cursor-s1", "m1", { type: 1, text: "Why is the sync job flaky?" })
    .bubble("cursor-s1", "m2", { type: 2, text: "Add exponential backoff to the retry loop." })
    .workspace("ws1", ["cursor-s1"], { folder: hostPath("/work/repo-a") });
  cursor.close();
  return {
    ...process.env,
    AGENTLORE_HOME: path.join(dir, "home"),
    AGENTLORE_CLAUDE_DIR: path.join(dir, "claude"),
    AGENTLORE_CODEX_DIR: path.join(dir, "codex"),
    AGENTLORE_CURSOR_DIR: cursor.userDir,
    AGENTLORE_ANTIGRAVITY_DIR: path.join(dir, "antigravity"),
  };
}
