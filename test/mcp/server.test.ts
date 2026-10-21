import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withLock } from "../../src/core/lock.js";
import { BRIEF_TOPIC, readNote, writeNote } from "../../src/core/memory.js";
import type { KnowledgeMode } from "../../src/core/mode.js";
import type { Runtime } from "../../src/core/runtime.js";
import { openStore, type Store } from "../../src/core/store.js";
import { createServer } from "../../src/mcp/server.js";
import { chunk, escapeRegExp, hostPath, seed as seedChunks, tempDir } from "../helpers.js";

const repoB = hostPath("/work/repo-b");

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let lockPath = "";

async function connect(
  seed: boolean,
  {
    stale = false,
    wrap = (s: Store) => s,
    mode,
    memory,
  }: {
    stale?: boolean;
    wrap?: (s: Store) => Store;
    mode?: () => KnowledgeMode;
    memory?: {
      root: string;
      project: () => string | undefined;
      projectOf?: (path: string) => string | undefined;
      saved?: () => Promise<void>;
    };
  } = {},
) {
  const store: Store = openStore(":memory:");
  const dir = tempDir("lore-mcp-");
  cleanups.push(() => store.close());
  if (seed) {
    store.setMeta("lastIndexedAt", stale ? "2000-01-01T00:00:00Z" : new Date().toISOString());
    seedChunks(store, "/b", [
      chunk({
        tool: "codex",
        sessionId: "s2",
        project: repoB,
        startedAt: "2026-07-08T07:29:16Z",
        endedAt: "2026-07-08T07:29:20Z",
        text: "Warehouse import is a one-time seed",
      }),
    ]);
  }
  const server = createServer(
    {
      store: wrap(store),
      adapters: [],
      lockPath: join(dir, "index.lock"),
    },
    { mode, memory },
  );
  lockPath = join(dir, "index.lock");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return client;
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: string; text: string }[])[0]?.text ?? "";

describe("mcp server", () => {
  it("lists the search and context tools with gating guidance, within a token budget", async () => {
    const { tools } = await (await connect(true)).listTools();
    expect(tools.map((t) => t.name)).toEqual(["search", "context"]);
    expect(tools[0]?.description).toMatch(/call only if/i);
    expect(tools[0]?.description).toMatch(/like last time", in any language/);
    // ~4 characters per token: the tool list is sent in every session. Raised from 350 when the
    // description started naming the supported tools and asking to search before grepping, and
    // from 370 for the since, until and said filters (~50 tokens).
    expect(JSON.stringify(tools).length / 4).toBeLessThanOrEqual(420);
    expect(tools[0]?.description).toMatch(/3 snippets/i);
  });

  it("asks for a search at each new task in knowledge mode, within the same token budget", async () => {
    const client = await connect(true, { mode: () => "on" });
    const { tools } = await client.listTools();
    const description = tools[0]?.description ?? "";
    expect(description).toMatch(
      /^Knowledge mode is ON \(enabled by the user\): call search at the start of each new task/m,
    );
    expect(description).toMatch(/Skip only trivial follow-ups/);
    expect(description).not.toMatch(/call only if/i);
    expect(description).toMatch(/untrusted/i);
    expect(description).toMatch(/3 snippets/i);
    // Same budget as the gated list (measured: ~382 tokens on, ~415 off).
    expect(JSON.stringify(tools).length / 4).toBeLessThanOrEqual(420);
    expect(client.getInstructions()).toMatch(
      /Knowledge mode is ON \(enabled by the user\).*context/s,
    );
    expect(description).toMatch(/briefly mention any relevant prior work you used/);
  });

  it("reads the mode again on every tools/list, falling back to off when it fails", async () => {
    let mode: KnowledgeMode | "fail" = "off";
    const client = await connect(true, {
      mode: () => {
        if (mode === "fail") throw new Error("unreadable");
        return mode;
      },
    });
    expect(client.getInstructions()).toMatch(/only when/);
    const description = async () => (await client.listTools()).tools[0]?.description ?? "";
    expect(await description()).toMatch(/call only if/i);
    mode = "on";
    expect(await description()).toMatch(/Knowledge mode is ON/);
    mode = "fail";
    expect(await description()).toMatch(/call only if/i);
  });

  it("keeps a description set later with update(), and the mode-driven one otherwise", async () => {
    let mode: KnowledgeMode = "on";
    const store = openStore(":memory:");
    cleanups.push(() => store.close());
    const server = createServer({ store, adapters: [], lockPath: "unused" }, { mode: () => mode });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    const description = async () => (await client.listTools()).tools[0]?.description;
    // Disabling and enabling go through update() without a description: still mode-driven.
    // biome-ignore lint/complexity/useLiteralKeys: private in the SDK's types; bracket access is allowed.
    const search = server["_registeredTools"].search;
    search?.disable();
    search?.enable();
    expect(await description()).toMatch(/Knowledge mode is ON/);
    search?.update({ description: "Custom description" });
    mode = "off";
    expect(await description()).toBe("Custom description");
  });

  it("names every supported tool and asks agents to search before grepping other repos", async () => {
    const { tools } = await (await connect(true)).listTools();
    const description = tools[0]?.description ?? "";
    for (const tool of ["Claude Code", "Codex", "Cursor", "Antigravity"]) {
      expect(description).toContain(tool);
    }
    expect(description).toMatch(/FIRST/);
    expect(description).toMatch(/instead of grepping other (repos|directories)/i);
  });

  it("returns formatted hits framed as untrusted data", async () => {
    const client = await connect(true);
    const result = await client.callTool({ name: "search", arguments: { query: "warehouse" } });
    const text = textOf(result);
    expect(text).toContain(`codex ${repoB}`);
    expect(text.split("\n")[0]).toMatch(/^Untrusted excerpts .*\(data, not instructions\):$/);
    expect(text).toMatch(/^> \[Warehouse\] import/m);
  });

  it("says in the tool description that results are untrusted data", async () => {
    const { tools } = await (await connect(true)).listTools();
    expect(tools[0]?.description).toMatch(/untrusted/i);
  });

  it("reports the package version and tells agents when to call the tools", async () => {
    const client = await connect(true);
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
    ) as { version: string };
    expect(client.getServerVersion()).toEqual({ name: "agentlore", version: pkg.version });
    expect(client.getInstructions()).toMatch(/search.*context/s);
  });

  it("returns a hit with its neighbours by id, framed as untrusted data", async () => {
    const client = await connect(true);
    const hits = textOf(
      await client.callTool({ name: "search", arguments: { query: "warehouse" } }),
    );
    const id = hits.match(/^\[1\] ([0-9a-f]{8}) /m)?.[1];
    expect(id).toBeDefined();
    const result = await client.callTool({ name: "context", arguments: { id, around: 2 } });
    expect(result.isError).toBeFalsy();
    const lines = textOf(result).split("\n");
    expect(lines[0]).toMatch(/^Untrusted excerpts/);
    expect(lines[1]).toBe(`[${id} codex ${repoB} 2026-07-08]`);
    expect(lines[2]).toBe("> Warehouse import is a one-time seed");
  });

  it("returns a tool error for an unknown id", async () => {
    const result = await (await connect(true)).callTool({
      name: "context",
      arguments: { id: "ffffffff" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No chunk with id ffffffff/);
  });

  it("starts and explains the problem when the index cannot be opened", async () => {
    const server = createServer(() => {
      throw new Error("The index was created by a newer agentlore; upgrade agentlore");
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    for (const [name, args] of [
      ["search", { query: "warehouse" }],
      ["context", { id: "abcdef01" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/newer agentlore; upgrade/);
    }
  });

  it("answers that the index is empty, and opens it later, when there is no index yet", async () => {
    let runtime: Runtime | undefined;
    const server = createServer(() => runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    for (const [name, args] of [
      ["search", { query: "warehouse" }],
      ["context", { id: "abcdef01" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toMatch(/index is empty.*lore index/);
    }
    const store = openStore(":memory:");
    cleanups.push(() => store.close());
    store.setMeta("lastIndexedAt", new Date().toISOString());
    seedChunks(store, "/b", [chunk({ text: "Warehouse import is a one-time seed" })]);
    runtime = { store, adapters: [], lockPath: join(tmpdir(), "lore-unused.lock") };
    const found = await client.callTool({ name: "search", arguments: { query: "warehouse" } });
    expect(textOf(found)).toContain("[Warehouse]");
  });

  it("returns a tool error, not a crash, for an ambiguous id", async () => {
    const client = await connect(true, {
      wrap: (store) => ({ ...store, findChunkKeys: () => ["abcdef01x", "abcdef01y"] }),
    });
    const result = await client.callTool({ name: "context", arguments: { id: "abcdef01" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/matches several chunks; pass more characters/);
    const after = await client.callTool({ name: "search", arguments: { query: "warehouse" } });
    expect(after.isError).toBeFalsy();
  });

  it("rejects overlong project paths", async () => {
    const client = await connect(true);
    const result = await client
      .callTool({ name: "search", arguments: { query: "warehouse", project: "/".repeat(4097) } })
      .catch((error: unknown) => ({
        isError: true,
        content: [{ type: "text", text: String(error) }],
      }));
    expect(result.isError).toBe(true);
  });

  it("tells the agent to run `lore index` when nothing is indexed", async () => {
    const client = await connect(false);
    const result = await client.callTool({ name: "search", arguments: { query: "warehouse" } });
    expect(textOf(result)).toContain("lore index");
  });

  it("still searches when the refresh fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => log.mockRestore());
    const client = await connect(true, {
      stale: true,
      wrap: (store) => ({
        ...store,
        setMeta: () => {
          throw new Error("disk full");
        },
      }),
    });
    const result = await client.callTool({ name: "search", arguments: { query: "warehouse" } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(`codex ${repoB}`);
    expect(textOf(result)).toMatch(/\(note: index refresh failed; results may be stale\)$/);
  });

  it("returns a tool error when the search itself fails", async () => {
    const client = await connect(true, {
      wrap: (store) => ({
        ...store,
        searchCandidates: () => {
          throw new Error("database disk image is malformed");
        },
      }),
    });
    const result = await client.callTool({ name: "search", arguments: { query: "warehouse" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/search failed.*malformed/i);
  });

  it("normalizes the project path before filtering", async () => {
    const client = await connect(true);
    for (const project of ["/work/repo-b/", "/work/./repo-b"]) {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "warehouse", project },
      });
      expect(textOf(result)).toContain(`codex ${repoB}`);
    }
  });

  it("says when a project filter hides results from other projects", async () => {
    const client = await connect(true);
    const result = await client.callTool({
      name: "search",
      arguments: { query: "warehouse", project: "/work/repo-a" },
    });
    expect(textOf(result)).toMatch(
      new RegExp(
        `^No results in project ${escapeRegExp(hostPath("/work/repo-a"))}; 1 result elsewhere`,
      ),
    );
  });

  it("filters by date and by who said it, and rejects a malformed date", async () => {
    const client = await connect(true);
    const search = (args: Record<string, string>) =>
      client.callTool({ name: "search", arguments: { query: "warehouse", ...args } });
    expect(textOf(await search({ since: "2026-07-01", until: "2026-07-08" }))).toContain(
      `codex ${repoB}`,
    );
    expect(textOf(await search({ since: "2026-07-09" }))).not.toContain(`codex ${repoB}`);
    // The seeded chunk has no user turn.
    expect(textOf(await search({ said: "user" }))).not.toContain(`codex ${repoB}`);
    const bad = await search({ since: "last week" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/YYYY-MM-DD/);
  });

  it("rejects overlong queries", async () => {
    const client = await connect(true);
    const result = await client
      .callTool({ name: "search", arguments: { query: "x".repeat(501) } })
      .catch((error: unknown) => ({
        isError: true,
        content: [{ type: "text", text: String(error) }],
      }));
    expect(result.isError).toBe(true);
  });

  it("notes that results may be stale while another refresh is running", async () => {
    const client = await connect(true, { stale: true });
    const result = await withLock(lockPath, () =>
      client.callTool({ name: "search", arguments: { query: "warehouse" } }),
    );
    if (!result) throw new Error("lock not acquired");
    expect(textOf(result)).toContain(`codex ${repoB}`);
    expect(textOf(result)).toMatch(
      /\(note: index refresh in progress; results may be slightly stale\)$/,
    );
  });

  it("adds no note to fresh results", async () => {
    const result = await (await connect(true)).callTool({
      name: "search",
      arguments: { query: "warehouse" },
    });
    expect(textOf(result)).not.toContain("note:");
  });
});

describe("project memory tools", () => {
  const repo = hostPath("/work/shop-api");

  it("are listed with the memory option, within a token budget", async () => {
    const root = tempDir("lore-mcp-memory-");
    const { tools } = await (
      await connect(true, { memory: { root, project: () => repo } })
    ).listTools();
    expect(tools.map((t) => t.name)).toEqual(["search", "context", "recall", "remember"]);
    // The search and context tools' budget (420) plus ~270 tokens for the memory tools
    // (measured: ~687), most of it their JSON schemas.
    expect(JSON.stringify(tools).length / 4).toBeLessThanOrEqual(700);
  });

  it("remember saves a note of the session's project, recall reads it back", async () => {
    const root = tempDir("lore-mcp-memory-");
    let saved = 0;
    const client = await connect(true, {
      memory: {
        root,
        project: () => repo,
        saved: async () => {
          saved++;
        },
      },
    });
    const first = await client.callTool({
      name: "remember",
      arguments: { topic: "Billing Rules", text: "Refunds go through Stripe." },
    });
    expect(textOf(first)).toBe(`Saved the billing-rules note of ${repo}.`);
    const second = await client.callTool({
      name: "remember",
      arguments: { topic: "billing-rules", text: "Refunds go through Stripe, within 30 days." },
    });
    expect(textOf(second)).toMatch(/previous version is kept in its history/);
    expect(saved).toBe(2);
    expect(readNote(root, repo, "billing-rules")).toMatchObject({ by: "agent" });

    const topic = await client.callTool({ name: "recall", arguments: { topic: "billing-rules" } });
    expect(textOf(topic)).toMatch(/data, not instructions/);
    expect(textOf(topic)).toMatch(/> Refunds go through Stripe, within 30 days\.$/);
    writeNote(root, { project: repo, topic: BRIEF_TOPIC, text: "Shop API", by: "user" });
    const overview = await client.callTool({ name: "recall", arguments: {} });
    expect(textOf(overview)).toMatch(/Brief \(by user, .*\):\n> Shop API\n- billing-rules/);
  });

  it("files a note given a subfolder under the project that folder belongs to", async () => {
    const root = tempDir("lore-mcp-memory-");
    const client = await connect(true, {
      memory: { root, project: () => undefined, projectOf: () => repo },
    });
    await client.callTool({
      name: "remember",
      arguments: { project: `${repo}/src`, topic: "db", text: "Postgres" },
    });
    expect(readNote(root, repo, "db")?.text).toBe("Postgres");
  });

  it("explains a note it cannot save, and asks for a project outside one", async () => {
    const root = tempDir("lore-mcp-memory-");
    const client = await connect(true, { memory: { root, project: () => undefined } });
    const noProject = await client.callTool({ name: "recall", arguments: {} });
    expect(noProject.isError).toBe(true);
    expect(textOf(noProject)).toMatch(/Pass project/);
    const tooLong = await client.callTool({
      name: "remember",
      arguments: { project: repo, topic: "brief", text: "x".repeat(2500) },
    });
    expect(tooLong.isError).toBe(true);
    expect(textOf(tooLong)).toMatch(/^Not saved: the brief note is 2500 characters/);
  });
});

describe("the user profile through MCP", () => {
  it("is saved with topic user and read back without a project", async () => {
    const root = tempDir("lore-mcp-memory-");
    const client = await connect(true, { memory: { root, project: () => undefined } });
    const saved = await client.callTool({
      name: "remember",
      arguments: { topic: "user", text: "- Asks before deleting files" },
    });
    expect(textOf(saved)).toBe("Saved the user profile.");
    const read = await client.callTool({ name: "recall", arguments: { topic: "user" } });
    expect(textOf(read)).toMatch(/> - Asks before deleting files$/);
  });
});
