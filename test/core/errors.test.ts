import { describe, expect, it } from "vitest";
import { errnoCode, errorMessage } from "../../src/core/errors.js";

describe("errorMessage", () => {
  it("uses the message of an Error and stringifies anything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
  });
});

describe("errnoCode", () => {
  it("returns the code of a Node.js error", () => {
    expect(errnoCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("ENOENT");
  });

  it("returns undefined for values without a string code", () => {
    expect(errnoCode(new Error("x"))).toBeUndefined();
    expect(errnoCode({ code: 1 })).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
  });
});
