import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandHome, isWithin, normalizeProject } from "../../src/core/project.js";

describe("normalizeProject (POSIX paths)", () => {
  const normalize = (project: string | undefined) => normalizeProject(project, path.posix);

  it("drops trailing separators and resolves absolute paths", () => {
    expect(normalize("/work/repo-b/")).toBe("/work/repo-b");
    expect(normalize("/work/./x/../repo-b")).toBe("/work/repo-b");
  });

  it("keeps relative paths and the root as given", () => {
    expect(normalize("repo-b/")).toBe("repo-b");
    expect(normalize("/")).toBe("/");
  });

  it("decodes percent-encoded paths, leaving invalid escapes as they are", () => {
    expect(normalize("/work/my%20repo/")).toBe("/work/my repo");
    expect(normalize("/work/100%/x")).toBe("/work/100%/x");
  });

  it("expands a leading ~ to the home folder", () => {
    const expand = (project: string) => normalizeProject(project, path.posix, "/Users/me");
    expect(expand("~")).toBe("/Users/me");
    expect(expand("~/work/api/")).toBe("/Users/me/work/api");
    expect(expand("~other/x")).toBe("~other/x");
    expect(expand("/work/~/x")).toBe("/work/~/x");
  });

  it("keeps a shortened label as it is", () => {
    expect(normalize("…/apps/api/")).toBe("…/apps/api");
  });

  it("treats an empty project as no filter", () => {
    expect(normalize(undefined)).toBeUndefined();
    expect(normalize("")).toBeUndefined();
  });
});

describe("normalizeProject (Windows paths)", () => {
  const normalize = (project: string) => normalizeProject(project, path.win32);

  it("drops trailing separators of drive paths and resolves them", () => {
    expect(normalize("C:\\work\\repo\\")).toBe("C:\\work\\repo");
    expect(normalize("C:\\work\\.\\x\\..\\repo")).toBe("C:\\work\\repo");
    expect(normalize("C:/work/repo/")).toBe("C:\\work\\repo");
  });

  it("keeps a drive root and relative paths", () => {
    expect(normalize("C:\\")).toBe("C:\\");
    expect(normalize("repo\\")).toBe("repo");
  });

  it("expands a leading ~ to the home folder", () => {
    expect(normalizeProject("~\\work\\api", path.win32, "C:\\Users\\me")).toBe(
      "C:\\Users\\me\\work\\api",
    );
  });

  it("resolves UNC paths and decodes percent-escapes", () => {
    expect(normalize("\\\\server\\share\\repo\\")).toBe("\\\\server\\share\\repo");
    expect(normalize("C:\\work\\my%20repo")).toBe("C:\\work\\my repo");
  });
});

describe("normalizeProject (host paths)", () => {
  it("uses the host's path flavour by default", () => {
    expect(normalizeProject("/work/repo-b/")).toBe(path.resolve("/work/repo-b"));
  });
});

describe("isWithin", () => {
  it("matches the folder itself and its subfolders, at folder boundaries", () => {
    expect(isWithin("/work/repo", "/work/repo", path.posix)).toBe(true);
    expect(isWithin("/work/repo", "/work/repo/src", path.posix)).toBe(true);
    expect(isWithin("/work/repo", "/work/repository", path.posix)).toBe(false);
    expect(isWithin("/", "/work", path.posix)).toBe(true);
    expect(isWithin("/Work", "/work", path.posix)).toBe(false);
  });

  it("ignores case for Windows paths", () => {
    expect(isWithin("C:\\Work", "c:\\work\\repo", path.win32)).toBe(true);
    expect(isWithin("C:\\", "C:\\x", path.win32)).toBe(true);
  });
});

describe("expandHome", () => {
  it("expands a leading ~ alone or before either separator, nothing else", () => {
    expect(expandHome("~", "/home/me")).toBe("/home/me");
    expect(expandHome("~/cfg", "/home/me")).toBe("/home/me/cfg");
    expect(expandHome("~\\cfg", "C:\\Users\\me")).toBe("C:\\Users\\me\\cfg");
    expect(expandHome("~bob/cfg", "/home/me")).toBe("~bob/cfg");
    expect(expandHome("/a/~", "/home/me")).toBe("/a/~");
    expect(expandHome("~/cfg", "")).toBe("~/cfg");
  });
});
