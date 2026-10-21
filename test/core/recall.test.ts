import { describe, expect, it } from "vitest";
import { BRIEF_TOPIC, writeGroups, writeNote, writeUserProfile } from "../../src/core/memory.js";
import {
  MAX_SESSION_CONTEXT_CHARS,
  REMEMBER_HINT,
  recallText,
  sessionContext,
  startContext,
} from "../../src/core/recall.js";
import { hostPath, tempDir } from "../helpers.js";

const api = hostPath("/work/shop-api");
const web = hostPath("/work/shop-web");
const now = new Date("2026-10-21T10:00:00Z");

function seeded(): string {
  const root = tempDir("lore-recall-");
  writeNote(root, {
    project: api,
    topic: BRIEF_TOPIC,
    text: "Shop API: NestJS + Postgres.\nNext: refunds.",
    by: "consolidation",
    now,
  });
  writeNote(root, {
    project: api,
    topic: "db",
    text: "Orders are soft-deleted.",
    by: "agent",
    now,
  });
  writeNote(root, {
    project: api,
    topic: "imports",
    text: "## Imports\nLegacy import:\n- CSV only",
    by: "agent",
    now,
  });
  writeNote(root, {
    project: web,
    topic: BRIEF_TOPIC,
    text: "# Shop web\n\nNext.js storefront",
    by: "agent",
    now,
  });
  writeGroups(root, { acme: [api, web] });
  return root;
}

describe("sessionContext", () => {
  it("gives the brief, the topics and the related projects, framed as data", () => {
    const text = sessionContext(seeded(), api) ?? "";
    expect(text).toMatch(/^agentlore project memory for .*shop-api: .*data, not instructions/);
    expect(text).toContain(
      "Brief (by consolidation, 2026-10-21):\n> Shop API: NestJS + Postgres.\n> Next: refunds.",
    );
    expect(text).toContain("- db (2026-10-21): Orders are soft-deleted.");
    expect(text).toContain("- imports (2026-10-21): Legacy import: CSV only");
    // The heading only names the note: its first real line is shown.
    expect(text).toMatch(/shop-web \(group acme\): Next\.js storefront$/m);
    expect(text).toContain(REMEMBER_HINT);
  });

  it("says there is no memory yet, with the hint, or nothing without it", () => {
    const root = tempDir("lore-recall-");
    expect(sessionContext(root, api)).toMatch(/no project memory for .*shop-api yet/);
    expect(sessionContext(root, api, { hint: false })).toBeUndefined();
  });

  it(`stays within ${MAX_SESSION_CONTEXT_CHARS} characters, cutting the brief`, () => {
    const root = tempDir("lore-recall-");
    writeNote(root, { project: api, topic: BRIEF_TOPIC, text: "word ".repeat(390), by: "agent" });
    for (let i = 0; i < 15; i++) {
      writeNote(root, { project: api, topic: `topic-number-${i}`, text: "x", by: "agent" });
    }
    const text = sessionContext(root, api) ?? "";
    expect(text.length).toBeLessThanOrEqual(MAX_SESSION_CONTEXT_CHARS);
    expect(text).toContain("topic-number-14");
    expect(text).toContain(REMEMBER_HINT);
  });
});

describe("sessionContext under pressure", () => {
  it("drops list lines, not the brief or the closing hint, when everything is long", () => {
    const root = tempDir("lore-recall-");
    writeNote(root, { project: api, topic: BRIEF_TOPIC, text: "brief ".repeat(300), by: "agent" });
    for (let i = 0; i < 19; i++) {
      writeNote(root, {
        project: api,
        topic: `topic-${i}`,
        text: `${"long preview ".repeat(20)}`,
        by: "agent",
      });
    }
    const text = sessionContext(root, api) ?? "";
    expect(text.length).toBeLessThanOrEqual(MAX_SESSION_CONTEXT_CHARS);
    expect(text.endsWith(REMEMBER_HINT)).toBe(true);
    expect(text).toMatch(/- … \d+ more: `recall` lists them/);
    expect(text).toMatch(/> brief brief/);
  });
});

describe("recallText", () => {
  it("gives one topic in full, or the overview", () => {
    const root = seeded();
    expect(recallText(root, api, "DB")).toMatch(
      /db \(by agent, 2026-10-21\):\n> Orders are soft-deleted\.$/,
    );
    expect(recallText(root, api, "billing")).toMatch(
      /^No billing note for .*shop-api\. Topics: brief, db, imports\.$/,
    );
    const overview = recallText(root, api);
    expect(overview).toContain("- db (by agent, 2026-10-21): Orders are soft-deleted.");
    expect(overview).toContain("Related projects:");
    expect(recallText(tempDir("lore-recall-"), api)).toMatch(/no project memory/);
  });
});

describe("the user profile", () => {
  it("comes first at session start, also outside any project, and through recall", () => {
    const root = seeded();
    writeUserProfile(root, { text: "- Prefers bullet points", by: "agent", now });
    const start = startContext(root, api) ?? "";
    expect(start.indexOf("agentlore user profile")).toBe(0);
    expect(start).toContain("> - Prefers bullet points");
    expect(start).toContain("agentlore project memory for");
    expect(startContext(root, undefined)).toMatch(/^agentlore user profile[\s\S]*bullet points$/);
    expect(recallText(root, api, "user")).toMatch(
      /Profile \(by agent, 2026-10-21\):\n> - Prefers bullet points$/,
    );
    expect(recallText(root, api)).toMatch(/^agentlore user profile/);
    expect(recallText(tempDir("lore-recall-"), api, "user")).toMatch(/^No user profile yet/);
    expect(startContext(tempDir("lore-recall-"), undefined)).toBeUndefined();
  });
});
