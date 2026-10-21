import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLineBatches } from "../../src/adapters/lines.js";
import { tempDir } from "../helpers.js";

/** Read all complete lines starting at byte `offset`, as one batch. */
async function readLinesFrom(path: string, offset: number) {
  const lines: string[] = [];
  let next = offset;
  for await (const batch of readLineBatches(path, offset)) {
    lines.push(...batch.lines);
    next = batch.offset;
  }
  return { lines, offset: next };
}

const tmpFile = (content: string) => {
  const file = join(tempDir("lore-jsonl-"), "f.jsonl");
  writeFileSync(file, content);
  return file;
};

describe("readLinesFrom", () => {
  it("reads complete lines and returns the next offset", async () => {
    const file = tmpFile('{"a":1}\n{"b":2}\n');
    const { lines, offset } = await readLinesFrom(file, 0);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(offset).toBe(16);
  });

  it("does not consume a trailing partial line", async () => {
    const file = tmpFile('{"a":1}\n{"b":');
    const first = await readLinesFrom(file, 0);
    expect(first.lines).toEqual(['{"a":1}']);
    appendFileSync(file, "2}\n");
    const second = await readLinesFrom(file, first.offset);
    expect(second.lines).toEqual(['{"b":2}']);
  });

  it("counts offsets in bytes for multi-byte text", async () => {
    const file = tmpFile('{"t":"tiếng việt"}\n');
    const { offset } = await readLinesFrom(file, 0);
    expect(offset).toBe(Buffer.byteLength('{"t":"tiếng việt"}\n'));
  });

  it("reads a line longer than one 64 KB stream chunk", async () => {
    const long = JSON.stringify({ t: "tiếng việt ".repeat(20_000) });
    const content = `${long}\n{"a":1}\n`;
    const file = tmpFile(content);
    const { lines, offset } = await readLinesFrom(file, 0);
    expect(lines).toEqual([long, '{"a":1}']);
    expect(offset).toBe(Buffer.byteLength(content));
  });

  it("strips the carriage return of CRLF lines but counts its byte", async () => {
    const file = tmpFile('{"a":1}\r\n\r\n{"b":2}\r\n');
    const { lines, offset } = await readLinesFrom(file, 0);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(offset).toBe(20);
  });

  it("skips blank lines", async () => {
    const file = tmpFile('\n{"a":1}\n\n');
    expect((await readLinesFrom(file, 0)).lines).toEqual(['{"a":1}']);
  });
});

describe("readLineBatches", () => {
  const collect = async (file: string, offset: number, maxLines: number) => {
    const batches: { lines: string[]; offset: number }[] = [];
    for await (const batch of readLineBatches(file, offset, { maxLines })) batches.push(batch);
    return batches;
  };

  it("yields at most maxLines lines per batch with the offset after each batch", async () => {
    const file = tmpFile('{"a":1}\n{"b":2}\n{"c":3}\n{"d":');
    expect(await collect(file, 0, 2)).toEqual([
      { lines: ['{"a":1}', '{"b":2}'], offset: 16, skipped: 0 },
      { lines: ['{"c":3}'], offset: 24, skipped: 0 },
    ]);
  });

  it("starts at the given offset", async () => {
    const file = tmpFile('{"a":1}\n{"b":2}\n');
    expect(await collect(file, 8, 5)).toEqual([{ lines: ['{"b":2}'], offset: 16, skipped: 0 }]);
  });

  it("yields nothing when there is no new complete line", async () => {
    const file = tmpFile('{"a":1}\n{"b":');
    expect(await collect(file, 8, 5)).toEqual([]);
  });

  it("also ends a batch once its lines reach maxBytes", async () => {
    const file = tmpFile('{"a":1}\n{"b":2}\n{"c":3}\n');
    const batches = [];
    for await (const batch of readLineBatches(file, 0, { maxLines: 100, maxBytes: 10 })) {
      batches.push(batch);
    }
    expect(batches).toEqual([
      { lines: ['{"a":1}', '{"b":2}'], offset: 16, skipped: 0 },
      { lines: ['{"c":3}'], offset: 24, skipped: 0 },
    ]);
  });

  it("rejects a maxBytes below 1", async () => {
    const file = tmpFile('{"a":1}\n');
    await expect(readLineBatches(file, 0, { maxBytes: 0 }).next()).rejects.toThrow(RangeError);
  });

  it("advances the offset past trailing blank lines", async () => {
    const file = tmpFile('{"a":1}\n\n\n');
    expect(await collect(file, 0, 1)).toEqual([
      { lines: ['{"a":1}'], offset: 8, skipped: 0 },
      { lines: [], offset: 10, skipped: 0 },
    ]);
  });
});

describe("readLineBatches skipLine", () => {
  it("drops lines the filter rejects, before decoding, but still advances past them", async () => {
    const file = tmpFile('{"a":1}\n{"skip":1}\n{"b":2}\n{"skip":2}\n');
    const batches = [];
    for await (const batch of readLineBatches(file, 0, {
      skipLine: (raw) => raw.includes('"skip"'),
    })) {
      batches.push(batch);
    }
    expect(batches).toEqual([{ lines: ['{"a":1}', '{"b":2}'], offset: 38, skipped: 0 }]);
  });
});

describe("readLineBatches defaults", () => {
  it("ends a batch after 500 lines", async () => {
    const file = tmpFile('{"a":1}\n'.repeat(501));
    const sizes = [];
    for await (const batch of readLineBatches(file, 0)) sizes.push(batch.lines.length);
    expect(sizes).toEqual([500, 1]);
  });
});

describe("readLineBatches maxLineBytes", () => {
  const collect = async (file: string, offset: number, maxLineBytes: number) => {
    const batches = [];
    for await (const batch of readLineBatches(file, offset, { maxLineBytes })) {
      batches.push(batch);
    }
    return batches;
  };

  it("drops a line over maxLineBytes, counts it as skipped and keeps byte offsets", async () => {
    // Longer than one 64 KB stream chunk, so the line is dropped while still buffering it.
    const huge = JSON.stringify({ t: "x".repeat(200_000) });
    const content = `{"a":1}\n${huge}\n{"b":2}\n`;
    const file = tmpFile(content);
    expect(await collect(file, 0, 100_000)).toEqual([
      { lines: ['{"a":1}', '{"b":2}'], offset: Buffer.byteLength(content), skipped: 1 },
    ]);
  });

  it("drops a line just over the limit and keeps one exactly at it", async () => {
    const file = tmpFile('{"a":1}\n{"ab":12}\n');
    expect(await collect(file, 0, 7)).toEqual([{ lines: ['{"a":1}'], offset: 18, skipped: 1 }]);
  });

  it("leaves an oversized final line without a newline for the next call", async () => {
    const file = tmpFile(`{"a":1}\n${"x".repeat(100)}`);
    expect(await collect(file, 0, 10)).toEqual([{ lines: ['{"a":1}'], offset: 8, skipped: 0 }]);
    appendFileSync(file, '\n{"b":2}\n');
    expect(await collect(file, 8, 10)).toEqual([{ lines: ['{"b":2}'], offset: 117, skipped: 1 }]);
  });

  it("rejects a maxLineBytes below 1", async () => {
    const file = tmpFile('{"a":1}\n');
    await expect(readLineBatches(file, 0, { maxLineBytes: 0 }).next()).rejects.toThrow(RangeError);
  });
});
