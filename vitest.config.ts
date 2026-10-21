import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Builds the CLI once per run into a temporary folder; tests read its path with inject().
    globalSetup: ["test/setup/build-cli.ts"],
    // CLI and MCP tests spawn Node processes, which can be slow on CI runners (Windows).
    testTimeout: 30_000,
    // Like the `lore` CLI: SQLite URI filenames, so Cursor's database can be opened immutable.
    env: { SQLITE_USE_URI: "1" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The CLI entry only runs in spawned processes (test/cli, test/mcp/stdio), which in-process
      // coverage does not see; those tests cover it end to end instead.
      exclude: ["src/cli/**"],
      reporter: ["text", "html"],
      // A little below the current numbers (lines 97%, branches 91%), so coverage cannot quietly drop.
      thresholds: { lines: 95, branches: 88 },
    },
  },
});
