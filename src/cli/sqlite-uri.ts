/**
 * Enables `file:` URIs, needed to open Cursor's database as immutable (`openCursorDb`).
 * better-sqlite3 reads this once on load, so import this module first. Any other value is
 * overridden; the index path is absolute, so it is never taken for a URI.
 */
process.env.SQLITE_USE_URI = "1";
