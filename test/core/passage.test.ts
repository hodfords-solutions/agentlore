import { describe, expect, it } from "vitest";
import { bestPassage, oneLine } from "../../src/core/passage.js";

const filler = (n: number) => "Lorem ipsum dolor sit amet. ".repeat(n);

describe("bestPassage", () => {
  it("returns a short text whole", () => {
    expect(bestPassage("Socket emit to user.", ["socket"], 700)).toBe("Socket emit to user.");
  });

  it("prefers the region containing the most distinct terms", () => {
    const text = `${filler(30)}The socket alone here. ${filler(30)}The chat service calls the socket microservice over gRPC and emitToUser sends it. ${filler(30)}`;
    const passage = bestPassage(text, ["socket", "grpc", "emittouser"], 300);
    expect(passage).toContain("socket microservice over gRPC and emitToUser");
    expect(passage.length).toBeLessThanOrEqual(302);
  });

  it("matches terms without diacritics or case, as the index does", () => {
    const text = `${filler(40)}Hệ thống gửi TIN NHẮN qua socket. ${filler(40)}`;
    expect(bestPassage(text, ["tin", "nhan", "socket"], 200)).toContain("Hệ thống gửi TIN NHẮN");
  });

  it("respects the cap, cutting at a sentence or line boundary and marking cuts with …", () => {
    const text = `${filler(20)}Key fact: grpc is used.\nNext line about grpc again. ${filler(20)}`;
    const passage = bestPassage(text, ["grpc"], 200);
    expect(passage.length).toBeLessThanOrEqual(202);
    expect(passage.startsWith("…")).toBe(true);
    expect(passage.endsWith("…")).toBe(true);
    // Starts at the beginning of a sentence or line, ends after one.
    expect(passage).toMatch(/^…(Lorem|Key|Next)/);
    expect(passage).toMatch(/[.!?\n]…$/);
  });

  it("never cuts inside a surrogate pair or between a letter and its combining mark", () => {
    const emoji = "😀".repeat(400);
    const passage = bestPassage(`${emoji}-grpc-${emoji}`, ["grpc"], 101);
    expect(passage).toContain("grpc");
    expect(passage).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    const decomposed = "e\u0301".repeat(400);
    // No spaces or sentence ends to cut at: the cuts fall inside the runs of "é".
    const marks = bestPassage(`${decomposed}-grpc-${decomposed}`, ["grpc"], 101);
    expect(marks).toContain("grpc");
    const inner = marks.replace(/^…/, "").replace(/…$/, "");
    expect(inner).not.toMatch(/^\p{M}/u);
    expect(inner).not.toMatch(/e$/u);
  });

  it("falls back to the start of the text when no term occurs", () => {
    const passage = bestPassage(`First sentence. ${filler(50)}`, ["absent"], 100);
    expect(passage.startsWith("First sentence.")).toBe(true);
    expect(passage.length).toBeLessThanOrEqual(101);
  });
});

describe("oneLine", () => {
  it("collapses whitespace and cuts at a word boundary", () => {
    expect(oneLine("a  b\n\nc", 50)).toBe("a b c");
    expect(oneLine("alpha beta gamma delta", 12)).toBe("alpha beta…");
  });
});
