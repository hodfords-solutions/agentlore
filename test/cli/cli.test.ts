import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, inject, it } from "vitest";
import { fixtureSandbox, hostPath, removeDir } from "../helpers.js";

const cli = inject("cliPath");
const repoA = hostPath("/work/repo-a");
const repoB = hostPath("/work/repo-b");
const dirs: string[] = [];
const canRevokeAccess = process.platform !== "win32" && process.getuid?.() !== 0;

const sandbox = () => fixtureSandbox(dirs);

function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterAll(() => {
  // Every child has exited by now: `run` is synchronous and `start` resolves on "close".
  for (const dir of dirs.splice(0)) removeDir(dir);
});

describe("lore cli", () => {
  it("indexes, reports status and searches", () => {
    const env = sandbox();
    const indexed = run(env, "index");
    expect(indexed.code).toBe(0);
    expect(indexed.stdout).toMatch(/Indexed 4 sources → \d+ chunks .*errors 0/);
    expect(indexed.stderr).not.toMatch(/could not be read/);

    expect(indexed.stdout).toMatch(/ chunks in \d+\.\d s /);

    const status = run(env, "status");
    expect(status.stdout).toMatch(/^claude\s+1 source\s+\d+ chunks?$/m);
    expect(status.stdout).toMatch(/^codex\s+1 source\s+\d+ chunks?$/m);
    expect(status.stdout).toMatch(/^cursor\s+1 source\s+\d+ chunks?$/m);
    expect(status.stdout).toMatch(/^antigravity\s+1 source\s+\d+ chunks?$/m);
    // Tool names of different lengths still line up.
    const counts = status.stdout.split("\n").filter((line) => / sources? /.test(line));
    expect(new Set(counts.map((line) => line.search(/\d/))).size).toBe(1);
    expect(status.stdout).toMatch(/^projects: 2$/m);
    expect(status.stdout).toMatch(/^index: .*index\.db \(\d+\.\d MB\)$/m);
    expect(status.stdout).toMatch(/^last indexed: \d{4}-\d\d-\d\d \d\d:\d\d$/m);

    expect(run(env, "search", "warehouse", "seed").stdout).toContain(`codex ${repoB}`);
    expect(run(env, "search", "backoff").stdout).toContain(`cursor ${repoA}`);
    expect(run(env, "search", "ledger").stdout).toMatch(
      /antigravity - \S+ note conv-ag1 — implementation_plan/,
    );
  });

  it("normalizes the --project path like the MCP server", () => {
    const env = sandbox();
    run(env, "index");
    for (const project of ["/work/repo-b/", "/work/./repo-b"]) {
      expect(run(env, "search", "-p", project, "warehouse").stdout).toContain(`codex ${repoB}`);
    }
  });

  it("matches sessions in subfolders of --project and says when other projects match", () => {
    const env = sandbox();
    run(env, "index");
    expect(run(env, "search", "-p", "/work", "warehouse").stdout).toContain("codex");
    expect(run(env, "search", "-p", "/work/repo-a", "warehouse").stdout).toContain(
      `No results in project ${hostPath("/work/repo-a")}; 1 result elsewhere`,
    );
  });

  it("shows a search result in full by its id", () => {
    const env = sandbox();
    run(env, "index");
    const id = run(env, "search", "idempotency").stdout.match(/^\[1\] ([0-9a-f]{8}) /m)?.[1];
    expect(id).toBeDefined();
    const shown = run(env, "show", id as string, "--around", "0");
    expect(shown.code).toBe(0);
    expect(shown.stdout.split("\n")[0]).toBe(
      `[${id} claude ${hostPath("/work/repo-a")} 2026-06-03]`,
    );
    expect(shown.stdout).toContain("user: Thanks, move the idempotency check first.");
    const missing = run(env, "show", "ffffffff");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/No chunk with id ffffffff/);
    expect(run(env, "show", id as string, "--around", "9").stderr).toMatch(/from 0 to 3/);
  });

  /** Mark the sandbox index as last refreshed long ago, so the next search refreshes it. */
  const makeStale = (env: NodeJS.ProcessEnv) => {
    const db = new Database(join(env.AGENTLORE_HOME as string, "index.db"));
    db.prepare("UPDATE meta SET value = '2000-01-01T00:00:00Z' WHERE key = 'lastIndexedAt'").run();
    db.close();
  };

  it("refreshes a stale index before searching", () => {
    const env = sandbox();
    run(env, "index");
    const session = join(env.AGENTLORE_CLAUDE_DIR as string, "-work-repo-c");
    mkdirSync(session);
    writeFileSync(
      join(session, "new.jsonl"),
      `${JSON.stringify({ type: "user", sessionId: "new", cwd: "/work/repo-c", timestamp: "2026-07-01T00:00:00Z", message: { role: "user", content: "zebrafish migration plan" } })}\n`,
    );
    expect(run(env, "search", "zebrafish").stdout).toMatch(/No matching knowledge found/);
    makeStale(env);
    const result = run(env, "search", "zebrafish");
    expect(result.stdout).toContain(`claude ${hostPath("/work/repo-c")}`);
    expect(result.stderr).toBe("");
  });

  it("notes on stderr that results may be stale while another indexer runs", () => {
    const env = sandbox();
    run(env, "index");
    makeStale(env);
    // This test process is alive, so the lock is not stale.
    const lock = join(env.AGENTLORE_HOME as string, "index.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "x" }));
    const result = run(env, "search", "warehouse");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`codex ${repoB}`);
    expect(result.stderr).toMatch(
      /\(note: index refresh in progress; results may be slightly stale\)/,
    );
  });

  it("reports an empty index before the first index without creating anything", () => {
    const env = sandbox();
    const home = env.AGENTLORE_HOME as string;
    const status = run(env, "status");
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/^claude\s+0 sources\s+0 chunks$/m);
    expect(status.stdout).toMatch(/^codex\s+0 sources\s+0 chunks$/m);
    expect(status.stdout).toMatch(/^cursor\s+0 sources\s+0 chunks$/m);
    expect(status.stdout).toMatch(/^antigravity\s+0 sources\s+0 chunks$/m);
    expect(status.stdout).toMatch(/last indexed: never/);
    expect(run(env, "search", "warehouse").stdout).toMatch(/Index is empty — run `lore index`/);
    const show = run(env, "show", "abcdef01");
    expect(show.code).toBe(1);
    expect(show.stderr).toMatch(/Index is empty — run `lore index`/);
    expect(existsSync(home)).toBe(false);
  });

  it("warns about a tool whose transcript folder does not exist", () => {
    const env = sandbox();
    const missing = join(env.AGENTLORE_HOME as string, "..", "no-codex");
    const result = run({ ...env, AGENTLORE_CODEX_DIR: missing }, "index");
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/^codex: .*no-codex not found — skipped$/m);
    expect(result.stdout).toMatch(/errors 0/);
  });

  it.each(["0", "yes"])("reads Cursor's database even when SQLITE_USE_URI=%s is set", (value) => {
    const env = { ...sandbox(), SQLITE_USE_URI: value };
    const result = run(env, "index");
    expect(result.stdout).toMatch(/errors 0/);
    expect(run(env, "status").stdout).toMatch(/^cursor\s+1 source\s+\d+ chunks?$/m);
  });

  it("warns when Cursor's database does not exist", () => {
    const env = sandbox();
    const missing = join(env.AGENTLORE_HOME as string, "..", "no-cursor");
    const result = run({ ...env, AGENTLORE_CURSOR_DIR: missing }, "index");
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(
      /^cursor: .*no-cursor.globalStorage.state\.vscdb not found — skipped$/m,
    );
    expect(result.stdout).toMatch(/errors 0/);
  });

  it("exits 0 but hints on stderr when some sources could not be read", () => {
    const env = sandbox();
    const notADir = join(env.AGENTLORE_HOME as string, "..", "codex-file");
    writeFileSync(notADir, "");
    const result = run({ ...env, AGENTLORE_CODEX_DIR: notADir }, "index");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Indexed 3 sources → .*errors 1/);
    expect(result.stderr).toMatch(/could not be read/);
    expect(result.stderr).toMatch(/^ {2}codex: .*not a directory/m);
  });

  it.skipIf(!canRevokeAccess)("lists at most five failed sources", () => {
    const env = sandbox();
    const folder = join(env.AGENTLORE_CLAUDE_DIR as string, "-work-repo-a");
    for (let i = 0; i < 7; i++) {
      const file = join(folder, `locked-${i}.jsonl`);
      writeFileSync(file, "{}\n");
      chmodSync(file, 0o000);
    }
    const result = run(env, "index");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/errors 7/);
    expect(result.stderr.match(/^ {2}\S*locked-\d\.jsonl: /gm)).toHaveLength(5);
    expect(result.stderr).toMatch(/^ {2}… and 2 more$/m);
  });

  it("drops and rebuilds the index with index --rebuild", () => {
    const env = sandbox();
    run(env, "index");
    const db = new Database(join(env.AGENTLORE_HOME as string, "index.db"));
    db.prepare(
      `INSERT INTO chunks (chunk_key, source_id, kind, tool, session_id, project, started_at, ended_at, text, text_hash)
       SELECT 'stale', id, 'transcript', tool, 's', '/p', '', '', 'quokkastale', 'h' FROM sources LIMIT 1`,
    ).run();
    db.close();
    expect(run(env, "index").stdout).toMatch(/Indexed 0 sources/);
    expect(run(env, "search", "quokkastale").stdout).toContain("/p");

    const rebuilt = run(env, "index", "--rebuild");
    expect(rebuilt.code).toBe(0);
    expect(rebuilt.stdout).toMatch(/Indexed 4 sources/);
    expect(run(env, "search", "quokkastale").stdout).toMatch(/No matching knowledge found/);
    expect(run(env, "search", "warehouse").stdout).toContain(`codex ${repoB}`);
  });

  it("refuses to index while another indexer holds the lock", () => {
    const env = sandbox();
    const home = env.AGENTLORE_HOME as string;
    mkdirSync(home, { recursive: true });
    // This test process is alive, so the lock is not stale.
    writeFileSync(join(home, "index.lock"), JSON.stringify({ pid: process.pid, token: "x" }));
    const result = run(env, "index");
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Another `lore index` is running/);
  });

  /** `lore <args>` as a background process; resolves when it exits. */
  const start = (env: NodeJS.ProcessEnv, ...args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, [cli, ...args], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      child.on("error", fail);
      child.on("close", (code) => done({ code, stdout, stderr }));
    });

  const chunkCount = (env: NodeJS.ProcessEnv) => {
    const db = new Database(join(env.AGENTLORE_HOME as string, "index.db"), { readonly: true });
    try {
      return (db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  it("indexes consistently when two lore index processes run at once", async () => {
    const single = sandbox();
    expect(run(single, "index").code).toBe(0);
    const expected = chunkCount(single);
    expect(expected).toBeGreaterThan(0);

    const env = sandbox();
    const results = await Promise.all([start(env, "index"), start(env, "index")]);
    for (const result of results) {
      // Either it indexed, or it found the other one holding the lock and said so.
      if (result.code === 0) expect(result.stdout).toMatch(/^Indexed \d+ sources/m);
      else {
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/Another `lore index` is running/);
      }
      expect(result.stderr).not.toMatch(/\n\s+at /);
    }
    expect(results.some((r) => r.code === 0)).toBe(true);
    expect(chunkCount(env)).toBe(expected);
    expect(run(env, "index").stdout).toMatch(/Indexed 0 sources/);
    expect(chunkCount(env)).toBe(expected);
  });

  it("prints a clear error, not a stack trace, for an index from a newer version", () => {
    const env = sandbox();
    const home = env.AGENTLORE_HOME as string;
    mkdirSync(home, { recursive: true });
    const db = new Database(join(home, "index.db"));
    db.pragma("user_version = 999");
    db.close();
    const result = run(env, "status");
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/created by a newer agentlore/);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it("rejects an invalid --limit", () => {
    const result = run(sandbox(), "search", "-n", "zero", "warehouse");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/limit/i);
    const huge = run(sandbox(), "search", "-n", "100000", "warehouse");
    expect(huge.code).not.toBe(0);
    expect(huge.stderr).toMatch(/limit.*from 1 to 100/i);
    expect(run(sandbox(), "search", "-n", "100", "warehouse").code).toBe(0);
  });

  it("filters search by date and by who said it", () => {
    const env = sandbox();
    run(env, "index");
    const found = (...args: string[]) =>
      run(env, "search", ...args, "warehouse", "import").stdout.includes(`codex ${repoB}`);
    expect(found("--since", "2026-07-08", "--until", "2026-07-08")).toBe(true);
    expect(found("--until", "2026-07-07")).toBe(false);
    // The user asked "How does the warehouse import work?".
    expect(found("--said", "user")).toBe(true);
    const bad = run(env, "search", "--since", "July", "warehouse");
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/since.*YYYY-MM-DD/);
  });

  it("reports indexed sessions per month and tool", () => {
    const env = sandbox();
    expect(run(env, "coverage").stdout).toMatch(/run `lore index`/);
    run(env, "index");
    const lines = run(env, "coverage").stdout.trim().split("\n");
    // Antigravity's fixture is a note, not a transcript.
    expect(lines[0]).toMatch(/^month\s+claude\s+codex\s+cursor$/);
    expect(lines.find((line) => line.startsWith("2026-07"))).toMatch(/\b1 \(\d+\)/);
    expect(lines.at(-1)).toMatch(/sessions \(chunks\)/);
    expect(run(env, "coverage", "-p", "/work/nowhere").stdout).toMatch(/No sessions indexed/);
  });

  it("keeps a deleted transcript searchable until forgotten", () => {
    const env = sandbox();
    run(env, "index");
    const idOf = () =>
      /^\[1\] ([0-9a-f]{8}) codex /m.exec(run(env, "search", "warehouse").stdout)?.[1];
    const id = idOf() as string;
    expect(id).toBeDefined();
    expect(run(env, "forget", id).stderr).toMatch(/still has its transcript/);
    rmSync(env.AGENTLORE_CODEX_DIR as string, { recursive: true, force: true });
    mkdirSync(env.AGENTLORE_CODEX_DIR as string);
    expect(run(env, "index").stdout).toMatch(/kept 1 deleted source in the archive/);
    expect(idOf()).toBe(id);
    expect(run(env, "status").stdout).toMatch(/^kept from deleted transcripts: 1 session /m);
    expect(run(env, "index", "--rebuild").code).toBe(0);
    expect(idOf()).toBe(id);
    const forgot = run(env, "forget", id);
    expect(forgot.stdout).toMatch(/^Forgot session \S+ \(1 deleted transcript\)/);
    expect(idOf()).toBeUndefined();
    expect(run(env, "status").stdout).not.toMatch(/kept from deleted/);
  });

  it.skipIf(process.platform === "win32")(
    "shows the daily job it would install, and that none is installed",
    () => {
      const env = sandbox();
      const home = join(env.AGENTLORE_HOME as string, "user");
      const user = { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
      expect(run(user, "schedule", "status").stdout).toMatch(/^Not scheduled/);
      const dry = run(user, "schedule", "install", "--at", "07:15", "--dry-run");
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain(`# ${home}`);
      expect(dry.stdout).toMatch(/07:15|<integer>15<\/integer>/);
      expect(dry.stdout).toContain(env.AGENTLORE_HOME as string);
      expect(dry.stdout).toMatch(/^\$ (launchctl|systemctl) /m);
      // A dry run writes nothing.
      expect(existsSync(home)).toBe(false);
      expect(run(user, "schedule", "install", "--at", "25:00", "--dry-run").stderr).toMatch(
        /HH:MM/,
      );
    },
  );

  it("reads the user's own decision words from words.json", () => {
    const env = sandbox();
    run(env, "index");
    // The fixture's user asked "How does the warehouse import work?".
    expect(run(env, "search", "--said", "decision", "warehouse").stdout).not.toContain("codex");
    mkdirSync(env.AGENTLORE_HOME as string, { recursive: true });
    writeFileSync(
      join(env.AGENTLORE_HOME as string, "words.json"),
      '{"decisionWords": ["how does"]}',
    );
    const found = run(env, "search", "--said", "decision", "warehouse");
    expect(found.stdout).toMatch(/codex .* · user decided/);
    writeFileSync(join(env.AGENTLORE_HOME as string, "words.json"), "{oops");
    expect(run(env, "search", "warehouse").stderr).toMatch(
      /warning: .*words\.json: not valid JSON/,
    );
  });

  it("prints the version", () => {
    expect(run(sandbox(), "--version").stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.skipIf(process.platform === "win32")("builds an executable bin with a shebang", () => {
    expect(statSync(cli).mode & 0o111).not.toBe(0);
    const out = execFileSync(cli, ["--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
