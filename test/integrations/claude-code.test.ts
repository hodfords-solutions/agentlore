import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROMPT_CONTEXT_HEADER } from "../../src/core/prompt-context.js";
import { openStore, type Store } from "../../src/core/store.js";
import {
  CLAUDE_HOOK_TIMEOUT,
  claudeHookStatus,
  claudePromptHook,
  claudeSettingsPath,
  gitRoot,
  hookCommand,
  hookCommandPaths,
  installClaudeHook,
  KEPT_BACKUPS,
  sessionProject,
  uninstallClaudeHook,
} from "../../src/integrations/claude-code.js";
import { chunk, hostPath, seed, tempDir } from "../helpers.js";

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function seeded(): Store {
  const store = openStore(":memory:");
  stores.push(store);
  seed(store, "/a", [
    chunk({
      sessionId: "past",
      text: "Stripe webhook retries twice because of the idempotency check",
    }),
  ]);
  seed(store, "/b", [
    chunk({
      sessionId: "current",
      text: "Webhook idempotency is what we are discussing right now",
    }),
  ]);
  return store;
}

const input = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: "current",
    transcript_path: "/tmp/t.jsonl",
    cwd: hostPath("/work/repo"),
    hook_event_name: "UserPromptSubmit",
    prompt: "How did we fix the webhook idempotency retries before?",
    ...over,
  });

describe("claudePromptHook", () => {
  it("adds related excerpts from other sessions as additionalContext when the mode is on", () => {
    let opened = 0;
    const out = claudePromptHook(input(), {
      modeFor: (cwd) => (cwd === hostPath("/work/repo") ? "on" : "off"),
      openIndex: () => {
        opened++;
        return seeded();
      },
    });
    const parsed = JSON.parse(out) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const context = parsed.hookSpecificOutput.additionalContext;
    expect(context.split("\n")[0]).toBe(PROMPT_CONTEXT_HEADER);
    expect(context).toMatch(/Stripe/);
    expect(context).not.toMatch(/discussing right now/);
    expect(opened).toBe(1);
  });

  it("includes the session's own project: its other sessions are what this one lacks", () => {
    const deps = { modeFor: () => "on" as const, openIndex: seeded };
    const out = claudePromptHook(input({ cwd: hostPath("/work/repo-a/src") }), deps);
    expect(out).toMatch(/Stripe/);
  });

  it("prints nothing, without opening the index, when the mode is off", () => {
    const out = claudePromptHook(input(), {
      modeFor: () => "off",
      openIndex: () => {
        throw new Error("must not open");
      },
    });
    expect(out).toBe("");
  });

  it("prints nothing for trivial prompts, slash commands, no index or no match", () => {
    const deps = { modeFor: () => "on" as const, openIndex: seeded };
    expect(claudePromptHook(input({ prompt: "yes go on" }), deps)).toBe("");
    expect(claudePromptHook(input({ prompt: "/compact webhook idempotency retries" }), deps)).toBe(
      "",
    );
    expect(claudePromptHook(input({ prompt: "Describe the warehouse seeding job" }), deps)).toBe(
      "",
    );
    expect(claudePromptHook(input(), { modeFor: () => "on", openIndex: () => undefined })).toBe("");
  });

  it("rejects input that is not a UserPromptSubmit payload", () => {
    const deps = { modeFor: () => "on" as const, openIndex: seeded };
    expect(() => claudePromptHook("not json", deps)).toThrow();
    expect(() => claudePromptHook(JSON.stringify({ prompt: 3, cwd: "/x" }), deps)).toThrow(
      /prompt/,
    );
    expect(() => claudePromptHook(JSON.stringify({ prompt: "x".repeat(30) }), deps)).toThrow(/cwd/);
  });

  it("closes the index it opened, even when the search fails", () => {
    const store = seeded();
    const broken: Store = {
      ...store,
      countMatches: () => {
        throw new Error("boom");
      },
    };
    expect(() =>
      claudePromptHook(input(), { modeFor: () => "on", openIndex: () => broken }),
    ).toThrow(/boom/);
    expect(store.db.open).toBe(false);
  });
});

describe("gitRoot", () => {
  it("is the nearest folder with .git (a folder or a worktree's file) above the cwd", () => {
    const dir = tempDir("lore-claude-");
    const repo = path.join(dir, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    expect(gitRoot(path.join(repo, "src", "deep"), path.join(dir, "home"))).toBe(repo);
    expect(gitRoot(repo, path.join(dir, "home"))).toBe(repo);
    const worktree = path.join(dir, "worktree");
    mkdirSync(worktree);
    writeFileSync(path.join(worktree, ".git"), "gitdir: /elsewhere");
    expect(gitRoot(worktree, path.join(dir, "home"))).toBe(worktree);
  });

  it("is undefined outside a repository, for the home folder, or when home is the repository", () => {
    const dir = tempDir("lore-claude-");
    const home = path.join(dir, "home");
    mkdirSync(path.join(home, "notes"), { recursive: true });
    expect(gitRoot(path.join(home, "notes"), home)).toBeUndefined();
    expect(gitRoot(home, home)).toBeUndefined();
    // A dotfiles repository in the home folder is not a project.
    mkdirSync(path.join(home, ".git"));
    expect(gitRoot(path.join(home, "notes"), home)).toBeUndefined();
  });
});

describe("sessionProject", () => {
  it("is the git root, else the folder itself, but never the home folder or a root", () => {
    const dir = tempDir("lore-claude-");
    const home = path.join(dir, "home");
    const repo = path.join(home, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(path.join(repo, "src"));
    mkdirSync(path.join(home, "diagrams", "sub"), { recursive: true });
    expect(sessionProject(path.join(repo, "src"), home)).toBe(repo);
    expect(sessionProject(path.join(home, "diagrams"), home)).toBe(path.join(home, "diagrams"));
    expect(sessionProject(path.join(home, "diagrams", "sub"), home)).toBe(
      path.join(home, "diagrams", "sub"),
    );
    expect(sessionProject(home, home)).toBeUndefined();
    expect(sessionProject(path.parse(dir).root, home)).toBeUndefined();
  });

  it("is a linked worktree's main repository", () => {
    const dir = tempDir("lore-claude-");
    const home = path.join(dir, "home");
    const repo = path.join(home, "repo");
    const worktree = path.join(repo, ".worktrees", "feature");
    mkdirSync(path.join(repo, ".git", "worktrees", "feature"), { recursive: true });
    mkdirSync(path.join(worktree, "src"), { recursive: true });
    writeFileSync(
      path.join(worktree, ".git"),
      `gitdir: ${path.join(repo, ".git", "worktrees", "feature")}\n`,
    );
    expect(sessionProject(path.join(worktree, "src"), home)).toBe(repo);
    // A submodule's .git file points elsewhere: it stays its own project.
    const sub = path.join(repo, "vendor", "lib");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, ".git"), "gitdir: ../../.git/modules/lib\n");
    expect(sessionProject(sub, home)).toBe(sub);
  });
});

describe("hookCommand", () => {
  it("runs the CLI with absolute paths, quoting those with spaces or shell characters", () => {
    expect(hookCommand("/usr/local/bin/node", "/opt/lore/dist/cli/index.js")).toBe(
      "/usr/local/bin/node /opt/lore/dist/cli/index.js hook claude-prompt",
    );
    expect(hookCommand("/Apps/My Node/node", '/x/a"$b`\\/index.js', "posix")).toBe(
      '"/Apps/My Node/node" "/x/a\\"\\$b\\`\\\\/index.js" hook claude-prompt',
    );
  });

  it("writes Windows paths with forward slashes, always double-quoted", () => {
    const node = path.win32.join("C:\\", "Program Files", "nodejs", "node.exe");
    const script = path.win32.join("C:\\", "lore", "dist", "cli", "index.js");
    const command = hookCommand(node, script, "win32");
    expect(command).toBe(
      '"C:/Program Files/nodejs/node.exe" "C:/lore/dist/cli/index.js" hook claude-prompt',
    );
    expect(hookCommandPaths(command)).toEqual([
      "C:/Program Files/nodejs/node.exe",
      "C:/lore/dist/cli/index.js",
    ]);
    // Git Bash expands $ and backticks inside double quotes.
    const odd = hookCommand("C:\\n$x\\node.exe", 'C:\\a`b"c\\index.js', "win32");
    expect(odd).toBe('"C:/n\\$x/node.exe" "C:/a\\`b\\"c/index.js" hook claude-prompt');
    expect(hookCommandPaths(odd)).toEqual(["C:/n$x/node.exe", 'C:/a`b"c/index.js']);
  });

  it("gives back the paths of a POSIX command, unescaped", () => {
    expect(hookCommandPaths('"/My Node/node" "/x/a\\"b/cli/index.js" hook claude-prompt')).toEqual([
      "/My Node/node",
      '/x/a"b/cli/index.js',
    ]);
    expect(hookCommandPaths(COMMAND)).toEqual(["/usr/bin/node", "/opt/lore/dist/cli/index.js"]);
  });
});

describe("claudeSettingsPath", () => {
  it("uses CLAUDE_CONFIG_DIR, else ~/.claude", () => {
    expect(claudeSettingsPath({}, "/home/me")).toBe(
      path.join("/home/me", ".claude", "settings.json"),
    );
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/me")).toBe(
      path.resolve("/cfg", "settings.json"),
    );
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: "~/cfg" }, "/home/me")).toBe(
      path.resolve("/home/me/cfg", "settings.json"),
    );
  });
});

const COMMAND = "/usr/bin/node /opt/lore/dist/cli/index.js hook claude-prompt";
const NOW = new Date("2026-10-17T10:20:30.456Z");

/** The hook group agentlore adds for one event. */
const ours = (name: string) => ({
  hooks: [
    {
      type: "command",
      command: COMMAND.replace(/claude-prompt$/, name),
      timeout: CLAUDE_HOOK_TIMEOUT,
    },
  ],
});

const existing = {
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo other", timeout: 3 }] }],
    Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
  },
};

describe("installClaudeHook", () => {
  it("adds the hook, keeps every other setting, and backs the file up first", () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "settings.json");
    const original = `${JSON.stringify(existing, null, 2)}\n`;
    writeFileSync(file, original);
    const result = installClaudeHook(file, COMMAND, { now: NOW });
    expect(result.changed).toBe(true);
    expect(result.backup).toBe(`${file}.agentlore-backup-2026-10-17T10-20-30-456Z`);
    expect(readFileSync(result.backup as string, "utf8")).toBe(original);
    const settings = JSON.parse(readFileSync(file, "utf8"));
    expect(settings).toEqual({
      ...existing,
      hooks: {
        ...existing.hooks,
        UserPromptSubmit: [...existing.hooks.UserPromptSubmit, ours("claude-prompt")],
        SessionStart: [ours("claude-session-start")],
        Stop: [...existing.hooks.Stop, ours("claude-stop")],
        SessionEnd: [ours("claude-session-end")],
      },
    });
    // COMMAND's paths do not exist here.
    expect(claudeHookStatus(file)).toEqual({
      installed: true,
      command: COMMAND,
      missing: ["/usr/bin/node", "/opt/lore/dist/cli/index.js"],
    });
  });

  it("reports no missing paths when the installed command's node and script exist", () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "settings.json");
    const script = path.join(dir, "dist", "cli", "index.js");
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, "");
    const command = hookCommand(process.execPath, script);
    installClaudeHook(file, command, { now: NOW });
    expect(claudeHookStatus(file)).toEqual({ installed: true, command });
  });

  it("is idempotent, and replaces an older agentlore hook instead of adding a second", () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify(existing));
    installClaudeHook(file, "/old/node /old/dist/cli/index.js hook claude-prompt", { now: NOW });
    expect(installClaudeHook(file, COMMAND, { now: NOW }).changed).toBe(true);
    const again = installClaudeHook(file, COMMAND, { now: NOW });
    expect(again).toEqual({ changed: false });
    const groups = JSON.parse(readFileSync(file, "utf8")).hooks.UserPromptSubmit;
    expect(groups).toHaveLength(2);
    expect(JSON.stringify(groups)).not.toMatch(/old/);
  });

  it("adds the newer hooks to an install by an older agentlore, which status reports", () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [ours("claude-prompt")] } }));
    expect(claudeHookStatus(file)).toMatchObject({
      installed: true,
      missingEvents: ["SessionStart", "Stop", "SessionEnd"],
    });
    expect(installClaudeHook(file, COMMAND, { now: NOW }).changed).toBe(true);
    expect(claudeHookStatus(file).missingEvents).toBeUndefined();
    uninstallClaudeHook(file, { now: NOW });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  it("creates the settings file (and its folder) when there is none, without a backup", () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "new", "settings.json");
    const result = installClaudeHook(file, COMMAND, { now: NOW });
    expect(result).toEqual({ changed: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      hooks: {
        UserPromptSubmit: [ours("claude-prompt")],
        SessionStart: [ours("claude-session-start")],
        Stop: [ours("claude-stop")],
        SessionEnd: [ours("claude-session-end")],
      },
    });
  });

  it("refuses to touch a settings file that is not valid JSON or has an unexpected shape", () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "settings.json");
    for (const content of [
      "{ broken",
      "[]",
      '{"hooks": []}',
      '{"hooks": {"UserPromptSubmit": {}}}',
    ]) {
      writeFileSync(file, content);
      expect(() => installClaudeHook(file, COMMAND, { now: NOW })).toThrow(/settings\.json/);
      expect(readFileSync(file, "utf8")).toBe(content);
    }
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    // Status reports the problem rather than "not installed".
    expect(() => claudeHookStatus(file)).toThrow(/settings\.json: "hooks\.UserPromptSubmit"/);
    writeFileSync(file, "{ broken");
    expect(() => claudeHookStatus(file)).toThrow(/not valid JSON/);
  });

  it("keeps the file's permissions and writes through a symlink", () => {
    if (process.platform === "win32") return;
    const dir = tempDir("lore-claude-");
    const real = path.join(dir, "dotfiles", "settings.json");
    mkdirSync(path.dirname(real));
    writeFileSync(real, "{}");
    // Group- and world-writable: a mode the umask would otherwise reduce.
    chmodSync(real, 0o666);
    const link = path.join(dir, "settings.json");
    symlinkSync(real, link);
    installClaudeHook(link, COMMAND, { now: NOW });
    expect(statSync(link, { throwIfNoEntry: true }).isFile()).toBe(true);
    expect(readFileSync(real, "utf8")).toMatch(/hook claude-prompt/);
    expect(statSync(real).mode & 0o777).toBe(0o666);
  });

  it("only takes commands ending with agentlore's cli/index.js and hook claude-prompt as its own", () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "settings.json");
    const others = [
      { type: "command", command: "/usr/bin/other-tool hook claude-prompt" },
      { type: "command", command: "/opt/lore/dist/cli/index.js hook claude-prompt --verbose" },
    ];
    writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: others }] } }));
    expect(claudeHookStatus(file).installed).toBe(false);
    installClaudeHook(file, COMMAND, { now: NOW });
    uninstallClaudeHook(file, { now: NOW });
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.UserPromptSubmit).toEqual([
      { hooks: others },
    ]);
  });

  it(`keeps only the newest ${KEPT_BACKUPS} backups`, () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "settings.json");
    writeFileSync(file, "{}");
    for (let i = 0; i < 5; i++) {
      const now = new Date(Date.UTC(2026, 9, 17, 10, i));
      if (i % 2) uninstallClaudeHook(file, { now });
      else installClaudeHook(file, COMMAND, { now });
    }
    const backups = readdirSync(dir).filter((name) => name.includes("agentlore-backup"));
    expect(backups.sort()).toEqual([
      "settings.json.agentlore-backup-2026-10-17T10-02-00-000Z",
      "settings.json.agentlore-backup-2026-10-17T10-03-00-000Z",
      "settings.json.agentlore-backup-2026-10-17T10-04-00-000Z",
    ]);
  });

  it("writes nothing when the file changes while it is being edited", () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "settings.json");
    writeFileSync(file, "{}");
    const race = () => writeFileSync(file, '{"model":"opus"}');
    expect(() => installClaudeHook(file, COMMAND, { now: NOW, beforeRename: race })).toThrow(
      /changed while agentlore was editing it; nothing was changed/,
    );
    expect(readFileSync(file, "utf8")).toBe('{"model":"opus"}');
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the older backups when an edit is refused", () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "settings.json");
    writeFileSync(file, "{}");
    for (let i = 0; i < KEPT_BACKUPS; i++) {
      const now = new Date(Date.UTC(2026, 9, 17, 10, i));
      if (i % 2) uninstallClaudeHook(file, { now });
      else installClaudeHook(file, COMMAND, { now });
    }
    const before = readdirSync(dir).sort();
    // Another program saves the file, keeping the hook, so each retry is refused too.
    const race = () => writeFileSync(file, `${readFileSync(file, "utf8")} `);
    for (let i = 0; i < 2; i++) {
      const now = new Date(Date.UTC(2026, 9, 17, 11, i));
      expect(() => uninstallClaudeHook(file, { now, beforeRename: race })).toThrow(
        /changed while agentlore was editing it/,
      );
    }
    expect(readdirSync(dir).sort()).toEqual(before);
  });
});

describe("uninstallClaudeHook", () => {
  it("removes only the agentlore hook, with a backup", () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify(existing));
    installClaudeHook(file, COMMAND, { now: NOW });
    const result = uninstallClaudeHook(file, { now: new Date("2026-10-17T11:00:00Z") });
    expect(result.changed).toBe(true);
    expect(result.backup).toMatch(/agentlore-backup-2026-10-17T11-00-00-000Z$/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(existing);
    expect(claudeHookStatus(file)).toEqual({ installed: false });
  });

  it("gives back the original file, key order and formatting included", () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "settings.json");
    const original = `${JSON.stringify({ ...existing, theme: "dark" }, null, 2)}\n`;
    writeFileSync(file, original);
    installClaudeHook(file, COMMAND, { now: NOW });
    uninstallClaudeHook(file, { now: NOW });
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("drops the event when the agentlore hook was its only one, and leaves other files alone", () => {
    const dir = tempDir("lore-claude-");
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ model: "opus" }));
    installClaudeHook(file, COMMAND, { now: NOW });
    uninstallClaudeHook(file, { now: NOW });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ model: "opus" });
    expect(uninstallClaudeHook(file, { now: NOW })).toEqual({ changed: false });
    expect(uninstallClaudeHook(path.join(dir, "missing.json"), { now: NOW })).toEqual({
      changed: false,
    });
  });
});
