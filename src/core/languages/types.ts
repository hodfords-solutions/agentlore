/**
 * Word lists for one language, written with their diacritics and separated by whitespace. To
 * support a language, add a pack and list it in `index.ts`.
 */
export interface LanguagePack {
  /** BCP 47 language code. */
  code: string;
  /** Function words that match almost every chunk: never search terms. */
  stopwords: string;
  /**
   * Words about the task rather than its subject ("fix", "test", "remember"): they match chunks
   * of every project, so the prompt hook does not use them to find related work.
   */
  taskWords: string;
  /** Words and phrases for "password": a value quoted right after one is redacted. */
  passwordWords: readonly string[];
  /** Words and phrases for logging in ("login", "account"): `user / secret` after one is redacted. */
  loginWords: readonly string[];
  /** Words and phrases a user decides with ("decided", "go with"): marks a turn as a decision. */
  decisionWords: readonly string[];
  /** Words and phrases that correct an earlier claim ("wrong", "actually"). */
  correctionWords: readonly string[];
}
