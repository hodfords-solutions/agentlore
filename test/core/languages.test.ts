import { describe, expect, it } from "vitest";
import { LANGUAGES, STOPWORDS, TASK_WORDS } from "../../src/core/languages/index.js";

describe("language packs", () => {
  it("have unique codes and lowercase, NFC word lists", () => {
    const codes = LANGUAGES.map((pack) => pack.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const word of [...STOPWORDS, ...TASK_WORDS]) {
      expect(word).toBe(word.normalize("NFC").toLowerCase());
      expect(word).toMatch(/^[\p{L}\p{M}\p{N}_]+$/u);
    }
  });

  it("merge every pack's words", () => {
    expect(STOPWORDS).toEqual(expect.arrayContaining(["the", "của"]));
    expect(TASK_WORDS.has("fix")).toBe(true);
    expect(TASK_WORDS.has("sửa")).toBe(true);
  });
});
