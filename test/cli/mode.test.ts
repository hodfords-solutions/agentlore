import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, inject, it } from "vitest";
import { escapeRegExp, tempDir } from "../helpers.js";

const cli = inject("cliPath");
/** A sandbox with its own AGENTLORE_HOME and a project folder (real path, for cwd matching). */
function sandbox() {
  const dir = realpathSync(tempDir("lore-mode-cli-"));
  const project = join(dir, "work", "repo");
  mkdirSync(join(project, "src"), { recursive: true });
  const home = join(dir, "home");
  const env = { ...process.env, AGENTLORE_HOME: home };
  const run = (cwd: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, "mode", ...args], {
      env,
      cwd,
      encoding: "utf8",
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return { dir, project, home, run };
}

describe("lore mode", () => {
  it("is off by default and creates nothing when only reporting", () => {
    const { project, home, run } = sandbox();
    const shown = run(project);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toBe("knowledge mode here: off (default)\nglobal: off\nrules: none\n");
    expect(() => readFileSync(join(home, "mode.json"))).toThrow();
  });

  it("turns knowledge mode on and off globally", () => {
    const { project, home, run } = sandbox();
    const on = run(project, "on");
    expect(on.code).toBe(0);
    expect(on.stdout).toMatch(/^knowledge mode here: on \(global\)\nglobal: on\n/);
    expect(JSON.parse(readFileSync(join(home, "mode.json"), "utf8"))).toEqual({ global: "on" });
    expect(run(project, "off").stdout).toMatch(/^knowledge mode here: off \(global\)/);
  });

  it("sets, applies to subfolders, and resets a rule for the current folder", () => {
    const { project, run } = sandbox();
    const here = run(project, "on", "--here");
    expect(here.code).toBe(0);
    const rule = escapeRegExp(project);
    expect(here.stdout).toMatch(new RegExp(`^knowledge mode here: on \\(rule for ${rule}\\)\n`));
    expect(here.stdout).toMatch(new RegExp(`^rules:\n {2}on {2}${rule}$`, "m"));
    expect(run(join(project, "src")).stdout).toMatch(/^knowledge mode here: on \(rule for /);
    // A global change does not override the folder rule.
    expect(run(project, "off").stdout).toMatch(/^knowledge mode here: on \(rule for /);
    const reset = run(project, "reset", "--here");
    expect(reset.stdout).toMatch(/^knowledge mode here: off \(global\)\n/);
    expect(reset.stdout).toMatch(/rules: none/);
  });

  it("rejects an unknown state and reset without --here", () => {
    const { project, run } = sandbox();
    const bad = run(project, "maybe");
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/on, off or reset/);
    const reset = run(project, "reset");
    expect(reset.code).toBe(1);
    expect(reset.stderr).toMatch(/--here/);
  });

  it("treats a corrupt mode file as off, with a warning, and refuses to overwrite it", () => {
    const { project, home, run } = sandbox();
    mkdirSync(home, { recursive: true });
    const file = join(home, "mode.json");
    writeFileSync(file, "{");
    const shown = run(project);
    expect(shown.stdout).toMatch(/^knowledge mode here: off \(default\)/);
    expect(shown.stderr).toMatch(/^warning: .*mode\.json is not valid JSON/);
    const refused = run(project, "on");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/mode\.json is not valid JSON.*nothing was changed/);
    expect(readFileSync(file, "utf8")).toBe("{");
  });

  it("keeps the other rules when one field is invalid", () => {
    const { dir, project, home, run } = sandbox();
    mkdirSync(home, { recursive: true });
    mkdirSync(join(dir, "other"));
    const file = join(home, "mode.json");
    const content = JSON.stringify({ global: "On", paths: { [join(dir, "other")]: "on" } });
    writeFileSync(file, content);
    const refused = run(project, "on", "--here");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/"global" must be "on" or "off"/);
    expect(readFileSync(file, "utf8")).toBe(content);
    // The hook's lenient read still applies the valid rule.
    expect(run(join(dir, "other")).stdout).toMatch(/^knowledge mode here: on \(rule for /);
  });
});
