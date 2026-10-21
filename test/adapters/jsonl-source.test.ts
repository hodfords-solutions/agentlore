import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { jsonlAdapter, type ParseLines } from "../../src/adapters/jsonl-source.js";
import type { Adapter, Checkpoint, ReadBatch, SourceRef } from "../../src/core/types.js";
import { tempDir } from "../helpers.js";

/** One message per line; the line count so far is kept in `state` to check it persists. */
const parseLines: ParseLines = (lines, _file, state) => {
  const records = lines.map((text) => {
    state.seen = String(Number(state.seen ?? 0) + 1);
    return {
      kind: "transcript" as const,
      tool: "test",
      sessionId: "s",
      project: "/p",
      timestamp: state.seen,
      role: "user" as const,
      text,
    };
  });
  return { records, skipped: 0 };
};

let dir: string;
let file: string;
let adapter: Adapter;

beforeEach(() => {
  dir = tempDir("lore-jsonl-source-");
  file = join(dir, "a.jsonl");
  adapter = jsonlAdapter({ tool: "test", root: dir, parseLines });
});

const source = (): SourceRef => {
  const { size, mtimeMs } = statSync(file);
  return { id: file, version: `${size}:${Math.trunc(mtimeMs)}` };
};

async function read(checkpoint?: Checkpoint, batchSize?: number): Promise<ReadBatch[]> {
  const batches: ReadBatch[] = [];
  for await (const batch of adapter.read(source(), checkpoint, { batchSize })) batches.push(batch);
  return batches;
}

const texts = (batches: ReadBatch[]) => batches.flatMap((b) => b.records.map((r) => r.text));
const last = (batches: ReadBatch[]) => batches[batches.length - 1]?.checkpoint;

describe("jsonlAdapter", () => {
  it("discovers .jsonl files with a size:mtime version", async () => {
    writeFileSync(file, "one\n");
    writeFileSync(join(dir, "notes.txt"), "");
    expect(await adapter.discover()).toEqual({ sources: [source()], complete: true });
  });

  it("reads everything on the first read and resets the source", async () => {
    writeFileSync(file, "one\ntwo\nthree\n");
    const batches = await read(undefined, 2);
    expect(texts(batches)).toEqual(["one", "two", "three"]);
    expect(batches.map((b) => b.reset)).toEqual([true, false]);
    expect(last(batches)).toMatchObject({ offset: 14, size: 14, state: { seen: "3" } });
  });

  it("reads only appended lines from a checkpoint and keeps the parser state", async () => {
    writeFileSync(file, "one\n");
    const first = await read();
    appendFileSync(file, "two\n");
    const second = await read(last(first));
    expect(texts(second)).toEqual(["two"]);
    expect(second[0]).toMatchObject({ reset: false });
    expect(second[0]?.records[0]?.timestamp).toBe("2");
  });

  it("starts over when the file shrank", async () => {
    writeFileSync(file, "one\ntwo\n");
    const first = await read();
    writeFileSync(file, "new\n");
    const again = await read(last(first));
    expect(texts(again)).toEqual(["new"]);
    expect(again[0]?.reset).toBe(true);
  });

  it("starts over when the first bytes changed although the file grew", async () => {
    writeFileSync(file, "one\n");
    const first = await read();
    writeFileSync(file, "uno\ndos\n");
    const again = await read(last(first));
    expect(texts(again)).toEqual(["uno", "dos"]);
    expect(again[0]?.reset).toBe(true);
  });

  it("starts over when the checkpoint is not one of its own", async () => {
    writeFileSync(file, "one\n");
    const batches = await read({ unexpected: true });
    expect(texts(batches)).toEqual(["one"]);
    expect(batches[0]?.reset).toBe(true);
  });

  it("yields one empty batch with the new checkpoint when no complete line was added", async () => {
    writeFileSync(file, "one\n");
    const first = await read();
    appendFileSync(file, "partial");
    const again = await read(last(first));
    expect(again).toEqual([
      {
        records: [],
        skipped: 0,
        reset: false,
        checkpoint: expect.objectContaining({ offset: 4, size: 11 }),
      },
    ]);
  });
});
