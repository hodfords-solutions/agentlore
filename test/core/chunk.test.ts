import { describe, expect, it } from "vitest";
import { chunkRecords } from "../../src/core/chunk.js";
import type { SourceRecord } from "../../src/core/types.js";

const msg = (over: Partial<SourceRecord> = {}): SourceRecord => ({
  kind: "transcript",
  tool: "claude",
  sessionId: "s1",
  project: "/p",
  timestamp: "2026-01-01T00:00:00Z",
  role: "user",
  text: "hello",
  ...over,
});

describe("chunkRecords", () => {
  it("groups consecutive messages of one session into one chunk", () => {
    const chunks = chunkRecords([
      msg({ text: "question", timestamp: "2026-01-01T00:00:00Z" }),
      msg({ role: "assistant", text: "answer", timestamp: "2026-01-01T00:01:00Z" }),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      sessionId: "s1",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:01:00Z",
      text: "user: question\n\nassistant: answer",
    });
  });

  it("keeps subagent records in chunks of their own, marked as such", () => {
    const chunks = chunkRecords([msg(), msg({ role: "agent", meta: { sidechain: true } }), msg()]);
    expect(chunks.map((c) => [c.text, c.sidechain])).toEqual([
      ["user: hello", undefined],
      ["agent: hello", true],
      ["user: hello", undefined],
    ]);
  });

  it("starts a new chunk when the session changes", () => {
    const chunks = chunkRecords([msg(), msg({ sessionId: "s2" })]);
    expect(chunks.map((c) => c.sessionId)).toEqual(["s1", "s2"]);
  });

  it("starts a new chunk when the size limit is reached", () => {
    const chunks = chunkRecords(
      [msg({ text: "a".repeat(60) }), msg({ text: "b".repeat(60) })],
      100,
    );
    expect(chunks).toHaveLength(2);
  });

  it("splits a single oversized message", () => {
    const chunks = chunkRecords([msg({ text: "x".repeat(250) })], 100);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(100);
  });

  it("rejects a size limit too small to hold any text", () => {
    expect(() => chunkRecords([msg()], 10)).toThrow(RangeError);
  });

  it("never cuts an oversized message inside a surrogate pair", () => {
    // The leading "a" puts a high surrogate right before the first cut (index 94).
    const text = `a${"😀".repeat(100)}`;
    const chunks = chunkRecords([msg({ text })], 100);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const c of chunks) expect(c.text).not.toMatch(loneSurrogate);
    expect(chunks.map((c) => c.text.slice("user: ".length)).join("")).toBe(text);
  });

  it("returns nothing for no messages", () => {
    expect(chunkRecords([])).toEqual([]);
  });

  const note = (over: Partial<SourceRecord> = {}): SourceRecord => ({
    kind: "note",
    tool: "notes",
    title: "Deploy runbook",
    project: "/notes",
    timestamp: "2026-01-01T00:00:00Z",
    text: "Use blue-green deploys.",
    ...over,
  });

  it("chunks documents by title, without a role prefix, keeping their kind", () => {
    const chunks = chunkRecords([
      note(),
      note({ text: "Roll back with the previous tag." }),
      note({ title: "Other" }),
    ]);
    expect(chunks.map((c) => [c.kind, c.sessionId, c.text])).toEqual([
      ["note", "Deploy runbook", "Use blue-green deploys.\n\nRoll back with the previous tag."],
      ["note", "Other", "Use blue-green deploys."],
    ]);
  });

  it("starts a new chunk when the kind changes", () => {
    const chunks = chunkRecords([note({ title: "s1" }), msg({ sessionId: "s1" })]);
    expect(chunks.map((c) => c.kind)).toEqual(["note", "transcript"]);
  });

  it("groups records without session or title together", () => {
    const chunks = chunkRecords([note({ title: undefined }), note({ title: undefined })]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sessionId).toBe("");
  });
});
