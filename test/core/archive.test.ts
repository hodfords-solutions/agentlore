import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ARCHIVE_VERSION, ARCHIVED_VERSION, ensureArchive } from "../../src/core/archive.js";
import { REDACTION_VERSION } from "../../src/core/redact.js";
import { migrate, SCHEMA_VERSION } from "../../src/core/schema.js";
import { openStore } from "../../src/core/store.js";
import { chunk } from "../helpers.js";

const dbs: Database.Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

const fresh = () => {
  const db = new Database(":memory:");
  dbs.push(db);
  migrate(db, "index.db");
  return db;
};

const texts = (db: Database.Database) =>
  (db.prepare("SELECT text FROM chunks ORDER BY id").all() as { text: string }[]).map(
    (r) => r.text,
  );

describe("archive", () => {
  it("survives a rebuild for a newer schema, keeping chunk order", () => {
    const store = openStore(":memory:");
    store.saveSource(
      { id: "/gone.jsonl", tool: "claude", version: "1", checkpoint: null },
      [chunk({ text: "first quokka" }), chunk({ text: "second quokka" })],
      { reset: false },
    );
    store.archiveSource("/gone.jsonl");
    store.db.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    migrate(store.db, "index.db");
    expect(texts(store.db)).toEqual(["first quokka", "second quokka"]);
    expect(store.getSource("/gone.jsonl")).toMatchObject({ version: ARCHIVED_VERSION });
    expect(store.chunkCount()).toBe(2);
    store.close();
  });

  it("redacts archived text again when the redaction rules changed", () => {
    const db = fresh();
    db.prepare(
      `INSERT INTO archive (chunk_key, source_id, kind, tool, session_id, project, started_at,
        ended_at, text, sidechain, archived_at, redaction_version)
       VALUES ('k', '/gone.jsonl', 'transcript', 'claude', 's', '/p', 't', 't', ?, 0, 't', ?)`,
    ).run("user: PASSWORD=hunter2hunter2 for the quokka db", REDACTION_VERSION - 1);
    db.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    migrate(db, "index.db");
    expect(texts(db)[0]).not.toContain("hunter2hunter2");
    const archived = db.prepare("SELECT text, redaction_version AS v FROM archive").get() as {
      text: string;
      v: number;
    };
    expect(archived.text).not.toContain("hunter2hunter2");
    expect(archived.v).toBe(REDACTION_VERSION);
  });

  it("refuses an archive written by a newer agentlore", () => {
    const db = fresh();
    db.prepare("UPDATE archive_meta SET value = ? WHERE key = 'version'").run(
      String(ARCHIVE_VERSION + 1),
    );
    expect(() => ensureArchive(db, "index.db")).toThrow(/newer agentlore/);
  });
});
