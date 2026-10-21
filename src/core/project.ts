import { homedir } from "node:os";
import nodePath from "node:path";

/** Pass `path.win32` or `path.posix` to pick a flavour. */
export type PathFlavour = Pick<typeof nodePath, "isAbsolute" | "resolve">;

function decodePath(path: string): string {
  if (!/%[0-9a-f]{2}/i.test(path)) return path;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** `path` with a leading `~` (alone or before a separator) replaced by `home`. */
export const expandHome = (path: string, home: string = homedir()): string =>
  home && /^~(?:$|[\\/])/.test(path) ? home + path.slice(1) : path;

/**
 * One form for stored projects and project filters: percent-decoded, `~` expanded (so hit labels
 * work as filters), no trailing separator, resolved if absolute. Shortened labels (`…/apps/api`)
 * are kept: the store matches them as trailing folders.
 */
export function normalizeProject(
  project: string | undefined,
  path: PathFlavour = nodePath,
  home: string = homedir(),
): string | undefined {
  if (!project) return undefined;
  const decoded = expandHome(decodePath(project), home);
  const trimmed = decoded.replace(/[\\/]+$/, "");
  if (!trimmed) return project;
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  // `C:` without its separator is relative to the drive's cwd: resolve the root itself.
  return path.isAbsolute(decoded) ? path.resolve(decoded) : trimmed;
}

/** Whole-folder-name prefix match, case-insensitive for Windows paths. */
export function isWithin(
  parent: string,
  child: string,
  path: Pick<typeof nodePath, "sep"> = nodePath,
): boolean {
  const windows = path.sep === "\\";
  const a = windows ? parent.toLowerCase() : parent;
  const b = windows ? child.toLowerCase() : child;
  if (a === b) return true;
  return b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}
