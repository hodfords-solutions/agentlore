import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeHistoryAdapter } from "../../src/adapters/claude-history.js";
import type { ReadBatch } from "../../src/core/types.js";
import { tempDir } from "../helpers.js";

const entry = (sessionId: string, display: string, timestamp: number, extra = {}) =>
  JSON.stringify({
    display,
    pastedContents: {},
    timestamp,
    project: "/work/atlas",
    sessionId,
    ...extra,
  });

function claudeDir() {
  const dir = tempDir("lore-history-");
  mkdirSync(join(dir, "projects", "-work-atlas"), { recursive: true });
  mkdirSync(join(dir, "paste-cache"));
  writeFileSync(join(dir, "projects", "-work-atlas", "live.jsonl"), "");
  writeFileSync(join(dir, "paste-cache", "abc123.txt"), "the cached paste");
  writeFileSync(
    join(dir, "history.jsonl"),
    [
      entry("live", "still has its transcript", 1_780_000_000_000),
      entry("gone", "/model opus", 1_780_000_001_000),
      entry("gone", "chốt: the ledger uses postgres [Pasted text #1 +3 lines]", 1_780_000_002_000, {
        pastedContents: { "1": { id: 1, type: "text", content: "inline paste" } },
      }),
      entry("gone", "see [Pasted text #2 +40 lines] and [Pasted text #3]", 1_780_000_003_000, {
        pastedContents: { "2": { id: 2, type: "text", contentHash: "abc123" } },
      }),
      "{not json",
      entry("archived", "already kept from its transcript", 1_780_000_004_000),
    ].join("\n"),
  );
  return dir;
}

async function readAll(adapter: ReturnType<typeof createClaudeHistoryAdapter>, id: string) {
  const batches: ReadBatch[] = [];
  for await (const batch of adapter.read({ id, version: "" }, undefined, {})) batches.push(batch);
  return batches;
}

describe("claude prompt history adapter", () => {
  it("lists only sessions without a transcript on disk or in the index", async () => {
    const dir = claudeDir();
    const file = join(dir, "history.jsonl");
    const adapter = createClaudeHistoryAdapter(
      file,
      join(dir, "projects"),
      () => new Set(["archived"]),
    );
    const { sources, complete } = await adapter.discover();
    expect(complete).toBe(true);
    expect(sources).toEqual([{ id: `${file}#gone`, version: "3:1780000003000" }]);
  });

  it("reads a session's prompts with pasted text in place, without slash commands", async () => {
    const dir = claudeDir();
    const file = join(dir, "history.jsonl");
    const adapter = createClaudeHistoryAdapter(file, join(dir, "projects"));
    const [batch] = await readAll(adapter, `${file}#gone`);
    expect(batch?.reset).toBe(true);
    expect(batch?.records.map((r) => [r.role, r.text, r.timestamp, r.project])).toEqual([
      [
        "user",
        "chốt: the ledger uses postgres inline paste",
        "2026-05-28T20:26:42.000Z",
        "/work/atlas",
      ],
      [
        "user",
        "see the cached paste and [Pasted text #3]",
        "2026-05-28T20:26:43.000Z",
        "/work/atlas",
      ],
    ]);
  });

  it("reports a missing history file", async () => {
    const dir = tempDir("lore-history-");
    const adapter = createClaudeHistoryAdapter(join(dir, "history.jsonl"));
    expect(await adapter.discover()).toEqual({
      sources: [],
      complete: true,
      missingRoot: join(dir, "history.jsonl"),
    });
  });
});
