import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BRIEF_TOPIC, writeNote, writeUserProfile } from "../../src/core/memory.js";
import { claudePromptHook } from "../../src/integrations/claude-code.js";
import {
  CORRECTION_REASON,
  claudeSessionEndHook,
  claudeSessionStartHook,
  claudeStopHook,
  DECISION_REASON,
  NUDGE_BYTES,
  NUDGE_REASON,
  notesChangedNotice,
} from "../../src/integrations/claude-memory-hooks.js";
import { hostPath, tempDir } from "../helpers.js";

const repo = hostPath("/work/shop-api");
const on = () => "on" as const;

describe("claudeSessionStartHook", () => {
  const input = JSON.stringify({ session_id: "s", cwd: path.join(repo, "src"), source: "startup" });

  it("adds the project's memory where knowledge mode is on", () => {
    const root = tempDir("lore-start-");
    writeNote(root, { project: repo, topic: BRIEF_TOPIC, text: "Shop API on NestJS", by: "agent" });
    const out = claudeSessionStartHook(input, {
      modeFor: on,
      memoryRoot: root,
      projectOf: () => repo,
    });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/> Shop API on NestJS/);
  });

  it("adds nothing where knowledge mode is off or outside a project", () => {
    const root = tempDir("lore-start-");
    expect(claudeSessionStartHook(input, { modeFor: () => "off", memoryRoot: root })).toBe("");
    expect(
      claudeSessionStartHook(input, { modeFor: on, memoryRoot: root, projectOf: () => undefined }),
    ).toBe("");
    expect(() => claudeSessionStartHook("not json", { modeFor: on, memoryRoot: root })).toThrow();
  });
});

describe("claudeStopHook", () => {
  function setup() {
    const dir = tempDir("lore-stop-");
    const transcript = path.join(dir, "t.jsonl");
    writeFileSync(transcript, "");
    const deps = {
      modeFor: on,
      statePath: path.join(dir, "state", "nudges.json"),
      now: () => new Date("2026-10-21T10:00:00Z"),
    };
    const stop = (over: Record<string, unknown> = {}) =>
      claudeStopHook(
        JSON.stringify({
          session_id: "s1",
          transcript_path: transcript,
          cwd: repo,
          stop_hook_active: false,
          ...over,
        }),
        deps,
      );
    const grow = (bytes: number, text = "x") => appendFileSync(transcript, text.repeat(bytes));
    return { stop, grow, deps, transcript };
  }

  it(`asks once per ${NUDGE_BYTES} bytes of new transcript`, () => {
    const { stop, grow } = setup();
    grow(NUDGE_BYTES - 1);
    expect(stop()).toBe("");
    grow(1);
    expect(JSON.parse(stop())).toEqual({ decision: "block", reason: NUDGE_REASON });
    // The agent answered: it may stop now.
    expect(stop({ stop_hook_active: true })).toBe("");
    grow(1000);
    expect(stop()).toBe("");
    grow(NUDGE_BYTES);
    expect(stop()).not.toBe("");
  });

  it("does not ask when the agent saved something since, or where the mode is off", () => {
    const { stop, grow, deps, transcript } = setup();
    grow(NUDGE_BYTES);
    appendFileSync(transcript, '{"name":"mcp__agentlore__remember"}');
    expect(stop()).toBe("");
    grow(NUDGE_BYTES);
    const input = JSON.stringify({ session_id: "s1", transcript_path: transcript, cwd: repo });
    expect(claudeStopHook(input, { ...deps, modeFor: () => "off" })).toBe("");
    expect(stop({ transcript_path: path.join(repo, "missing.jsonl") })).toBe("");
    expect(stop()).not.toBe("");
  });

  it("drops sessions not seen for 30 days from its state", () => {
    const { stop, grow, deps } = setup();
    grow(NUDGE_BYTES);
    stop();
    const state = JSON.parse(readFileSync(deps.statePath, "utf8"));
    writeFileSync(
      deps.statePath,
      JSON.stringify({ old: { bytes: 1, at: "2026-08-01T00:00:00Z" }, ...state }),
    );
    grow(NUDGE_BYTES);
    stop();
    expect(Object.keys(JSON.parse(readFileSync(deps.statePath, "utf8")))).toEqual(["s1"]);
  });
});

/** A Claude Code transcript line. */
const turn = (role: "user" | "assistant", text: string) =>
  `${JSON.stringify({
    type: role,
    sessionId: "s1",
    cwd: repo,
    timestamp: "2026-10-21T10:00:00Z",
    message: { role, content: text },
  })}\n`;

describe("claudeStopHook on decisions", () => {
  function setup() {
    const dir = tempDir("lore-stop-");
    const transcript = path.join(dir, "t.jsonl");
    writeFileSync(transcript, "");
    const deps = {
      modeFor: on,
      statePath: path.join(dir, "state", "nudges.json"),
      sessionsPath: path.join(dir, "state", "sessions.json"),
      now: () => new Date("2026-10-21T10:00:00Z"),
    };
    const stop = () =>
      claudeStopHook(
        JSON.stringify({ session_id: "s1", transcript_path: transcript, cwd: repo }),
        deps,
      );
    return { stop, transcript, deps };
  }

  it("asks at once when the user decided something, however short the session", () => {
    const { stop, transcript } = setup();
    appendFileSync(transcript, turn("user", "Which database should we use?"));
    appendFileSync(transcript, turn("assistant", "I would go with Postgres here."));
    // The agent's own suggestion is not the user's decision.
    expect(stop()).toBe("");
    appendFileSync(transcript, turn("user", "OK, we'll go with Postgres for the ledger."));
    expect(JSON.parse(stop())).toEqual({ decision: "block", reason: DECISION_REASON });
    // Asked once: nothing new since.
    expect(stop()).toBe("");
    appendFileSync(transcript, turn("user", "Chốt dùng hàng đợi Redis."));
    expect(stop()).not.toBe("");
  });

  it("does not ask when the agent saved a note, and records that the session has seen it", () => {
    const { stop, transcript, deps } = setup();
    appendFileSync(transcript, turn("user", "We'll go with Postgres."));
    appendFileSync(transcript, '{"type":"assistant","name":"mcp__agentlore__remember"}\n');
    expect(stop()).toBe("");
    expect(JSON.parse(readFileSync(deps.sessionsPath, "utf8"))).toEqual({
      s1: { at: "2026-10-21T10:00:00.000Z" },
    });
  });
});

describe("notesChangedNotice", () => {
  it("names the notes changed since the session's last prompt, once", () => {
    const root = tempDir("lore-notice-");
    const deps = {
      memoryRoot: root,
      sessionsPath: path.join(root, "..", `${path.basename(root)}-sessions.json`),
      projectOf: () => repo,
    };
    let clock = new Date("2026-10-21T10:00:00Z");
    const notice = () =>
      notesChangedNotice({ cwd: repo, sessionId: "s1" }, { ...deps, now: () => clock });
    writeNote(root, {
      project: repo,
      topic: "db",
      text: "Postgres",
      by: "agent",
      now: new Date("2026-10-21T09:00:00Z"),
    });
    // The first prompt of a session that did not start with the hook only records it.
    expect(notice()).toBeUndefined();
    writeNote(root, {
      project: repo,
      topic: "db",
      text: "Postgres 16",
      by: "agent",
      now: new Date("2026-10-21T10:05:00Z"),
    });
    clock = new Date("2026-10-21T10:10:00Z");
    expect(notice()).toMatch(
      /^agentlore: this project's notes changed since your last prompt: db \(by agent, 2026-10-21 10:05 UTC\)\. Call `recall`/,
    );
    clock = new Date("2026-10-21T10:20:00Z");
    expect(notice()).toBeUndefined();
    expect(notesChangedNotice({ cwd: repo }, deps)).toBeUndefined();
  });

  it("is added to a prompt even without an index or related excerpts", () => {
    const out = claudePromptHook(JSON.stringify({ session_id: "s1", cwd: repo, prompt: "ok" }), {
      modeFor: on,
      openIndex: () => undefined,
      notice: () => "agentlore: notes changed",
    });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe("agentlore: notes changed");
  });
});

describe("claudeSessionEndHook", () => {
  it("indexes the ended session where knowledge mode is on", () => {
    let started = 0;
    const startIndex = () => {
      started++;
    };
    const input = JSON.stringify({ session_id: "s1", cwd: repo, reason: "exit" });
    expect(claudeSessionEndHook(input, { modeFor: on, startIndex })).toBe("");
    expect(claudeSessionEndHook(input, { modeFor: () => "off", startIndex })).toBe("");
    expect(started).toBe(1);
  });
});

describe("the user profile in hooks", () => {
  it("is given at start even outside a project", () => {
    const root = tempDir("lore-start-");
    writeUserProfile(root, { text: "- Short answers", by: "agent" });
    const input = JSON.stringify({ session_id: "s", cwd: "/", source: "startup" });
    const out = claudeSessionStartHook(input, {
      modeFor: on,
      memoryRoot: root,
      projectOf: () => undefined,
    });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toMatch(/> - Short answers/);
  });

  it("asks to save a correction to the user profile", () => {
    const dir = tempDir("lore-stop-");
    const transcript = path.join(dir, "t.jsonl");
    writeFileSync(transcript, turn("user", "No, that's wrong: always ask before deleting files."));
    const out = claudeStopHook(
      JSON.stringify({ session_id: "s1", transcript_path: transcript, cwd: repo }),
      {
        modeFor: on,
        statePath: path.join(dir, "nudges.json"),
      },
    );
    expect(JSON.parse(out)).toEqual({ decision: "block", reason: CORRECTION_REASON });
  });
});
