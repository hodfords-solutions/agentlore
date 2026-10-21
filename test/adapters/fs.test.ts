import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findFiles } from "../../src/adapters/fs.js";
import { tempDir } from "../helpers.js";

const canRevokeAccess = process.platform !== "win32" && process.getuid?.() !== 0;

describe("findFiles", () => {
  it("returns sorted matching files from nested directories", async () => {
    const root = tempDir("lore-fs-");
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "b", "2.jsonl"), "");
    writeFileSync(join(root, "1.jsonl"), "");
    writeFileSync(join(root, "notes.txt"), "");
    expect(await findFiles(root, ".jsonl")).toEqual({
      files: [join(root, "1.jsonl"), join(root, "b", "2.jsonl")],
      complete: true,
    });
  });

  it("ignores directories whose name ends in the extension", async () => {
    const root = tempDir("lore-fs-");
    mkdirSync(join(root, "x.jsonl"));
    writeFileSync(join(root, "x.jsonl", "inner.jsonl"), "");
    expect((await findFiles(root, ".jsonl")).files).toEqual([join(root, "x.jsonl", "inner.jsonl")]);
  });

  it("returns [] and flags the root when it does not exist", async () => {
    expect(await findFiles(join(tempDir("lore-fs-"), "missing"), ".jsonl")).toEqual({
      files: [],
      complete: true,
      rootMissing: true,
    });
  });

  it.skipIf(!canRevokeAccess)(
    "skips subdirectories it cannot read and reports the listing as incomplete",
    async () => {
      const root = tempDir("lore-fs-");
      const locked = join(root, "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, "hidden.jsonl"), "");
      writeFileSync(join(root, "ok.jsonl"), "");
      chmodSync(locked, 0o000);
      try {
        expect(await findFiles(root, ".jsonl")).toEqual({
          files: [join(root, "ok.jsonl")],
          complete: false,
        });
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );
});
