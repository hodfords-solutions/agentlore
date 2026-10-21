import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const core = join(import.meta.dirname, "../src/core");

describe("architecture", () => {
  it("keeps core independent of adapters, interfaces and the composition root", () => {
    const offenders = readdirSync(core)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) =>
        /from "\.\.\/(adapters|app|cli|mcp)[/.]/.test(readFileSync(join(core, name), "utf8")),
      );
    expect(offenders).toEqual([]);
  });
});
