import { chmodSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAntigravityAdapter, utf8Prefix } from "../../src/adapters/antigravity.js";
import type { ReadBatch, SourceRef } from "../../src/core/types.js";
import { tempDir } from "../helpers.js";

/** A synthetic `brain` folder: conversation folders with markdown artifacts and metadata. */
function brain(): string {
  const root = tempDir("lore-antigravity-");
  const conv = join(root, "conv-1");
  mkdirSync(conv);
  writeFileSync(join(conv, "task.md"), "# Task\n\n- [x] Add the warehouse importer\n");
  writeFileSync(
    join(conv, "task.md.metadata.json"),
    JSON.stringify({
      artifactType: "ARTIFACT_TYPE_TASK",
      summary: "Tasks",
      updatedAt: "2026-05-01T10:00:00.000Z",
    }),
  );
  writeFileSync(join(conv, "walkthrough.md"), "# Walkthrough\n\nThe importer seeds once.\n");
  writeFileSync(join(conv, "walkthrough.md.metadata.json"), "{not json");
  // Copies Antigravity keeps of earlier versions, and the metadata files: not sources.
  writeFileSync(join(conv, "task.md.resolved"), "old");
  writeFileSync(join(conv, "task.md.resolved.0"), "older");
  mkdirSync(join(root, "conv-empty"));
  writeFileSync(join(root, "stray.md"), "not inside a conversation");
  return root;
}

async function readAll(
  adapter: ReturnType<typeof createAntigravityAdapter>,
  source: SourceRef,
): Promise<ReadBatch[]> {
  const batches: ReadBatch[] = [];
  for await (const batch of adapter.read(source, undefined, {})) batches.push(batch);
  return batches;
}

describe("antigravity adapter", () => {
  it("discovers the markdown artifacts of each conversation", async () => {
    const root = brain();
    const discovery = await createAntigravityAdapter(root).discover();
    expect(discovery.complete).toBe(true);
    expect(discovery.sources.map((s) => s.id)).toEqual([
      "antigravity:conv-1/task.md",
      "antigravity:conv-1/walkthrough.md",
    ]);
    for (const s of discovery.sources) expect(s.version).toMatch(/^\d+:\d+$/);
  });

  it("reads a whole file as one note titled after its conversation and file", async () => {
    const root = brain();
    const adapter = createAntigravityAdapter(root);
    const [batch] = await readAll(adapter, { id: "antigravity:conv-1/task.md", version: "1" });
    expect(batch).toMatchObject({ reset: true, skipped: 0 });
    expect(batch?.records).toEqual([
      {
        kind: "note",
        tool: "antigravity",
        title: "conv-1 — task",
        project: "",
        timestamp: "2026-05-01T10:00:00.000Z",
        text: "# Task\n\n- [x] Add the warehouse importer",
      },
    ]);
  });

  it("falls back to the file's modification time without valid metadata", async () => {
    const root = brain();
    const file = join(root, "conv-1", "walkthrough.md");
    const mtime = new Date("2026-04-02T03:04:05.000Z");
    utimesSync(file, mtime, mtime);
    const adapter = createAntigravityAdapter(root);
    const [batch] = await readAll(adapter, {
      id: "antigravity:conv-1/walkthrough.md",
      version: "1",
    });
    expect(batch?.records[0]?.timestamp).toBe(mtime.toISOString());
    expect(batch?.records[0]?.title).toBe("conv-1 — walkthrough");
  });

  it("yields no record for an empty file, and clears what was indexed from it", async () => {
    const root = brain();
    writeFileSync(join(root, "conv-1", "task.md"), "  \n");
    const batches = await readAll(createAntigravityAdapter(root), {
      id: "antigravity:conv-1/task.md",
      version: "1",
    });
    expect(batches).toEqual([{ records: [], checkpoint: null, reset: true, skipped: 0 }]);
  });

  it("cuts a file over 4 MB at a character boundary", async () => {
    const root = brain();
    // One ASCII byte, then two-byte characters: the 4 MB cut falls inside one of them.
    writeFileSync(join(root, "conv-1", "task.md"), `a${"é".repeat(2 * 1024 * 1024)}`);
    const [batch] = await readAll(createAntigravityAdapter(root), {
      id: "antigravity:conv-1/task.md",
      version: "1",
    });
    const text = batch?.records[0]?.text ?? "";
    expect(Buffer.byteLength(text)).toBe(4 * 1024 * 1024 - 1);
    expect(text.endsWith("é")).toBe(true);
    expect(text).not.toContain("\uFFFD");
  });

  it("reports a missing brain folder", async () => {
    const root = join(brain(), "nope");
    expect(await createAntigravityAdapter(root).discover()).toEqual({
      sources: [],
      complete: true,
      missingRoot: root,
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "marks the listing incomplete when a conversation folder cannot be read",
    async () => {
      const root = brain();
      chmodSync(join(root, "conv-empty"), 0o000);
      try {
        const discovery = await createAntigravityAdapter(root).discover();
        expect(discovery.complete).toBe(false);
        expect(discovery.sources).toHaveLength(2);
      } finally {
        chmodSync(join(root, "conv-empty"), 0o755);
      }
    },
  );

  it("rejects source ids that would leave the brain folder", async () => {
    const adapter = createAntigravityAdapter(brain());
    await expect(readAll(adapter, { id: "antigravity:../x.md", version: "1" })).rejects.toThrow(
      /invalid antigravity source id/,
    );
    await expect(readAll(adapter, { id: "other:conv-1/task.md", version: "1" })).rejects.toThrow(
      /invalid antigravity source id/,
    );
  });
});

describe("utf8Prefix", () => {
  it("drops an incomplete character at the end, and nothing else", () => {
    const bytes = Buffer.from("aé😀", "utf8");
    expect(utf8Prefix(bytes).toString()).toBe("aé😀");
    for (let cut = 4; cut < bytes.length; cut++) {
      expect(utf8Prefix(bytes.subarray(0, cut)).toString()).toBe("aé");
    }
    expect(utf8Prefix(bytes.subarray(0, 2)).toString()).toBe("a");
    expect(utf8Prefix(Buffer.alloc(0)).length).toBe(0);
  });
});
