import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The CLI entry (`dist/cli/index.js`) of a fresh build in a temporary folder. */
    cliPath: string;
  }
}

const root = join(import.meta.dirname, "../..");

/**
 * Vitest global setup: compile the package once per test run into a temporary folder (never
 * the repository's dist/), next to a copy of package.json so `version.ts` resolves, with a
 * link to the repository's node_modules so the build's dependencies resolve.
 */
export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), "lore-build-"));
  const outDir = join(dir, "dist");
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.build.json",
      "--outDir",
      outDir,
    ],
    { cwd: root, stdio: "inherit" },
  );
  execFileSync(process.execPath, [join(root, "scripts/postbuild.mjs"), outDir], { cwd: root });
  copyFileSync(join(root, "package.json"), join(dir, "package.json"));
  // A junction needs no special rights on Windows; the type is ignored elsewhere.
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "junction");
  project.provide("cliPath", join(outDir, "cli/index.js"));
  return () => rmSync(dir, { recursive: true, force: true });
}
