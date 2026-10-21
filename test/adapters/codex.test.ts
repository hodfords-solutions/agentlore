import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexAdapter, parseCodexLines } from "../../src/adapters/codex.js";
import type { FileState } from "../../src/adapters/jsonl-source.js";

const root = join(import.meta.dirname, "../fixtures/codex");
const file = join(root, "2026/07/08/rollout-2026-07-08T14-28-56-codex-s1.jsonl");
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);

describe("codex adapter", () => {
  const adapter = createCodexAdapter(root);

  it("discovers rollout files", async () => {
    expect(await adapter.discover()).toEqual({
      sources: [{ id: file, version: expect.stringMatching(/^\d+:\d+$/) }],
      complete: true,
    });
  });

  it("extracts user and agent messages with the session cwd", () => {
    const state: FileState = {};
    const { records: messages, skipped } = parseCodexLines(lines, file, state);
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "How does the warehouse import work?"],
      [
        "assistant",
        "The warehouse import is a one-time seed via POST /inventory/seed, not incremental.",
      ],
    ]);
    expect(messages[0]).toMatchObject({
      tool: "codex",
      sessionId: "codex-s1",
      project: "/work/repo-b",
    });
    expect(skipped).toBe(1);
  });

  it("remembers session metadata across incremental reads via state", () => {
    const state: FileState = {};
    parseCodexLines(lines.slice(0, 1), file, state);
    const { records: messages } = parseCodexLines(lines.slice(2, 3), file, state);
    expect(messages[0]).toMatchObject({ sessionId: "codex-s1", project: "/work/repo-b" });
  });

  it("ignores unknown fields and event types without counting them as skipped", () => {
    const drifted = [
      JSON.stringify({
        timestamp: "2026-07-08T07:29:14Z",
        type: "session_meta",
        payload: { id: "s9", cwd: "/w", model_provider: "x", instructions: { nested: [1] } },
      }),
      JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "brand_new_event" } }),
      JSON.stringify({ timestamp: "t", type: "future_top_level", payload: { anything: true } }),
      JSON.stringify({
        timestamp: "2026-07-08T07:29:16Z",
        type: "event_msg",
        payload: { type: "user_message", message: "still parsed", images: [], kind: "plain" },
        extra: 1,
      }),
    ];
    const { records, skipped } = parseCodexLines(drifted, file, {});
    expect(records.map((r) => [r.sessionId, r.project, r.text])).toEqual([
      ["s9", "/w", "still parsed"],
    ]);
    expect(skipped).toBe(0);
  });

  it("falls back to the file name when session_meta is missing", () => {
    const { records: messages } = parseCodexLines(lines.slice(2, 3), file, {});
    expect(messages[0]?.sessionId).toBe("rollout-2026-07-08T14-28-56-codex-s1");
  });
});
