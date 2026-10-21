import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeArgs, claudeResult, claudeRunner } from "../../src/integrations/claude-cli.js";
import { tempDir } from "../helpers.js";

describe("claude -p", () => {
  it("runs without tools, MCP servers or a saved session", () => {
    expect(claudeArgs("sonnet")).toEqual([
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--tools",
      "",
      "--strict-mcp-config",
      "--model",
      "sonnet",
    ]);
    expect(claudeArgs()).not.toContain("--model");
  });

  it("reads the answer from the JSON result, and fails on an error result", () => {
    expect(claudeResult('{"type":"result","is_error":false,"result":"hi"}')).toBe("hi");
    expect(() => claudeResult('{"is_error":true,"result":"quota"}')).toThrow(
      /claude failed: quota/,
    );
    expect(() => claudeResult("oops")).toThrow(/no JSON result/);
  });

  it.skipIf(process.platform === "win32")(
    "passes the prompt on stdin with agentlore's hooks off",
    async () => {
      const dir = tempDir("lore-claude-cli-");
      const fake = path.join(dir, "claude");
      writeFileSync(
        fake,
        `#!/bin/sh\nprompt=$(cat)\nprintf '{"is_error":false,"result":"%s %s"}' "$AGENTLORE_NO_HOOKS" "$prompt"\n`,
      );
      chmodSync(fake, 0o755);
      expect(await claudeRunner({ command: fake, cwd: dir })("hello")).toBe("1 hello");
      const failing = path.join(dir, "failing");
      writeFileSync(failing, "#!/bin/sh\necho 'not logged in' >&2\nexit 3\n");
      chmodSync(failing, 0o755);
      await expect(claudeRunner({ command: failing, cwd: dir })("x")).rejects.toThrow(
        /exited with 3: not logged in/,
      );
      await expect(
        claudeRunner({ command: path.join(dir, "missing"), cwd: dir })("x"),
      ).rejects.toThrow(/not found/);
      // Exits without reading a prompt larger than the pipe: rejected, not a crash.
      const early = path.join(dir, "early");
      writeFileSync(early, "#!/bin/sh\necho 'bad flag' >&2\nexit 2\n");
      chmodSync(early, 0o755);
      await expect(
        claudeRunner({ command: early, cwd: dir })("x".repeat(4_000_000)),
      ).rejects.toThrow(/exited with 2: bad flag/);
    },
  );
});
