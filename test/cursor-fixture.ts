import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

/**
 * Builds a synthetic Cursor `User` folder: `globalStorage/state.vscdb` (WAL mode, table
 * `cursorDiskKV`) and `workspaceStorage/<hash>/` folders mapping composers to projects. Every
 * value is made up; no real Cursor data is ever used.
 */
export class CursorFixture {
  readonly globalDb: string;
  private readonly db: Database.Database;

  constructor(readonly userDir: string) {
    mkdirSync(join(userDir, "globalStorage"), { recursive: true });
    this.globalDb = join(userDir, "globalStorage", "state.vscdb");
    this.db = new Database(this.globalDb);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    // Unrelated keys on both sides of the ranges the adapter scans.
    this.raw("bubbleId", "{}");
    this.raw("composerData", "{}");
    this.raw("composerDataZ:x", "{}");
    this.raw("aiSettings", "{}");
  }

  /** Store `value` (JSON-encoded unless already a string) under `key`. */
  raw(key: string, value: unknown): this {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    this.db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(key, text);
    return this;
  }

  /** A composer (conversation) whose messages are the given bubbles, in order. */
  composer(
    composerId: string,
    bubbles: [bubbleId: string, type: number][],
    over: Record<string, unknown> = {},
  ): this {
    return this.raw(`composerData:${composerId}`, {
      _v: 10,
      composerId,
      name: `Chat ${composerId}`,
      createdAt: Date.parse("2026-03-01T09:00:00Z"),
      lastUpdatedAt: Date.parse("2026-03-01T09:30:00Z") + bubbles.length,
      fullConversationHeadersOnly: bubbles.map(([bubbleId, type]) => ({ bubbleId, type })),
      ...over,
    });
  }

  /** One message of a composer. */
  bubble(composerId: string, bubbleId: string, value: Record<string, unknown>): this {
    return this.raw(`bubbleId:${composerId}:${bubbleId}`, { _v: 3, bubbleId, ...value });
  }

  /** A workspace folder listing `composerIds`, opened on `folder` (or a `.code-workspace` file). */
  workspace(
    hash: string,
    composerIds: string[],
    target?: { folder: string } | { workspace: string } | { raw: string },
  ): this {
    const dir = join(this.userDir, "workspaceStorage", hash);
    mkdirSync(dir, { recursive: true });
    if (target) {
      // `raw` is written as is, e.g. a URI exactly as Cursor encodes it.
      const json =
        "raw" in target
          ? target.raw
          : JSON.stringify(
              "folder" in target
                ? { folder: pathToFileURL(target.folder).href }
                : { workspace: pathToFileURL(target.workspace).href },
            );
      writeFileSync(join(dir, "workspace.json"), json);
    }
    const db = new Database(join(dir, "state.vscdb"));
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
      );
      db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
        "composer.composerData",
        JSON.stringify({ allComposers: composerIds.map((composerId) => ({ composerId })) }),
      );
    } finally {
      db.close();
    }
    return this;
  }

  delete(key: string): this {
    this.db.prepare("DELETE FROM cursorDiskKV WHERE key = ?").run(key);
    return this;
  }

  /** Checkpoint the WAL into the main file and close, like Cursor does when it quits. */
  close(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}
