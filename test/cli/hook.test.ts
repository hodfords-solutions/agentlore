import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, inject, it } from "vitest";
import { PROMPT_CONTEXT_HEADER } from "../../src/core/prompt-context.js";
import { fixtureSandbox, hostPath, removeDir } from "../helpers.js";

const cli = inject("cliPath");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function run(env: NodeJS.ProcessEnv, args: string[], input?: string) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args], { env, input, encoding: "utf8" });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ms: performance.now() - started,
  };
}

const hookInput = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: "another-session",
    transcript_path: "/tmp/t.jsonl",
    cwd: hostPath("/work/repo-c"),
    hook_event_name: "UserPromptSubmit",
    prompt: "Why did the payment webhook retry twice last time?",
    ...over,
  });

/** An indexed sandbox with knowledge mode set globally to `mode`. */
function indexed(mode: "on" | "off") {
  const env = fixtureSandbox(dirs);
  expect(run(env, ["index"]).code).toBe(0);
  writeFileSync(join(env.AGENTLORE_HOME as string, "mode.json"), JSON.stringify({ global: mode }));
  return env;
}

describe("lore hook claude-prompt", () => {
  it("prints additionalContext JSON with related excerpts when knowledge mode is on, fast", () => {
    const env = indexed("on");
    const result = run(env, ["hook", "claude-prompt"], hookInput());
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const context = output.hookSpecificOutput.additionalContext;
    expect(context.split("\n")[0]).toBe(PROMPT_CONTEXT_HEADER);
    expect(context).toMatch(/^\[1\] [0-9a-f]{8} claude /m);
    expect(context.length).toBeLessThanOrEqual(1200);
    // Node's start-up included; a generous bound for slow CI runners (typically ~150 ms).
    expect(result.ms).toBeLessThan(3000);
  });

  it("leaves out the current session", () => {
    const env = indexed("on");
    const result = run(env, ["hook", "claude-prompt"], hookInput({ session_id: "claude-s1" }));
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/Stripe/);
  });

  it("prints nothing when knowledge mode is off, or for a trivial prompt or slash command", () => {
    expect(run(indexed("off"), ["hook", "claude-prompt"], hookInput()).stdout).toBe("");
    const env = indexed("on");
    for (const prompt of ["ok, do it", "/compact payment webhook retry twice"]) {
      expect(run(env, ["hook", "claude-prompt"], hookInput({ prompt })).stdout).toBe("");
    }
  });

  it("never fails the prompt: bad input or no index prints nothing and exits 0", () => {
    const env = indexed("on");
    for (const input of ["not json", "", JSON.stringify({ prompt: "x" })]) {
      const result = run(env, ["hook", "claude-prompt"], input);
      expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    }
    const debug = run({ ...env, AGENTLORE_DEBUG: "1" }, ["hook", "claude-prompt"], "not json");
    expect(debug).toMatchObject({ code: 0, stdout: "" });
    expect(debug.stderr).toMatch(/^agentlore hook: claude-prompt failed: /);

    const empty = fixtureSandbox(dirs);
    mkdirSync(empty.AGENTLORE_HOME as string, { recursive: true });
    writeFileSync(join(empty.AGENTLORE_HOME as string, "mode.json"), '{"global":"on"}');
    expect(run(empty, ["hook", "claude-prompt"], hookInput())).toMatchObject({
      code: 0,
      stdout: "",
      stderr: "",
    });
    // No index is created by the hook; only its record of what this session has seen.
    expect(readdirSync(empty.AGENTLORE_HOME as string).sort()).toEqual(["mode.json", "state"]);
  });
});

describe("lore hooks", () => {
  it("installs, reports and uninstalls the Claude Code hook in the settings file", () => {
    const env = fixtureSandbox(dirs);
    const config = join(env.AGENTLORE_HOME as string, "..", "claude-config");
    mkdirSync(config);
    const settings = join(config, "settings.json");
    writeFileSync(settings, JSON.stringify({ model: "opus" }));
    const claudeEnv = { ...env, CLAUDE_CONFIG_DIR: config };

    const installed = run(claudeEnv, ["hooks", "install", "claude"]);
    expect(installed.code).toBe(0);
    expect(installed.stdout).toMatch(/^Installed the agentlore hooks in .*settings\.json\.$/m);
    expect(installed.stdout).toMatch(/^Backup: .*settings\.json\.agentlore-backup-/m);
    const hook = JSON.parse(readFileSync(settings, "utf8")).hooks.UserPromptSubmit[0].hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.timeout).toBe(5);
    expect(hook.command).toContain(" hook claude-prompt");
    expect(hook.command).toContain(process.execPath);
    expect(run(claudeEnv, ["hooks", "install", "claude"]).stdout).toMatch(/^Already installed/);

    const status = run(claudeEnv, ["hooks", "status"]);
    expect(status.stdout).toMatch(/^claude: installed in /);
    expect(status.stderr).toBe("");
    expect(status.stdout).toMatch(/^knowledge mode here: off$/m);

    // The installed command runs as written, through a shell.
    const ran = spawnSync(hook.command, {
      shell: true,
      env: claudeEnv,
      input: "{}",
      encoding: "utf8",
    });
    expect(ran).toMatchObject({ status: 0, stdout: "" });

    // A moved agentlore: status warns that the hook cannot run.
    const moved = readFileSync(settings, "utf8").replace(
      /[^" ]*cli\/index\.js/,
      "/gone/cli/index.js",
    );
    writeFileSync(settings, moved);
    expect(run(claudeEnv, ["hooks", "status"]).stderr).toMatch(
      /^warning: \/gone\/cli\/index\.js does not exist; the hook cannot run/,
    );

    const removed = run(claudeEnv, ["hooks", "uninstall", "claude"]);
    expect(removed.stdout).toMatch(/^Removed the agentlore hooks/);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ model: "opus" });
    expect(run(claudeEnv, ["hooks", "status"]).stdout).toMatch(/^claude: not installed/);
    expect(run(claudeEnv, ["hooks", "uninstall", "claude"]).stdout).toMatch(/^Not installed/);
  });

  it("takes the settings file from --settings and refuses an invalid one or another agent", () => {
    const env = fixtureSandbox(dirs);
    const settings = join(env.AGENTLORE_HOME as string, "..", "custom.json");
    writeFileSync(settings, "{ not json");
    const refused = run(env, ["hooks", "install", "claude", "--settings", settings]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/not valid JSON.*nothing was changed/);
    expect(readFileSync(settings, "utf8")).toBe("{ not json");
    const cursor = run(env, ["hooks", "install", "cursor", "--settings", settings]);
    expect(cursor.code).toBe(1);
    expect(cursor.stderr).toMatch(/only claude/);
  });
});
