import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { REDACTION_VERSION } from "../../src/core/redact.js";
import { checkCurrent, enableIncrementalVacuum, migrate, rebuild } from "../../src/core/schema.js";

const dbs: Database.Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

/** A current index with one source, recorded as redacted by `redactionVersion`. */
const indexWith = (redactionVersion: string) => {
  const db = new Database(":memory:");
  dbs.push(db);
  rebuild(db);
  db.prepare("INSERT INTO sources VALUES ('s', 'codex', '1', '{}')").run();
  db.prepare("UPDATE meta SET value = ? WHERE key = 'redactionVersion'").run(redactionVersion);
  return db;
};
const sourceCount = (db: Database.Database) =>
  (db.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n;

describe("migrate", () => {
  it("refuses an index redacted by newer rules and keeps its data", () => {
    const db = indexWith(String(REDACTION_VERSION + 1));
    expect(() => migrate(db, "index.db")).toThrow(/newer agentlore.*upgrade.*delete/s);
    expect(sourceCount(db)).toBe(1);
  });

  it("compares redaction versions as numbers", () => {
    const db = indexWith(`${REDACTION_VERSION}0`);
    expect(() => migrate(db, "index.db")).toThrow(/newer agentlore/);
  });

  it("rebuilds an index redacted by older rules", () => {
    const db = indexWith(String(REDACTION_VERSION - 1));
    migrate(db, "index.db");
    expect(sourceCount(db)).toBe(0);
  });
});

describe("checkCurrent", () => {
  it("reports an index redacted by newer rules as newer, not older", () => {
    const db = indexWith(String(REDACTION_VERSION + 1));
    expect(() => checkCurrent(db, "index.db")).toThrow(/newer agentlore/);
  });
});

describe("enableIncrementalVacuum", () => {
  /** An empty index still without auto-vacuum whose VACUUM fails with `code`. */
  const failingVacuum = (code: string) => {
    const db = new Database(":memory:");
    dbs.push(db);
    rebuild(db);
    const exec = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (sql === "VACUUM") throw Object.assign(new Error(code), { code });
      return exec(sql);
    };
    return db;
  };

  it.each(["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_BUSY_SNAPSHOT"])(
    "leaves it for a later open when another connection is busy (%s)",
    (code) => {
      expect(() => enableIncrementalVacuum(failingVacuum(code))).not.toThrow();
    },
  );

  it.each(["SQLITE_FULL", "SQLITE_IOERR", "SQLITE_CORRUPT"])("rethrows %s", (code) => {
    expect(() => enableIncrementalVacuum(failingVacuum(code))).toThrow(code);
  });
});
