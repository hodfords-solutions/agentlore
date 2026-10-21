import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { errnoCode } from "../core/errors.js";
import type { Adapter, SourceRecord } from "../core/types.js";
import { parseJson } from "./fs.js";

/**
 * Claude Code's prompt history (`~/.claude/history.jsonl`): every prompt the user typed, kept
 * after Claude Code deletes the session's transcript (after `cleanupPeriodDays`, 30 by default).
 * Only sessions without a transcript are read, on disk or kept in the index (`indexed`), so
 * prompts are not indexed twice; for those, the user's own words are all that is left.
 */

export const CLAUDE_HISTORY_TOOL = "claude-history";

const Entry = z.object({
  display: z.string(),
  pastedContents: z
    .record(
      z.string(),
      z.object({ content: z.string().optional(), contentHash: z.string().optional() }),
    )
    .optional(),
  timestamp: z.number(),
  project: z.string().optional(),
  sessionId: z.string(),
});
type Entry = z.infer<typeof Entry>;

/** Where Claude Code puts pasted text it does not keep inline: `<contentHash>.txt`. */
const PASTE_CACHE = "paste-cache";
/** "[Pasted text #2 +40 lines]" in a prompt stands for pasted content with id 2. */
const PASTE_PLACEHOLDER = /\[Pasted text #(\d+)[^\]]*\]/g;

interface Parsed {
  /** The file's size and mtime, to reuse a parse while it is unchanged. */
  stamp: string;
  bySession: Map<string, Entry[]>;
  skipped: number;
}

/** Session ids that still have a transcript: `<projects>/<folder>/<session>.jsonl`. */
function sessionsWithTranscript(projects: string): Set<string> {
  const found = new Set<string>();
  let folders: string[];
  try {
    folders = readdirSync(projects);
  } catch {
    return found;
  }
  for (const folder of folders) {
    let files: string[];
    try {
      files = readdirSync(join(projects, folder));
    } catch {
      continue;
    }
    for (const file of files) if (file.endsWith(".jsonl")) found.add(file.slice(0, -6));
  }
  return found;
}

/** The prompt's text with pasted content in place of its placeholders. */
function promptText(entry: Entry, claudeDir: string): string {
  const pasted = new Map<string, string>();
  for (const [id, item] of Object.entries(entry.pastedContents ?? {})) {
    let content = item.content;
    if (content === undefined && item.contentHash && /^[0-9a-f]+$/i.test(item.contentHash)) {
      try {
        content = readFileSync(join(claudeDir, PASTE_CACHE, `${item.contentHash}.txt`), "utf8");
      } catch {
        // Not cached: keep the placeholder.
      }
    }
    if (content !== undefined) pasted.set(id, content);
  }
  return entry.display
    .replace(PASTE_PLACEHOLDER, (all, id: string) => pasted.get(id) ?? all)
    .trim();
}

export function createClaudeHistoryAdapter(
  file = join(homedir(), ".claude", "history.jsonl"),
  projects = join(dirname(file), "projects"),
  /** Sessions the index has from Claude Code transcripts, e.g. archived ones. */
  indexed: () => Set<string> = () => new Set(),
): Adapter {
  const claudeDir = dirname(file);
  let cache: Parsed | undefined;

  /** The file parsed, reusing the last parse while it is unchanged; undefined when missing. */
  const parse = (): Parsed | undefined => {
    let stamp: string;
    try {
      const stat = statSync(file);
      stamp = `${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return undefined;
      throw error;
    }
    if (cache?.stamp === stamp) return cache;
    const bySession = new Map<string, Entry[]>();
    let skipped = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const result = Entry.safeParse(parseJson(line));
      if (!result.success) {
        skipped++;
        continue;
      }
      const list = bySession.get(result.data.sessionId) ?? [];
      list.push(result.data);
      bySession.set(result.data.sessionId, list);
    }
    cache = { stamp, bySession, skipped };
    return cache;
  };

  return {
    tool: CLAUDE_HISTORY_TOOL,
    async discover() {
      const parsed = parse();
      if (!parsed) return { sources: [], complete: true, missingRoot: file };
      const live = sessionsWithTranscript(projects);
      const kept = indexed();
      const sources = [...parsed.bySession]
        .filter(([session]) => !live.has(session) && !kept.has(session))
        .map(([session, entries]) => ({
          id: `${file}#${session}`,
          version: `${entries.length}:${entries.at(-1)?.timestamp ?? 0}`,
        }));
      return { sources, complete: true };
    },
    async *read(source) {
      const session = source.id.slice(source.id.lastIndexOf("#") + 1);
      const entries = parse()?.bySession.get(session) ?? [];
      const records: SourceRecord[] = [];
      for (const entry of entries) {
        const text = promptText(entry, claudeDir);
        // Slash commands ("/clear", "/model") are not the user's words about the work.
        if (!text || text.startsWith("/")) continue;
        records.push({
          kind: "transcript",
          tool: CLAUDE_HISTORY_TOOL,
          sessionId: session,
          project: entry.project ?? "",
          timestamp: new Date(entry.timestamp).toISOString(),
          role: "user",
          text,
        });
      }
      // A session's prompts are re-read in full whenever one is added: they are few.
      yield { records, checkpoint: entries.length, reset: true, skipped: 0 };
    },
  };
}
