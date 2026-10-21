import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { errnoCode } from "./errors.js";

/** Whether a file an agent cited still says what it said then: gone, or changed since. */
export type CitationCheck = "gone" | "line gone" | "changed";

/** Files larger than this are not read to count their lines. */
const MAX_LINE_CHECK_BYTES = 5_000_000;

/**
 * Checks a cited `path[:line]` against the disk, from the session's `project` folder, as of the
 * cited chunk's end. Undefined when it still exists unchanged, or when it cannot be located: a
 * bare file name, no project, or a folder that does not exist there either.
 */
export function checkCitation(
  cites: string,
  project: string,
  endedAt: string,
): CitationCheck | undefined {
  const match = /^(.*?)(?::(\d+))?$/.exec(cites);
  const file = match?.[1] ?? cites;
  const line = match?.[2] ? Number(match[2]) : undefined;
  if (!path.isAbsolute(file) && (!project || !/[\\/]/.test(file))) return undefined;
  const full = path.isAbsolute(file) ? file : path.join(project, file);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(full);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT" && errnoCode(error) !== "ENOTDIR") return undefined;
    // Without its folder, the path was likely relative to another one: we cannot tell.
    return existsSync(path.dirname(full)) ? "gone" : undefined;
  }
  if (!stat.isFile()) return undefined;
  if (line !== undefined && stat.size <= MAX_LINE_CHECK_BYTES) {
    try {
      if (readFileSync(full, "utf8").split("\n").length < line) return "line gone";
    } catch {
      return undefined;
    }
  }
  const ended = Date.parse(endedAt);
  return Number.isFinite(ended) && stat.mtimeMs > ended ? "changed" : undefined;
}
