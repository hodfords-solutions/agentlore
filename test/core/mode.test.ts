import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ModeState,
  readModeState,
  readModeStateStrict,
  resolveMode,
  setGlobalMode,
  setPathMode,
  writeModeState,
} from "../../src/core/mode.js";
import { hostPath, tempDir } from "../helpers.js";

describe("resolveMode", () => {
  it("is off without any setting", () => {
    expect(resolveMode({}, hostPath("/work/repo"))).toEqual({ mode: "off", source: "default" });
  });

  it("uses the global setting when no path rule matches", () => {
    const state: ModeState = { global: "on", paths: { [hostPath("/other")]: "off" } };
    expect(resolveMode(state, hostPath("/work/repo"))).toEqual({ mode: "on", source: "global" });
  });

  it("uses the longest matching path rule, at folder boundaries", () => {
    const state: ModeState = {
      global: "off",
      paths: { [hostPath("/work")]: "on", [hostPath("/work/repo")]: "off" },
    };
    expect(resolveMode(state, hostPath("/work/repo/src"))).toEqual({
      mode: "off",
      source: "path",
      rule: hostPath("/work/repo"),
    });
    expect(resolveMode(state, hostPath("/work/other")).mode).toBe("on");
    expect(resolveMode(state, hostPath("/work")).mode).toBe("on");
    // "/work/repository" is not inside "/work/repo".
    expect(resolveMode(state, hostPath("/work/repository"))).toMatchObject({
      rule: hostPath("/work"),
    });
    expect(resolveMode(state, hostPath("/workshop")).source).toBe("global");
  });

  it("normalizes the cwd and the rules like project paths", () => {
    const state: ModeState = { paths: { [`${hostPath("/work/repo")}/`]: "on" } };
    expect(resolveMode(state, `${hostPath("/work/repo")}/./src/`).mode).toBe("on");
  });

  it("matches a root rule", () => {
    expect(resolveMode({ paths: { [hostPath("/")]: "on" } }, hostPath("/a/b")).mode).toBe("on");
  });

  it("compares Windows paths without case and with either separator", () => {
    const state: ModeState = { paths: { "C:\\Work\\Repo": "on" } };
    expect(resolveMode(state, "c:/work/repo/src", path.win32).mode).toBe("on");
    expect(resolveMode(state, "C:\\Work\\Repository", path.win32).mode).toBe("off");
    expect(resolveMode({ paths: { "C:\\": "on" } }, "C:\\x", path.win32).mode).toBe("on");
  });

  it("ignores rules with invalid values or relative paths", () => {
    const state = { paths: { relative: "on", [hostPath("/work")]: "maybe" } } as never;
    expect(resolveMode(state, hostPath("/work/relative")).mode).toBe("off");
  });
});

describe("mode state file", () => {
  it("reads a missing, corrupt or invalid file as no settings", () => {
    const dir = tempDir("lore-mode-");
    const file = path.join(dir, "mode.json");
    expect(readModeState(file)).toEqual({});
    writeFileSync(file, "{not json");
    expect(readModeState(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ global: "loud", paths: [] }));
    expect(readModeState(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ global: "on", paths: { "/a": "on", "/b": 3 } }));
    expect(readModeState(file)).toEqual({ global: "on", paths: { "/a": "on" } });
    // A directory instead of a file.
    mkdirSync(path.join(dir, "dir.json"));
    expect(readModeState(path.join(dir, "dir.json"))).toEqual({});
  });

  it("drops only the invalid field when reading leniently", () => {
    const file = path.join(tempDir("lore-mode-"), "mode.json");
    writeFileSync(file, JSON.stringify({ global: "On", paths: { "/a": "on" } }));
    expect(readModeState(file)).toEqual({ paths: { "/a": "on" } });
    writeFileSync(file, JSON.stringify({ global: "on", paths: ["/a"] }));
    expect(readModeState(file)).toEqual({ global: "on" });
  });

  it("reads strictly for writing: missing is empty, anything invalid throws naming the field", () => {
    const dir = tempDir("lore-mode-");
    const file = path.join(dir, "mode.json");
    expect(readModeStateStrict(file)).toEqual({});
    const valid = { global: "on", paths: { "/a": "on", "/b": "off" } };
    writeFileSync(file, JSON.stringify(valid));
    expect(readModeStateStrict(file)).toEqual(valid);
    const cases: [string, RegExp][] = [
      ["{not json", /mode\.json is not valid JSON/],
      ["[]", /mode\.json: the mode settings are not a JSON object/],
      ['{"global":"On"}', /mode\.json: "global" must be "on" or "off"/],
      ['{"paths":[]}', /mode\.json: "paths" is not an object/],
      ['{"paths":{"/a":"on","/b":3}}', /mode\.json: the rule for \/b must be "on" or "off"/],
    ];
    for (const [content, error] of cases) {
      writeFileSync(file, content);
      expect(() => readModeStateStrict(file)).toThrow(error);
    }
    mkdirSync(path.join(dir, "dir.json"));
    expect(() => readModeStateStrict(path.join(dir, "dir.json"))).toThrow();
  });

  it("reports an unreadable file instead of reading it as empty", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const file = path.join(tempDir("lore-mode-"), "mode.json");
    writeFileSync(file, '{"global":"on"}');
    chmodSync(file, 0o000);
    expect(() => readModeStateStrict(file)).toThrow(/EACCES/);
    expect(readModeState(file)).toEqual({});
  });

  it("writes atomically, privately, creating the folder", () => {
    const dir = tempDir("lore-mode-");
    const file = path.join(dir, "home", "mode.json");
    writeModeState(file, { global: "on", paths: { [hostPath("/w")]: "off" } });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      global: "on",
      paths: { [hostPath("/w")]: "off" },
    });
    expect(readdirSync(path.dirname(file))).toEqual(["mode.json"]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("updates the global setting and path rules", () => {
    let state: ModeState = {};
    state = setGlobalMode(state, "on");
    state = setPathMode(state, `${hostPath("/work/repo")}/`, "off");
    expect(state).toEqual({ global: "on", paths: { [hostPath("/work/repo")]: "off" } });
    state = setPathMode(state, hostPath("/work/repo"), undefined);
    expect(state).toEqual({ global: "on", paths: {} });
  });
});
