import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultAdapters } from "../../src/app.js";
import { DEFAULT_MAX_CHARS, DEFAULT_MAX_PROJECTS } from "../../src/core/consolidate.js";
import {
  KEPT_VERSIONS,
  MAX_BRIEF_CHARS,
  MAX_NOTE_CHARS,
  MAX_TOPICS,
} from "../../src/core/memory.js";
import { DEFAULT_PROMPT_TUNING, MAX_PROMPT_CONTEXT_CHARS } from "../../src/core/prompt-context.js";
import { MAX_SESSION_CONTEXT_CHARS } from "../../src/core/recall.js";
import { REFRESH_BUDGET_MS, STALE_AFTER_MS } from "../../src/core/runtime.js";
import { CANDIDATES } from "../../src/core/search.js";
import { NUDGE_BYTES } from "../../src/integrations/claude-memory-hooks.js";
import { DEFAULT_SEARCH_HITS as MCP_HITS } from "../../src/mcp/server.js";

// docs/how-it-works shows these values. When one changes, update the drawing and run
// `pnpm docs:pdf` (see AGENTS.md); this test only catches the numbers, not the whole picture.
const dir = path.join(import.meta.dirname, "..", "..", "docs", "how-it-works");
const html = readFileSync(path.join(dir, "how-it-works.html"), "utf8");

const TOOL_NAMES: Record<string, string> = {
  claude: "Claude Code",
  "claude-history": "JSONL + prompt history",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
  memory: "Project memory",
};

describe("docs/how-it-works", () => {
  it("has its PDF next to the source", () => {
    expect(existsSync(path.join(dir, "how-it-works.pdf"))).toBe(true);
  });

  it("shows every indexed tool", () => {
    for (const { tool } of defaultAdapters({})) {
      const name = TOOL_NAMES[tool];
      expect(name, `add ${tool} to TOOL_NAMES and to the drawing`).toBeDefined();
      expect(html).toContain(`>${name}</text>`);
    }
  });

  it("shows the current limits and thresholds", () => {
    expect(html).toContain(`≤ ${MAX_PROMPT_CONTEXT_CHARS} characters`);
    expect(html).toContain(`≤ ${DEFAULT_PROMPT_TUNING.maxMatchShare * 100}% of the index`);
    expect(html).toContain(`2 in ≤ ${DEFAULT_PROMPT_TUNING.specificShare * 100}% of the index`);
    expect(html).toContain(`score ≥ ${DEFAULT_PROMPT_TUNING.relativeScore * 100}%`);
    expect(html).toContain(`older than ${STALE_AFTER_MS / 60_000} minutes`);
    expect(html).toContain(`at most ~${REFRESH_BUDGET_MS / 1000} s`);
    expect(html).toContain(`best ${CANDIDATES} matches`);
    expect(html).toContain(`${MCP_HITS} short hits`);
    expect(html).toContain(`≤ ${MAX_SESSION_CONTEXT_CHARS.toLocaleString("en-US")} characters`);
    expect(html).toContain(`every ~${NUDGE_BYTES / 1000} KB`);
  });
});

describe("docs/project-memory", () => {
  const pm = path.join(import.meta.dirname, "..", "..", "docs", "project-memory");
  const blueprint = readFileSync(path.join(pm, "project-memory.html"), "utf8");
  const n = (value: number) => value.toLocaleString("en-US");

  it("has its PDF, and the README's image of it, next to the source", () => {
    expect(existsSync(path.join(pm, "project-memory.pdf"))).toBe(true);
    expect(existsSync(path.join(pm, "project-memory.png"))).toBe(true);
  });

  it("shows the current limits", () => {
    expect(blueprint).toContain(`≤ ${n(MAX_BRIEF_CHARS)} chars`);
    expect(blueprint).toContain(`≤ ${n(MAX_NOTE_CHARS)} chars · ≤ ${MAX_TOPICS} topics`);
    expect(blueprint).toContain(`last ${KEPT_VERSIONS} versions`);
    expect(blueprint).toContain(`≤ ${n(MAX_SESSION_CONTEXT_CHARS)} characters`);
    expect(blueprint).toContain(`≤ ${MAX_PROMPT_CONTEXT_CHARS} characters`);
    expect(blueprint).toContain(`~${NUDGE_BYTES / 1000} KB`);
    expect(blueprint).toContain(
      `${DEFAULT_MAX_PROJECTS} projects a run, ${n(DEFAULT_MAX_CHARS)} characters each`,
    );
  });
});
