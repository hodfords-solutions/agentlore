import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Adapter, SourceRecord } from "../core/types.js";
import { parseJson } from "./fs.js";
import { jsonlAdapter, type ParseLines } from "./jsonl-source.js";

const Line = z.object({
  timestamp: z.string().optional(),
  type: z.string(),
  payload: z
    .object({
      type: z.string().optional(),
      id: z.string().optional(),
      session_id: z.string().optional(),
      cwd: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const ROLES: Record<string, SourceRecord["role"]> = {
  user_message: "user",
  agent_message: "assistant",
};

/** Session id and cwd come from the `session_meta` header and persist in `state`. */
export const parseCodexLines: ParseLines = (lines, file, state) => {
  const records: SourceRecord[] = [];
  let skipped = 0;
  for (const raw of lines) {
    const result = Line.safeParse(parseJson(raw));
    if (!result.success) {
      skipped++;
      continue;
    }
    const { type, payload, timestamp } = result.data;
    if (type === "session_meta" && payload) {
      const id = payload.id ?? payload.session_id;
      if (id) state.sessionId = id;
      if (payload.cwd) state.project = payload.cwd;
      continue;
    }
    const role = type === "event_msg" && payload?.type ? ROLES[payload.type] : undefined;
    const text = payload?.message?.trim();
    if (!role || !text) continue;
    records.push({
      kind: "transcript",
      tool: "codex",
      sessionId: state.sessionId ?? basename(file, ".jsonl"),
      project: state.project ?? "",
      timestamp: timestamp ?? "",
      role,
      text,
    });
  }
  return { records, skipped };
};

export function createCodexAdapter(root = join(homedir(), ".codex", "sessions")): Adapter {
  return jsonlAdapter({ tool: "codex", root, parseLines: parseCodexLines });
}
