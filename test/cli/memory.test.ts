import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, inject, it } from "vitest";
import { BRIEF_TOPIC, writeNote } from "../../src/core/memory.js";
import { fixtureSandbox, hostPath, removeDir } from "../helpers.js";

const cli = inject("cliPath");
const repoA = hostPath("/work/repo-a");
const repoB = hostPath("/work/repo-b");
const dirs: string[] = [];

function run(env: NodeJS.ProcessEnv, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", input });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterAll(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

const memoryRoot = (env: NodeJS.ProcessEnv) => path.join(env.AGENTLORE_HOME as string, "memory");

describe("lore memory and lore group", () => {
  it("shows, lists, indexes and forgets notes, and links projects in groups", () => {
    const env = fixtureSandbox(dirs);
    writeNote(memoryRoot(env), {
      project: repoA,
      topic: BRIEF_TOPIC,
      text: "Repo A takes payments through Stripe webhooks.",
      by: "agent",
    });
    writeNote(memoryRoot(env), { project: repoA, topic: "db", text: "Ledger tables", by: "agent" });

    expect(run(env, ["memory", "show", "-p", repoA]).stdout).toMatch(
      /^# brief \(by agent, \d{4}-\d\d-\d\d\)\n\nRepo A takes payments.*\n\n- db \(by agent/m,
    );
    expect(run(env, ["memory", "show", "db", "-p", repoA]).stdout).toMatch(/Ledger tables/);
    expect(run(env, ["memory", "show", "nope", "-p", repoA])).toMatchObject({ code: 1 });
    expect(run(env, ["memory", "list"]).stdout).toMatch(/repo-a\s+2 notes, updated/);
    expect(run(env, ["memory", "path", "-p", repoA]).stdout.trim()).toMatch(
      /memory[\\/]repo-a-[0-9a-f]{8}$/,
    );

    expect(run(env, ["index"]).code).toBe(0);
    expect(run(env, ["status"]).stdout).toMatch(/^memory\s+2 sources/m);
    expect(run(env, ["status"]).stdout).toMatch(/^project memory: 1 project with notes$/m);
    expect(run(env, ["search", "ledger", "tables"]).stdout).toMatch(/memory .*note db/);

    // Saving from the command line: for sessions whose MCP server lacks `remember`.
    expect(
      run(
        env,
        ["memory", "save", "deploy", "-p", repoA, "--by", "agent"],
        "Deploys go out on Fridays.",
      ).stdout,
    ).toMatch(/^Saved the deploy note of /);
    expect(run(env, ["memory", "show", "deploy", "-p", repoA]).stdout).toMatch(
      /^# deploy \(by agent, .*\n\nDeploys go out on Fridays\.$/m,
    );
    expect(run(env, ["search", "deploys", "fridays"]).stdout).toMatch(/note deploy/);
    expect(run(env, ["memory", "save", "user"], "- Prefers short answers").stdout).toBe(
      "Saved your user profile.\n",
    );
    expect(run(env, ["memory", "show", "user"]).stdout).toMatch(
      /^# user profile \(by user, .*\n\n- Prefers short answers$/m,
    );
    expect(run(env, ["memory", "save", "x", "-p", repoA], "")).toMatchObject({ code: 1 });
    expect(run(env, ["memory", "save", "x", "-p", repoA, "--by", "bot"], "y")).toMatchObject({
      code: 1,
    });
    expect(run(env, ["memory", "forget", "db", "-p", repoA]).stdout).toMatch(/Deleted the db note/);
    expect(run(env, ["search", "ledger", "tables"]).stdout).not.toMatch(/note db/);

    expect(run(env, ["group", "add", "acme", repoA, repoB]).stdout).toMatch(/^group acme: /);
    expect(run(env, ["memory", "show", "-p", repoA]).stdout).toMatch(/^group acme: .*repo-b$/m);
    expect(run(env, ["group", "list"]).stdout).toMatch(/^acme: /);
    expect(run(env, ["group", "remove", "acme", repoB]).stdout).toMatch(
      /^Removed group acme\.$|^group acme: [^,]+$/m,
    );
    expect(run(env, ["group", "remove", "acme"])).toMatchObject({ code: 0 });
    expect(run(env, ["group", "list"]).stdout).toMatch(/^No groups/);
  });
});

describe.skipIf(process.platform === "win32")("lore consolidate", () => {
  it("updates notes with claude -p, then finds them", () => {
    const env = fixtureSandbox(dirs);
    // A session long enough to be worth a pass.
    const folder = path.join(env.AGENTLORE_CLAUDE_DIR as string, "-work-repo-b");
    mkdirSync(folder, { recursive: true });
    const line = (text: string, minute: number) =>
      JSON.stringify({
        type: "user",
        sessionId: "long-b",
        cwd: repoB,
        timestamp: `2026-10-20T10:${String(minute).padStart(2, "0")}:00.000Z`,
        message: { role: "user", content: text },
      });
    writeFileSync(
      path.join(folder, "long-b.jsonl"),
      `${[1, 2, 3].map((m) => line("The warehouse import runs nightly and is idempotent. ".repeat(20), m)).join("\n")}\n`,
    );
    const bin = path.join(env.AGENTLORE_HOME as string, "..", "bin");
    mkdirSync(bin, { recursive: true });
    const answer = path.join(bin, "answer.json");
    writeFileSync(
      answer,
      JSON.stringify({
        is_error: false,
        result: JSON.stringify({
          notes: [{ topic: "brief", text: "Warehouse import runs nightly" }],
        }),
      }),
    );
    writeFileSync(path.join(bin, "claude"), `#!/bin/sh\ncat > /dev/null\ncat "${answer}"\n`);
    chmodSync(path.join(bin, "claude"), 0o755);
    const withClaude = { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` };
    expect(run(withClaude, ["index"]).code).toBe(0);

    const dry = run(withClaude, ["consolidate", "--dry-run"]);
    expect(dry.stdout).toMatch(/repo-b: \d+ characters of new excerpts since the start/);

    const result = run(withClaude, ["consolidate", "-p", repoB]);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/repo-b: updated brief \(\d+ characters read\)/);
    expect(run(withClaude, ["memory", "show", "-p", repoB]).stdout).toMatch(
      /by consolidation.*\n\nWarehouse import runs nightly/,
    );
    expect(run(withClaude, ["search", "warehouse", "nightly"]).stdout).toMatch(
      /memory .*note brief/,
    );
    expect(run(withClaude, ["consolidate", "-p", repoB]).stdout).toMatch(/^Nothing to consolidate/);
  });
});

describe("lore hook claude-session-start", () => {
  it("adds the project's memory where knowledge mode is on, and nothing in sessions agentlore starts", () => {
    const env = fixtureSandbox(dirs);
    writeNote(memoryRoot(env), {
      project: repoA,
      topic: BRIEF_TOPIC,
      text: "Repo A brief",
      by: "agent",
    });
    mkdirSync(env.AGENTLORE_HOME as string, { recursive: true });
    writeFileSync(
      path.join(env.AGENTLORE_HOME as string, "mode.json"),
      JSON.stringify({ global: "on" }),
    );
    const input = JSON.stringify({ session_id: "s", cwd: repoA, source: "startup" });
    const out = run(env, ["hook", "claude-session-start"], input);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toMatch(/> Repo A brief/);
    expect(
      run({ ...env, AGENTLORE_NO_HOOKS: "1" }, ["hook", "claude-session-start"], input).stdout,
    ).toBe("");
    expect(run(env, ["hook", "claude-stop"], "not json")).toMatchObject({ code: 0, stdout: "" });
  });
});
