import { describe, expect, it } from "vitest";
import { promptTerms } from "../../src/core/prompt-context.js";
import { MAX_TERMS } from "../../src/core/search.js";

/** Accented words (so every adjacent pair is checked as a phrase) that each match 5 chunks. */
const words = (n: number) => Array.from({ length: n }, (_, i) => `đa${i}`).join(" ");

describe("promptTerms", () => {
  it("bounds the index lookups for a long pasted prompt", () => {
    const lookup = (terms: string[]) => (terms[0]?.includes(" ") ? 0 : 5);
    let calls = 0;
    const count = (terms: string[]) => {
      calls++;
      return lookup(terms);
    };
    const terms = promptTerms(words(5000), count);
    expect(terms).toHaveLength(MAX_TERMS);
    expect(calls).toBeLessThanOrEqual(9 * MAX_TERMS);
    // Same terms as from the prompt's beginning alone.
    expect(terms).toEqual(promptTerms(words(MAX_TERMS), lookup));
  });
});
