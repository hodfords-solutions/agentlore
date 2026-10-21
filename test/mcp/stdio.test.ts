import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { afterAll, describe, expect, inject, it } from "vitest";
import { fixtureSandbox, hostPath, removeDir, waitForExit } from "../helpers.js";

const cli = inject("cliPath");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: string; text: string }[])[0]?.text ?? "";

/** `lore mcp` as a child process, the way MCP clients run it. */
async function startServer(env: NodeJS.ProcessEnv, cwd?: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    cwd,
    env: { ...getDefaultEnvironment(), ...(env as Record<string, string>) },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  // Any stdout line that is not a JSON-RPC message surfaces here.
  const protocolErrors: Error[] = [];
  client.onerror = (error) => protocolErrors.push(error);
  await client.connect(transport);
  const pid = transport.pid;
  /** Close the connection and wait until the server process has exited. */
  const stop = async () => {
    await client.close();
    await waitForExit(pid);
  };
  return { client, protocolErrors, stderr: () => stderr, stop };
}

describe("lore mcp over stdio", () => {
  it("describes search for the knowledge mode of the folder it was started in", async () => {
    const env = fixtureSandbox(dirs);
    const project = realpathSync(join(env.AGENTLORE_HOME as string, ".."));
    mkdirSync(env.AGENTLORE_HOME as string, { recursive: true });
    writeFileSync(
      join(env.AGENTLORE_HOME as string, "mode.json"),
      JSON.stringify({ global: "off", paths: { [project]: "on" } }),
    );
    const inside = await startServer(env, project);
    const outside = await startServer(env, tmpdir());
    try {
      const description = async (server: typeof inside) =>
        (await server.client.listTools()).tools[0]?.description ?? "";
      expect(await description(inside)).toMatch(/Knowledge mode is ON/);
      expect(inside.client.getInstructions()).toMatch(/Knowledge mode is ON/);
      expect(await description(outside)).toMatch(/call only if/i);
    } finally {
      await inside.stop();
      await outside.stop();
    }
  });

  it("serves search and context with clean JSON-RPC on stdout, refresh included", async () => {
    const env = fixtureSandbox(dirs);
    expect(spawnSync(process.execPath, [cli, "index"], { env }).status).toBe(0);

    // Make the index stale and add a session, so the first search refreshes the index inside
    // the server process: nothing it logs may reach stdout.
    const db = new Database(join(env.AGENTLORE_HOME as string, "index.db"));
    db.prepare("UPDATE meta SET value = '2000-01-01T00:00:00Z' WHERE key = 'lastIndexedAt'").run();
    db.close();
    const session = join(env.AGENTLORE_CLAUDE_DIR as string, "-work-repo-c");
    mkdirSync(session);
    writeFileSync(
      join(session, "new.jsonl"),
      `${JSON.stringify({ type: "user", sessionId: "new", cwd: "/work/repo-c", timestamp: "2026-07-01T00:00:00Z", message: { role: "user", content: "zebrafish migration plan" } })}\n`,
    );

    const { client, protocolErrors, stderr, stop } = await startServer(env);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
        "search",
        "context",
        "recall",
        "remember",
      ]);

      const fresh = textOf(
        await client.callTool({ name: "search", arguments: { query: "zebrafish" } }),
      );
      expect(fresh).toContain(`claude ${hostPath("/work/repo-c")}`);

      const hits = textOf(
        await client.callTool({ name: "search", arguments: { query: "warehouse seed" } }),
      );
      expect(hits.split("\n")[0]).toMatch(/^Untrusted excerpts/);
      expect(hits).toContain(`codex ${hostPath("/work/repo-b")}`);
      const id = hits.match(/^\[1\] ([0-9a-f]{8}) /m)?.[1];
      expect(id).toBeDefined();

      const context = await client.callTool({ name: "context", arguments: { id, around: 1 } });
      expect(context.isError).toBeFalsy();
      expect(textOf(context)).toContain("> user› How does the warehouse import work?");

      expect(protocolErrors).toEqual([]);
    } finally {
      await stop();
    }
    expect(stderr()).not.toMatch(/Error|at .*\.js/);
  });

  it("answers that the index is empty without creating the home folder", async () => {
    const env = fixtureSandbox(dirs);
    const { client, protocolErrors, stop } = await startServer(env);
    try {
      const result = await client.callTool({ name: "search", arguments: { query: "warehouse" } });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toMatch(/index is empty/);
      expect(existsSync(env.AGENTLORE_HOME as string)).toBe(false);
      expect(protocolErrors).toEqual([]);
    } finally {
      await stop();
    }
  });

  it("starts and returns a tool error when the index cannot be opened", async () => {
    const env = fixtureSandbox(dirs);
    const home = env.AGENTLORE_HOME as string;
    mkdirSync(home, { recursive: true });
    const db = new Database(join(home, "index.db"));
    db.pragma("user_version = 999");
    db.close();
    const { client, protocolErrors, stop } = await startServer(env);
    try {
      const result = await client.callTool({ name: "search", arguments: { query: "warehouse" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/newer agentlore/);
      expect(protocolErrors).toEqual([]);
    } finally {
      await stop();
    }
  });
});
