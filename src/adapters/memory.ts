import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { errnoCode } from "../core/errors.js";
import { HISTORY_DIR, parseNote, projectSlug, USER_DIR } from "../core/memory.js";
import type { Adapter } from "../core/types.js";
import { findFiles } from "./fs.js";

/**
 * Project memory notes (`src/core/memory.ts`), indexed as `note` chunks so that search finds them.
 * Notes are the user's: a deleted one is removed from the index, not archived.
 */

export const MEMORY_TOOL = "memory";
/** Part of every source version: bump it when notes are read differently, to index them again. */
const READ_FORMAT = 2;

/** History copies, and the user profile, which is not about a project and is not searched. */
const skipped = (file: string) => {
  const parts = file.split(/[\\/]/);
  return parts.includes(HISTORY_DIR) || parts[0] === USER_DIR;
};

export function createMemoryAdapter(root: string): Adapter {
  return {
    tool: MEMORY_TOOL,
    archiveDeleted: false,
    async discover() {
      const listing = await findFiles(root, ".md");
      const sources = [];
      for (const file of listing.files) {
        if (skipped(path.relative(root, file))) continue;
        try {
          const { size, mtimeMs } = await stat(file);
          sources.push({ id: file, version: `${READ_FORMAT}:${size}:${mtimeMs}` });
        } catch (error) {
          if (errnoCode(error) !== "ENOENT") throw error;
        }
      }
      return { sources, complete: listing.complete };
    },
    async *read(source) {
      const note = parseNote(await readFile(source.id, "utf8"));
      const records = note
        ? [
            {
              kind: "note" as const,
              tool: MEMORY_TOOL,
              title: note.topic,
              // Unique per note: search shows at most two hits per session, and every project
              // has a brief.
              sessionId: `${note.topic} · ${projectSlug(note.project)}`,
              project: note.project,
              timestamp: note.updated,
              text: note.text,
            },
          ]
        : [];
      yield { records, checkpoint: null, reset: true, skipped: note ? 0 : 1 };
    },
  };
}
