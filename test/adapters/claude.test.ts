import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createClaudeAdapter,
  parseClaudeLines,
  skipClaudeLine,
} from "../../src/adapters/claude.js";
import { jsonlAdapter } from "../../src/adapters/jsonl-source.js";
import { indexAll } from "../../src/core/indexer.js";
import { openStore } from "../../src/core/store.js";
import type { Adapter } from "../../src/core/types.js";
import { tempDir } from "../helpers.js";

const root = join(import.meta.dirname, "../fixtures/claude");
const file = join(root, "-work-repo-a/claude-s1.jsonl");
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);

describe("claude adapter", () => {
  const adapter = createClaudeAdapter(root);

  it("discovers jsonl files recursively", async () => {
    expect(await adapter.discover()).toEqual({
      sources: [{ id: file, version: expect.stringMatching(/^\d+:\d+$/) }],
      complete: true,
    });
  });

  it("returns no files and names the root when it does not exist", async () => {
    expect(await createClaudeAdapter(join(root, "missing")).discover()).toEqual({
      sources: [],
      complete: true,
      missingRoot: join(root, "missing"),
    });
  });

  it("extracts user and assistant text only", () => {
    const { records: messages, skipped } = parseClaudeLines(lines, file, {});
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Why does the payment webhook retry twice?"],
      ["assistant", "Stripe retries because the handler returns 500 before the idempotency check."],
      ["user", "Thanks, move the idempotency check first."],
    ]);
    expect(messages[0]).toMatchObject({
      tool: "claude",
      sessionId: "claude-s1",
      project: "/work/repo-a",
      timestamp: "2026-06-03T02:51:45.340Z",
    });
    expect(skipped).toBe(1);
  });

  const userLine = (content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "user",
      sessionId: "s",
      cwd: "/p",
      timestamp: "2026-06-03T00:00:00Z",
      message: { role: "user", content },
      ...extra,
    });

  it("labels subagent prompts as written by an agent and marks subagent records", () => {
    const parent = [userLine("Fix the flaky test"), userLine("Review it", { isSidechain: true })];
    expect(
      parseClaudeLines(parent, file, {}).records.map((r) => [r.role, r.meta?.sidechain]),
    ).toEqual([
      ["user", undefined],
      ["agent", true],
    ]);
    const subagentFile = join(root, "-work-repo-a/s/subagents/agent-1.jsonl");
    const records = parseClaudeLines([userLine("Investigate the build")], subagentFile, {}).records;
    expect(records.map((r) => [r.role, r.meta?.sidechain])).toEqual([["agent", true]]);
  });

  it("drops a message line without a sessionId instead of storing it with none", () => {
    const withoutSession = JSON.stringify({
      type: "user",
      cwd: "/p",
      timestamp: "2026-06-03T00:00:00Z",
      message: { role: "user", content: "orphan line" },
    });
    const { records, skipped } = parseClaudeLines([withoutSession, userLine("kept")], file, {});
    expect(records.map((r) => [r.sessionId, r.text])).toEqual([["s", "kept"]]);
    expect(records.every((r) => typeof r.sessionId === "string")).toBe(true);
    expect(skipped).toBe(0);
  });

  it("ignores unknown fields and content blocks without counting them as skipped", () => {
    const drifted = [
      userLine(
        [
          { type: "thinking", thinking: "internal", signature: "abc" },
          { type: "image", source: { type: "base64", data: "AAAA" } },
          { type: "text", text: "visible words", citations: [] },
          { type: "future_block", payload: { nested: true } },
        ],
        { version: "9.9.9", gitBranch: "main", brandNewField: { a: 1 } },
      ),
      JSON.stringify({ type: "some-future-line-type", sessionId: "s", data: {} }),
    ];
    const { records, skipped } = parseClaudeLines(drifted, file, {});
    expect(records.map((r) => r.text)).toEqual(["visible words"]);
    expect(skipped).toBe(0);
  });

  it("skips compact summaries", () => {
    const lines = [userLine("This session is being continued...", { isCompactSummary: true })];
    expect(parseClaudeLines(lines, file, {}).records).toEqual([]);
  });

  it("drops slash-command wrappers and their output", () => {
    const lines = [
      userLine(
        "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
      ),
      userLine("<local-command-stdout>Set model to opus</local-command-stdout>"),
      userLine([
        { type: "text", text: "<command-name>/review</command-name>Please review the diff" },
      ]),
    ];
    expect(parseClaudeLines(lines, file, {}).records.map((m) => m.text)).toEqual([
      "Please review the diff",
    ]);
  });

  it("keeps the user's own words from slash-command arguments", () => {
    const lines = [
      userLine(
        "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>focus on the auth flow</command-args>",
      ),
    ];
    expect(parseClaudeLines(lines, file, {}).records.map((m) => m.text)).toEqual([
      "focus on the auth flow",
    ]);
  });
});

describe("skipClaudeLine", () => {
  const user = (content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "user",
      sessionId: "s",
      cwd: "/p",
      timestamp: "2026-06-03T00:00:00Z",
      message: { role: "user", content },
      ...extra,
    });
  const lines = [
    user('Quote the key "toolUseResult" and "type":"attachment" in prose'),
    user([{ type: "tool_result", tool_use_id: "t", content: "x".repeat(50) }], {
      toolUseResult: { stdout: "x".repeat(50) },
    }),
    JSON.stringify({ type: "attachment", attachment: { content: "big" } }),
    // Real attachment lines carry their type key after the (large) content.
    JSON.stringify({ attachment: { content: "x".repeat(500) }, type: "attachment" }),
    JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
    JSON.stringify({
      type: "assistant",
      sessionId: "s",
      cwd: "/p",
      timestamp: "2026-06-03T00:00:01Z",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
    }),
  ];

  it("skips only structural tool results, attachments and snapshots", () => {
    expect(lines.map((l) => skipClaudeLine(Buffer.from(l)))).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it("yields the same chunks with and without the filter", async () => {
    const dir = tempDir("lore-claude-skip-");
    mkdirSync(join(dir, "proj"));
    writeFileSync(join(dir, "proj/s.jsonl"), `${lines.join("\n")}\n`);
    const chunksOf = async (adapter: Adapter) => {
      const store = openStore(":memory:");
      try {
        await indexAll(store, [adapter]);
        return store.db.prepare("SELECT chunk_key, text FROM chunks ORDER BY id").all();
      } finally {
        store.close();
      }
    };
    const filtered = await chunksOf(createClaudeAdapter(dir));
    const unfiltered = await chunksOf(
      jsonlAdapter({ tool: "claude", root: dir, parseLines: parseClaudeLines }),
    );
    expect(filtered).toEqual(unfiltered);
    expect(filtered).toHaveLength(1);
  });
});
