import { english } from "./en.js";
import type { LanguagePack } from "./types.js";
import { vietnamese } from "./vi.js";

export type { LanguagePack } from "./types.js";

export const LANGUAGES: readonly LanguagePack[] = [english, vietnamese];

const words = (list: string) => list.split(/\s+/).filter(Boolean);

/** Every pack's stopwords. */
export const STOPWORDS: readonly string[] = LANGUAGES.flatMap((pack) => words(pack.stopwords));

/** Every pack's task words. */
export const TASK_WORDS: ReadonlySet<string> = new Set(
  LANGUAGES.flatMap((pack) => words(pack.taskWords)),
);

/** Every pack's words for "password". */
export const PASSWORD_WORDS: readonly string[] = LANGUAGES.flatMap((pack) => pack.passwordWords);

/** Every pack's words for logging in. */
export const LOGIN_WORDS: readonly string[] = LANGUAGES.flatMap((pack) => pack.loginWords);

/** Every pack's words for deciding. */
export const DECISION_WORDS: readonly string[] = LANGUAGES.flatMap((pack) => pack.decisionWords);

/** Every pack's words for correcting an earlier claim. */
export const CORRECTION_WORDS: readonly string[] = LANGUAGES.flatMap(
  (pack) => pack.correctionWords,
);
