import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentMode,
  defaultAdapters,
  indexPath,
  loreHome,
  modePath,
  openDefault,
  openExisting,
  openIndexReadOnly,
} from "../src/app.js";
import { tempDir } from "./helpers.js";

const posix = process.platform !== "win32";
const mode = (path: string) => statSync(path).mode & 0o777;

describe("loreHome", () => {
  it("honours AGENTLORE_HOME", () => {
    expect(loreHome({ AGENTLORE_HOME: "/x/lore" })).toBe(resolve("/x/lore"));
  });

  it("is absolute, so the index path is never read as a SQLite file: URI", () => {
    const home = loreHome({ AGENTLORE_HOME: "file:lore?mode=memory" });
    expect(isAbsolute(home)).toBe(true);
    expect(indexPath({ AGENTLORE_HOME: "file:lore?mode=memory" })).toBe(
      join(resolve("file:lore?mode=memory"), "index.db"),
    );
    expect(indexPath({ AGENTLORE_HOME: "file:lore" }).startsWith("file:")).toBe(false);
  });

  // Windows forbids ":" in file names.
  it.skipIf(process.platform === "win32")(
    "opens an index under a relative home named like a URI as a plain file",
    () => {
      const parent = tempDir("lore-app-");
      const cwd = process.cwd();
      process.chdir(parent);
      try {
        openDefault({ AGENTLORE_HOME: "file:home" }).store.close();
      } finally {
        process.chdir(cwd);
      }
      expect(existsSync(join(parent, "file:home", "index.db"))).toBe(true);
      expect(existsSync(join(parent, "home"))).toBe(false);
    },
  );
});

describe("defaultAdapters", () => {
  it("registers every supported tool", () => {
    expect(defaultAdapters({}).map((a) => a.tool)).toEqual([
      "claude",
      "claude-history",
      "codex",
      "cursor",
      "antigravity",
      "memory",
    ]);
  });

  it("reads each tool from its AGENTLORE_<TOOL>_DIR override", async () => {
    const dir = tempDir("lore-app-");
    const env = {
      AGENTLORE_CLAUDE_DIR: join(dir, "claude"),
      AGENTLORE_CODEX_DIR: join(dir, "codex"),
      AGENTLORE_CURSOR_DIR: join(dir, "cursor"),
      AGENTLORE_ANTIGRAVITY_DIR: join(dir, "antigravity"),
      AGENTLORE_HOME: join(dir, "home"),
    };
    const missing = await Promise.all(
      defaultAdapters(env).map(async (a) => (await a.discover()).missingRoot),
    );
    expect(missing).toEqual([
      env.AGENTLORE_CLAUDE_DIR,
      join(dir, "history.jsonl"),
      env.AGENTLORE_CODEX_DIR,
      join(env.AGENTLORE_CURSOR_DIR, "globalStorage", "state.vscdb"),
      env.AGENTLORE_ANTIGRAVITY_DIR,
      // No notes yet is not a missing tool.
      undefined,
    ]);
  });
});

describe("openIndexReadOnly", () => {
  it("creates nothing when there is no index yet, and reads an existing one", () => {
    const home = join(tempDir("lore-app-"), "home");
    expect(openIndexReadOnly({ AGENTLORE_HOME: home })).toBeUndefined();
    expect(existsSync(home)).toBe(false);
    openDefault({ AGENTLORE_HOME: home }).store.close();
    const store = openIndexReadOnly({ AGENTLORE_HOME: home });
    expect(store?.stats()).toEqual([]);
    store?.close();
  });
});

describe("openExisting", () => {
  it("creates nothing when there is no index yet, and opens an existing one for writing", () => {
    const home = join(tempDir("lore-app-"), "home");
    expect(openExisting({ AGENTLORE_HOME: home })).toBeUndefined();
    expect(existsSync(home)).toBe(false);
    openDefault({ AGENTLORE_HOME: home }).store.close();
    const runtime = openExisting({ AGENTLORE_HOME: home });
    runtime?.store.setMeta("x", "y");
    expect(runtime?.store.getMeta("x")).toBe("y");
    expect(runtime?.lockPath).toBe(join(home, "index.lock"));
    runtime?.store.close();
  });
});

describe.skipIf(!posix)("openDefault", () => {
  const tmpHome = () => {
    const dir = tempDir("lore-app-");
    return join(dir, "home");
  };

  it("creates the home directory 0700 and the index files 0600", () => {
    const home = tmpHome();
    const runtime = openDefault({ AGENTLORE_HOME: home });
    runtime.store.setMeta("x", "y");
    try {
      expect(mode(home)).toBe(0o700);
      for (const file of ["index.db", "index.db-wal", "index.db-shm"]) {
        expect(mode(join(home, file))).toBe(0o600);
      }
    } finally {
      runtime.store.close();
    }
  });

  it("tightens the index files but leaves an existing home's permissions alone", () => {
    const home = tmpHome();
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    writeFileSync(join(home, "index.db"), "");
    chmodSync(join(home, "index.db"), 0o644);
    writeFileSync(join(home, "index.lock"), "{}");
    chmodSync(join(home, "index.lock"), 0o644);
    const runtime = openDefault({ AGENTLORE_HOME: home });
    runtime.store.close();
    // AGENTLORE_HOME may be a shared folder such as ~/Documents: only a folder agentlore created
    // is made private.
    expect(mode(home)).toBe(0o755);
    expect(mode(join(home, "index.db"))).toBe(0o600);
    expect(mode(join(home, "index.lock"))).toBe(0o600);
  });

  it("restores the process umask", () => {
    const before = process.umask();
    openDefault({ AGENTLORE_HOME: tmpHome() }).store.close();
    expect(process.umask()).toBe(before);
  });
});

describe("currentMode", () => {
  it("reads the mode file in AGENTLORE_HOME, off when there is none", () => {
    const home = tempDir("lore-app-mode-");
    const env = { AGENTLORE_HOME: home };
    expect(modePath(env)).toBe(join(home, "mode.json"));
    expect(currentMode(home, env)).toEqual({ mode: "off", source: "default" });
    writeFileSync(modePath(env), JSON.stringify({ paths: { [home]: "on" } }));
    expect(currentMode(join(home, "sub"), env)).toEqual({ mode: "on", source: "path", rule: home });
  });
});
