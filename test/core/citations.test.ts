import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCitation } from "../../src/core/citations.js";
import { tempDir } from "../helpers.js";

describe("checkCitation", () => {
  it("says when a cited file is gone, its line is gone, or it changed since", () => {
    const project = tempDir("lore-cite-");
    mkdirSync(join(project, "docs"));
    const file = join(project, "docs", "status.md");
    writeFileSync(file, "one\ntwo\nthree\n");
    const then = new Date(Date.now() - 60_000);
    utimesSync(file, then, then);
    const after = new Date().toISOString();
    expect(checkCitation("docs/status.md:2", project, after)).toBeUndefined();
    expect(checkCitation("docs/status.md:40", project, after)).toBe("line gone");
    expect(checkCitation("docs/status.md", project, "2000-01-01T00:00:00Z")).toBe("changed");
    expect(checkCitation("docs/missing.md:3", project, after)).toBe("gone");
    // A folder that is not there: the path was likely relative to another folder.
    expect(checkCitation("specs/plan.md:3", project, after)).toBeUndefined();
    expect(checkCitation(file, "", after)).toBeUndefined();
  });

  it("does not guess where a bare file name or a path without a project is", () => {
    expect(checkCitation("missing.md:3", "/nowhere", "2026-01-01T00:00:00Z")).toBeUndefined();
    expect(checkCitation("docs/missing.md", "", "2026-01-01T00:00:00Z")).toBeUndefined();
  });
});
