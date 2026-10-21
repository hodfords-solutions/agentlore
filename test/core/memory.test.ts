import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRIEF_TOPIC,
  forgetNote,
  formatNote,
  HISTORY_DIR,
  KEPT_VERSIONS,
  MAX_BRIEF_CHARS,
  MAX_PROFILE_CHARS,
  MAX_TOPICS,
  NoteError,
  notedProjects,
  parseNote,
  projectSlug,
  readGroups,
  readNote,
  readNotes,
  readUserProfile,
  relatedProjects,
  topicSlug,
  USER_DIR,
  writeGroups,
  writeNote,
  writeUserProfile,
} from "../../src/core/memory.js";
import { hostPath, tempDir } from "../helpers.js";

const repoA = hostPath("/work/shop-api");
const repoB = hostPath("/work/shop-web");
const at = (minute: number) => new Date(Date.UTC(2026, 9, 21, 10, minute));

describe("slugs", () => {
  it("names a project's folder by its last folder and a hash of its path", () => {
    expect(projectSlug(repoA)).toMatch(/^shop-api-[0-9a-f]{8}$/);
    expect(projectSlug(hostPath("/other/shop-api"))).not.toBe(projectSlug(repoA));
  });

  it("makes topics lowercase ASCII words, accents dropped", () => {
    expect(topicSlug("Thanh toán & Hoá đơn")).toBe("thanh-toan-hoa-don");
    expect(topicSlug("  DB schema ")).toBe("db-schema");
    expect(topicSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(topicSlug("!!!")).toBeUndefined();
  });
});

describe("notes", () => {
  it("round-trips a note through its file format", () => {
    const note = {
      project: repoA,
      topic: "db",
      updated: "2026-10-21T10:00:00.000Z",
      by: "agent" as const,
      text: "Orders are soft-deleted: `deleted_at`.\n\n---\nnot front matter",
    };
    expect(parseNote(formatNote(note))).toEqual(note);
  });

  it("rejects files without a valid front matter, and reads an unknown author as the user", () => {
    expect(parseNote("just text")).toBeUndefined();
    expect(
      parseNote("---\nproject: relative/path\ntopic: db\nupdated: 2026-10-21\n---\nx"),
    ).toBeUndefined();
    expect(parseNote(`---\nproject: ${repoA}\ntopic: db\nupdated: nope\n---\nx`)).toBeUndefined();
    expect(
      parseNote(`---\nproject: ${repoA}\ntopic: db\nupdated: 2026-10-21\nby: me\n---\nx`)?.by,
    ).toBe("user");
  });

  it("saves, replaces (keeping the old version) and lists notes, the brief first", () => {
    const root = tempDir("lore-memory-");
    writeNote(root, { project: repoA, topic: "db", text: "v1", by: "agent", now: at(1) });
    const second = writeNote(root, {
      project: repoA,
      topic: "DB",
      text: "v2",
      by: "agent",
      now: at(2),
    });
    expect(second.replaced).toBe(true);
    writeNote(root, { project: repoA, topic: "auth", text: "JWT", by: "agent", now: at(3) });
    writeNote(root, {
      project: repoA,
      topic: BRIEF_TOPIC,
      text: "Shop API",
      by: "consolidation",
      now: at(0),
    });
    expect(readNotes(root, repoA).map((n) => n.topic)).toEqual([BRIEF_TOPIC, "auth", "db"]);
    expect(readNote(root, repoA, "db")?.text).toBe("v2");
    const history = path.join(root, projectSlug(repoA), HISTORY_DIR);
    expect(readdirSync(history)).toEqual(["db.2026-10-21T10-01-00-000Z.md"]);
    expect(readFileSync(path.join(history, readdirSync(history)[0] as string), "utf8")).toMatch(
      /v1/,
    );
    expect(notedProjects(root)).toEqual([repoA]);
  });

  it(`keeps the last ${KEPT_VERSIONS} versions of a topic`, () => {
    const root = tempDir("lore-memory-");
    for (let i = 0; i < KEPT_VERSIONS + 3; i++) {
      writeNote(root, { project: repoA, topic: "db", text: `v${i}`, by: "agent", now: at(i) });
    }
    const history = readdirSync(path.join(root, projectSlug(repoA), HISTORY_DIR));
    expect(history).toHaveLength(KEPT_VERSIONS);
    expect(history.sort()[0]).toBe("db.2026-10-21T10-02-00-000Z.md");
  });

  it("redacts secrets and refuses empty, oversized or relative-path notes", () => {
    const root = tempDir("lore-memory-");
    const { note } = writeNote(root, {
      project: repoA,
      topic: "deploy",
      text: "Deploy with token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      by: "agent",
    });
    expect(note.text).not.toMatch(/ghp_abc/);
    expect(note.text).toMatch(/\[REDACTED/);
    const bad = [
      { project: repoA, topic: "db", text: "   " },
      { project: repoA, topic: "???", text: "x" },
      { project: "relative", topic: "db", text: "x" },
      { project: repoA, topic: BRIEF_TOPIC, text: "x".repeat(MAX_BRIEF_CHARS + 1) },
    ];
    for (const input of bad) {
      expect(() => writeNote(root, { ...input, by: "agent" })).toThrow(NoteError);
    }
  });

  it(`refuses a new topic past ${MAX_TOPICS}, but still updates existing ones`, () => {
    const root = tempDir("lore-memory-");
    for (let i = 0; i < MAX_TOPICS; i++) {
      writeNote(root, { project: repoA, topic: `t${i}`, text: "x", by: "agent" });
    }
    expect(() =>
      writeNote(root, { project: repoA, topic: "one-more", text: "x", by: "agent" }),
    ).toThrow(/add to an existing topic/);
    expect(writeNote(root, { project: repoA, topic: "t0", text: "y", by: "agent" }).replaced).toBe(
      true,
    );
  });

  it("ignores a note copied into another project's folder", () => {
    const root = tempDir("lore-memory-");
    writeNote(root, { project: repoA, topic: "db", text: "A's", by: "agent" });
    const copied = readFileSync(path.join(root, projectSlug(repoA), "db.md"), "utf8");
    writeNote(root, { project: repoB, topic: "ui", text: "B's", by: "agent" });
    writeFileSync(path.join(root, projectSlug(repoB), "db.md"), copied);
    expect(readNotes(root, repoB).map((n) => n.topic)).toEqual(["ui"]);
  });

  it("keeps a note the user broke before replacing or forgetting it", () => {
    const root = tempDir("lore-memory-");
    writeNote(root, { project: repoA, topic: "db", text: "v1", by: "agent" });
    const file = path.join(root, projectSlug(repoA), "db.md");
    writeFileSync(file, "my own notes, front matter deleted");
    expect(writeNote(root, { project: repoA, topic: "db", text: "v2", by: "agent" }).replaced).toBe(
      true,
    );
    const history = path.join(root, projectSlug(repoA), HISTORY_DIR);
    const kept = readdirSync(history).map((name) => readFileSync(path.join(history, name), "utf8"));
    expect(kept).toContain("my own notes, front matter deleted");
    writeFileSync(file, "broken again");
    expect(forgetNote(root, repoA, "db")).toBe(true);
    expect(readdirSync(path.join(root, projectSlug(repoA)))).toEqual([HISTORY_DIR]);
  });

  it("forgets a note, keeping a copy in its history", () => {
    const root = tempDir("lore-memory-");
    writeNote(root, { project: repoA, topic: "db", text: "x", by: "agent" });
    expect(forgetNote(root, repoA, "db")).toBe(true);
    expect(forgetNote(root, repoA, "db")).toBe(false);
    expect(readNotes(root, repoA)).toEqual([]);
    expect(readdirSync(path.join(root, projectSlug(repoA), HISTORY_DIR))).toHaveLength(1);
  });
});

describe("groups", () => {
  it("links projects, including from a subfolder, and ignores an invalid file", () => {
    const root = tempDir("lore-memory-");
    expect(readGroups(root)).toEqual({});
    writeGroups(root, { acme: [repoA, repoB], other: [hostPath("/work/x")] });
    expect(relatedProjects(readGroups(root), path.join(repoA, "src"))).toEqual([
      { group: "acme", projects: [repoB] },
    ]);
    // A group holding a folder and its subfolders: the deepest one is the project itself.
    const parent = hostPath("/work/acme");
    const child = path.join(parent, "builder");
    expect(relatedProjects({ acme: [parent, child, repoB] }, path.join(child, "src"))).toEqual([
      { group: "acme", projects: [parent, repoB] },
    ]);
    writeFileSync(path.join(root, "groups.json"), '{"acme": "nope", "ok": ["relative", 3]}');
    expect(readGroups(root)).toEqual({});
  });
});

describe("user profile", () => {
  it("saves, replaces (keeping the old one) and stays out of the project notes", () => {
    const root = tempDir("lore-memory-");
    expect(readUserProfile(root)).toBeUndefined();
    writeUserProfile(root, {
      text: "- Prefers bullet points",
      by: "agent",
      now: at(1),
    });
    const second = writeUserProfile(root, {
      text: "- Prefers bullet points\n- Asks before deleting files",
      by: "consolidation",
      now: at(2),
    });
    expect(second.replaced).toBe(true);
    expect(readUserProfile(root)).toEqual({
      updated: "2026-10-21T10:02:00.000Z",
      by: "consolidation",
      text: "- Prefers bullet points\n- Asks before deleting files",
    });
    expect(readdirSync(path.join(root, USER_DIR, HISTORY_DIR))).toHaveLength(1);
    expect(notedProjects(root)).toEqual([]);
    expect(() =>
      writeUserProfile(root, { text: "x".repeat(MAX_PROFILE_CHARS + 1), by: "agent" }),
    ).toThrow(NoteError);
  });
});
