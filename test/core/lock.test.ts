import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withLock } from "../../src/core/lock.js";
import { tempDir } from "../helpers.js";

/** Fault injection for fs calls the lock makes; each hook runs once, then is cleared. */
const faults = vi.hoisted(() => ({
  writeFileSync: undefined as (() => void) | undefined,
  linkSync: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const faulty =
    <A extends unknown[], R>(name: keyof typeof faults, real: (...args: A) => R) =>
    (...args: A): R => {
      const fault = faults[name];
      faults[name] = undefined;
      fault?.();
      return real(...args);
    };
  return {
    ...fs,
    writeFileSync: faulty("writeFileSync", fs.writeFileSync),
    linkSync: faulty("linkSync", fs.linkSync),
  };
});

const errno = (code: string) => Object.assign(new Error(code), { code });

afterEach(() => {
  faults.writeFileSync = undefined;
  faults.linkSync = undefined;
});

describe("withLock", () => {
  it.skipIf(process.platform === "win32")(
    "creates the lock file readable by the owner only",
    async () => {
      const lock = join(tempDir("lore-lock-"), "index.lock");
      const seen = await withLock(lock, async () => statSync(lock).mode & 0o777);
      expect(seen).toBe(0o600);
    },
  );

  it("does not run while another holder has the lock", async () => {
    const lock = join(tempDir("lore-lock-"), "index.lock");
    const inner = await withLock(lock, async () => withLock(lock, async () => "inner"));
    expect(inner).toBeUndefined();
    expect(await withLock(lock, async () => "free again")).toBe("free again");
  });

  const lockFile = () => join(tempDir("lore-lock-"), "index.lock");
  const deadPid = () => {
    const { pid } = spawnSync(process.execPath, ["-e", ""]);
    if (!pid) throw new Error("could not spawn");
    return pid;
  };

  it("records the holder pid and a token in the lock file", async () => {
    const lock = lockFile();
    const content = await withLock(lock, async () => JSON.parse(readFileSync(lock, "utf8")));
    expect(content).toMatchObject({ pid: process.pid, token: expect.any(String) });
    expect(existsSync(lock)).toBe(false);
  });

  /** Above the largest pid Linux, macOS and Windows hand out, so no process can have it. */
  const IMPOSSIBLE_PID = 2 ** 22 + 12345;

  it.each([
    ["an exited child", deadPid],
    ["an impossible pid", () => IMPOSSIBLE_PID],
  ])("takes over a lock whose holder process is gone (%s)", async (_name, pid) => {
    const lock = lockFile();
    writeFileSync(lock, JSON.stringify({ pid: pid(), token: "old" }));
    expect(await withLock(lock, async () => "taken")).toBe("taken");
  });

  it("lets exactly one of two concurrent callers take over a stale lock", async () => {
    const lock = lockFile();
    writeFileSync(lock, JSON.stringify({ pid: IMPOSSIBLE_PID, token: "old" }));
    let running = 0;
    const results = await Promise.all(
      [1, 2].map((n) =>
        withLock(lock, async () => {
          running++;
          await new Promise((done) => setTimeout(done, 20));
          return n;
        }),
      ),
    );
    expect(running).toBe(1);
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("restores a lock that a new holder took between the stale judgement and the takeover", async () => {
    const dir = tempDir("lore-lock-");
    const lock = join(dir, "index.lock");
    writeFileSync(lock, JSON.stringify({ pid: IMPOSSIBLE_PID, token: "old" }));
    const fresh = JSON.stringify({ pid: process.pid, token: "new-holder" });
    const ran = await withLock(lock, async () => "ran", {
      // Another contender removed the stale lock and created its own in the meantime.
      beforeTakeover: () => {
        rmSync(lock);
        writeFileSync(lock, fresh);
      },
    });
    expect(ran).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(fresh);
    expect(readdirSync(dir)).toEqual(["index.lock"]);
  });

  const age = (lock: string) => {
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lock, old, old);
  };

  it("takes over a lock without a holder pid that has not been refreshed for too long", async () => {
    const lock = lockFile();
    writeFileSync(lock, "");
    age(lock);
    expect(await withLock(lock, async () => "taken")).toBe("taken");
  });

  it("never takes over a lock whose holder process is alive, however old", async () => {
    // A holder whose machine slept for a long time is still indexing when it wakes up.
    const lock = lockFile();
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "sleeper" }));
    age(lock);
    expect(await withLock(lock, async () => "taken")).toBeUndefined();
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("sleeper");
  });

  it("rethrows an error other than EEXIST when creating the lock", async () => {
    const lock = join(tempDir("lore-lock-"), "missing", "index.lock");
    await expect(withLock(lock, async () => "ran")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries when the holder releases the lock between EEXIST and reading it", async () => {
    const lock = lockFile();
    faults.writeFileSync = () => {
      throw errno("EEXIST");
    };
    expect(await withLock(lock, async () => "ran")).toBe("ran");
  });

  it("acquires the lock when another contender removed the stale lock first", async () => {
    const lock = lockFile();
    writeFileSync(lock, JSON.stringify({ pid: IMPOSSIBLE_PID, token: "old" }));
    const ran = await withLock(lock, async () => "ran", { beforeTakeover: () => rmSync(lock) });
    expect(ran).toBe("ran");
  });

  it("rethrows an error other than ENOENT when reading the holder", async () => {
    const lock = join(tempDir("lore-lock-"), "index.lock");
    mkdirSync(lock);
    await expect(withLock(lock, async () => "ran")).rejects.toMatchObject({ code: "EISDIR" });
  });

  it.each([
    ["EPERM", "a file system without hard links"],
    ["ENOTSUP", "a file system that does not support links"],
  ])("puts back a lock replaced meanwhile when linking fails with %s (%s)", async (code) => {
    const dir = tempDir("lore-lock-");
    const lock = join(dir, "index.lock");
    writeFileSync(lock, JSON.stringify({ pid: IMPOSSIBLE_PID, token: "old" }));
    const fresh = JSON.stringify({ pid: process.pid, token: "new-holder" });
    const ran = await withLock(lock, async () => "ran", {
      beforeTakeover: () => {
        rmSync(lock);
        writeFileSync(lock, fresh);
        faults.linkSync = () => {
          throw errno(code);
        };
      },
    });
    expect(ran).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe(fresh);
    expect(readdirSync(dir)).toEqual(["index.lock"]);
  });

  it("respects a fresh lock even when its content is not readable yet", async () => {
    const lock = lockFile();
    writeFileSync(lock, "");
    expect(await withLock(lock, async () => "ran")).toBeUndefined();
  });

  it("refreshes the lock when touched", async () => {
    const lock = lockFile();
    await withLock(lock, async (touch) => {
      age(lock);
      touch();
      expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(60_000);
    });
  });

  it("refreshes the lock at most once per second", async () => {
    const lock = lockFile();
    const old = new Date(Date.now() - 11 * 60 * 1000);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await withLock(lock, async (touch) => {
        touch();
        utimesSync(lock, old, old);
        touch();
        const age = () => Date.now() - statSync(lock).mtimeMs;
        expect(age()).toBeGreaterThan(10 * 60 * 1000);
        vi.setSystemTime(Date.now() + 1001);
        touch();
        expect(age()).toBeLessThan(60_000);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the heartbeat once the lock file is gone", async () => {
    const lock = lockFile();
    const run = withLock(lock, async (touch) => {
      rmSync(lock);
      touch();
    });
    await expect(run).rejects.toThrow(/lost the index lock/);
  });

  it("fails the heartbeat once another holder took the lock, and keeps failing", async () => {
    const lock = lockFile();
    const errors: unknown[] = [];
    await withLock(lock, async (touch) => {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "someone-else" }));
      for (const _ of [1, 2]) {
        try {
          touch();
        } catch (error) {
          errors.push(error);
        }
      }
    });
    expect(errors).toHaveLength(2);
    expect(String(errors[1])).toMatch(/lost the index lock/);
  });

  it("does not delete a lock that another holder took over", async () => {
    const lock = lockFile();
    await withLock(lock, async () => {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "someone-else" }));
    });
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("someone-else");
  });
});
