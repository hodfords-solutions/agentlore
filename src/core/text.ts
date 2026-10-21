/** One word character, as a RegExp source for the `u` flag: letters, marks, digits, "_". */
export const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}_]";

/** `text` without diacritics and with U+0111 as "d", as the index folds it (case is kept). */
export const foldDiacritics = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\u0111/g, "d");
