import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { phrases, provenance } from "../../src/core/provenance.js";
import { loadExtraWords, loadPhrases } from "../../src/core/words.js";
import { tempDir } from "../helpers.js";

const file = (content: string) => {
  const path = join(tempDir("lore-words-"), "words.json");
  writeFileSync(path, content);
  return path;
};

describe("loadExtraWords", () => {
  it("reads a user's own decision and correction words", () => {
    const path = file('{"decisionWords": ["ship it", " lgtm "], "correctionWords": ["my bad"]}');
    expect(loadExtraWords(path)).toEqual({
      words: { decisionWords: ["ship it", "lgtm"], correctionWords: ["my bad"] },
      problems: [],
    });
  });

  it("adds nothing without a file, and describes what is invalid", () => {
    expect(loadExtraWords(join(tempDir("lore-words-"), "none.json"))).toEqual({
      words: {},
      problems: [],
    });
    expect(loadExtraWords(file("{oops")).problems[0]).toMatch(/not valid JSON/);
    expect(loadExtraWords(file("[]")).problems[0]).toMatch(/expected an object/);
    const mixed = loadExtraWords(file('{"decisionWords": ["ok go", 3, ""], "stopwords": ["x"]}'));
    expect(mixed.words).toEqual({ decisionWords: ["ok go"] });
    expect(mixed.problems).toHaveLength(2);
  });

  it("reports problems and still returns the packs' phrases", () => {
    const warnings: string[] = [];
    const words = loadPhrases(file('{"decisionWords": "ship it"}'), (w) => warnings.push(w));
    expect(warnings).toHaveLength(1);
    expect(words.decides("we decided to keep it")).toBe(true);
  });
});

describe("phrases", () => {
  it("adds a user's words to the language packs'", () => {
    const own = phrases({ decisionWords: ["ship it"], correctionWords: ["my bad"] });
    const text = "user: ship it, the ledger stays in postgres";
    expect(provenance(text, ["ledger"])).toEqual({ speaker: "user" });
    expect(provenance(text, ["ledger"], undefined, own)).toEqual({
      speaker: "user",
      decided: true,
    });
    expect(own.corrects("my bad, it was the other ledger")).toBe(true);
    expect(own.decides("chốt phương án B")).toBe(true);
  });

  it("knows everyday Vietnamese decisions and corrections, not look-alikes", () => {
    const words = phrases();
    expect(words.decides("ok làm luôn phần redact")).toBe(true);
    expect(words.decides("duyệt phương án này")).toBe(true);
    expect(words.decides("giải quyết lỗi này trước")).toBe(false);
    expect(words.corrects("à không, ý tôi là bảng khác")).toBe(true);
    expect(words.corrects("lộn rồi, file kia")).toBe(true);
    expect(words.corrects("đây không phải lỗi của bạn")).toBe(false);
  });
});
