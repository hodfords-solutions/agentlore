// Make the CLI entry executable after `tsc` (no-op on Windows, where npm creates .cmd shims).
// Usage: node scripts/postbuild.mjs [outDir]   (outDir defaults to the repository's dist/)
import { chmodSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = process.argv[2] ?? fileURLToPath(new URL("../dist", import.meta.url));
if (process.platform !== "win32") chmodSync(resolve(outDir, "cli/index.js"), 0o755);
