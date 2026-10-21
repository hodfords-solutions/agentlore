import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode } from "../core/errors.js";

/** Skipped: their files are gone. */
const GONE = new Set(["ENOENT", "ENOTDIR"]);
/** Skipped, but the listing is marked incomplete. */
const DENIED = new Set(["EACCES", "EPERM"]);

export interface FileListing {
  files: string[];
  complete: boolean;
  rootMissing?: boolean;
}

/** Errors other than a missing root or the subdirectory cases above throw. */
export async function findFiles(root: string, extension: string): Promise<FileListing> {
  const result: FileListing = { files: [], complete: true };
  try {
    await walk(root, extension, result);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { files: [], complete: true, rootMissing: true };
    throw error;
  }
  result.files.sort();
  return result;
}

async function walk(dir: string, extension: string, result: FileListing): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      try {
        await walk(path, extension, result);
      } catch (error) {
        const code = errnoCode(error) ?? "";
        if (DENIED.has(code)) result.complete = false;
        else if (!GONE.has(code)) throw error;
      }
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      result.files.push(path);
    }
  }
}

export function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
