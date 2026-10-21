import { readFileSync } from "node:fs";
import { errnoCode, errorMessage } from "./errors.js";
import { type ExtraWords, type Phrases, phrases } from "./provenance.js";

const KEYS = ["decisionWords", "correctionWords"] as const;
const MAX_WORDS = 500;
const MAX_WORD_CHARS = 100;

/**
 * A user's own decision and correction words from a JSON file such as
 * `{"decisionWords": ["ship it"], "correctionWords": ["my bad"]}`, added to the language packs'.
 * A missing file adds nothing; invalid parts are left out and described in `problems`.
 */
export function loadExtraWords(file: string): { words: ExtraWords; problems: string[] } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { words: {}, problems: [] };
    return { words: {}, problems: [`${file}: ${errorMessage(error)}`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { words: {}, problems: [`${file}: not valid JSON (${errorMessage(error)})`] };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { words: {}, problems: [`${file}: expected an object with ${KEYS.join(" and ")}`] };
  }
  const words: ExtraWords = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(json)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      problems.push(`${file}: unknown key "${key}" (expected ${KEYS.join(" or ")})`);
      continue;
    }
    const list = Array.isArray(value) ? value : [];
    const valid = list.filter(
      (w): w is string =>
        typeof w === "string" && w.trim().length > 0 && w.length <= MAX_WORD_CHARS,
    );
    if (!Array.isArray(value) || valid.length !== list.length || valid.length > MAX_WORDS) {
      problems.push(
        `${file}: "${key}" must be a list of at most ${MAX_WORDS} non-empty strings of up to ${MAX_WORD_CHARS} characters`,
      );
    }
    words[key as (typeof KEYS)[number]] = valid.slice(0, MAX_WORDS).map((w) => w.trim());
  }
  return { words, problems };
}

/** The phrases to search with: the language packs' plus the file's; problems go to `warn`. */
export function loadPhrases(file: string, warn: (message: string) => void): Phrases {
  const { words, problems } = loadExtraWords(file);
  for (const problem of problems) warn(problem);
  return words.decisionWords?.length || words.correctionWords?.length ? phrases(words) : phrases();
}
