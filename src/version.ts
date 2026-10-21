import { createRequire } from "node:module";

// src/version.ts and dist/version.js are both one level below package.json.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const VERSION = pkg.version;
