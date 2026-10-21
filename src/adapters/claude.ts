import { homedir } from "node:os";
import { join, sep } from "node:path";
import { z } from "zod";
import type { Adapter, SourceRecord } from "../core/types.js";
import { parseJson } from "./fs.js";
import { jsonlAdapter, type ParseLines } from "./jsonl-source.js";

const Line = z.object({
  type: z.string(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  timestamp: z.string().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  message: z
    .object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.string(), text: z.string().optional() })),
      ]),
    })
    .optional(),
});

/** Harness-injected context and slash-command output, removed with their content. */
const INJECTED =
  /<(system-reminder|command-name|command-message|local-command-stdout)>[\s\S]*?<\/\1>/g;
/** Slash-command arguments are the user's own words: keep them. */
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/g;

function extractText(content: string | { type: string; text?: string }[]): string {
  const raw =
    typeof content === "string"
      ? content
      : content
          .filter((block) => block.type === "text" && block.text)
          .map((block) => block.text)
          .join("\n");
  return raw.replace(INJECTED, "").replace(COMMAND_ARGS, "$1").trim();
}

/** Subagent transcripts live in `<session>/subagents/agent-<id>.jsonl`. */
const SUBAGENTS_DIR = `${sep}subagents${sep}`;

/** In subagent (side chain) transcripts, "user" turns are the parent's prompts: role "agent". */
export const parseClaudeLines: ParseLines = (lines, file) => {
  const inSubagentFile = file.includes(SUBAGENTS_DIR);
  const records: SourceRecord[] = [];
  let skipped = 0;
  for (const raw of lines) {
    const result = Line.safeParse(parseJson(raw));
    if (!result.success) {
      skipped++;
      continue;
    }
    const line = result.data;
    if (line.type !== "user" && line.type !== "assistant") continue;
    if (line.isMeta || line.isCompactSummary || !line.message || !line.sessionId) continue;
    const text = extractText(line.message.content);
    if (!text) continue;
    const sidechain = inSubagentFile || line.isSidechain === true;
    records.push({
      kind: "transcript",
      tool: "claude",
      sessionId: line.sessionId,
      project: line.cwd ?? "",
      timestamp: line.timestamp ?? "",
      role: sidechain && line.type === "user" ? "agent" : line.type,
      text,
      ...(sidechain ? { meta: { sidechain } } : {}),
    });
  }
  return { records, skipped };
};

/**
 * Tool results, attachments and file-history snapshots. Quotes inside JSON strings are escaped,
 * so these only match the line's own keys; they can sit anywhere (`"type":"attachment"` follows
 * the content), so the whole line is scanned. ASCII markers make the latin1 view exact.
 */
const SKIPPED_MARKER = /"(?:toolUseResult"|type":"(?:attachment|file-history-snapshot)")/;

export const skipClaudeLine = (raw: Buffer): boolean => SKIPPED_MARKER.test(raw.toString("latin1"));

export function createClaudeAdapter(root = join(homedir(), ".claude", "projects")): Adapter {
  return jsonlAdapter({
    tool: "claude",
    root,
    parseLines: parseClaudeLines,
    skipLine: skipClaudeLine,
  });
}
