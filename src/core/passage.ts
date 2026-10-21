/**
 * Query-centred passages for the prompt hook. Texts are handled as code points so a cut never
 * splits a surrogate pair or a letter from its combining marks.
 */

import { foldDiacritics, WORD_CHAR } from "./text.js";

const MARK = /^\p{M}$/u;
const WORD = new RegExp(`^${WORD_CHAR}$`, "u");

/** One code point folded like the index: lowercase, no diacritics, U+0111 as "d". */
const fold = (cp: string) => foldDiacritics(cp.toLowerCase());

interface Occurrence {
  term: number;
  /** Code point index. */
  start: number;
}

/** Whole-word occurrences of each term in `cps`, compared folded. */
function occurrences(cps: string[], terms: string[]): Occurrence[] {
  let folded = "";
  /** Code point index of each UTF-16 unit of `folded`. */
  const origin: number[] = [];
  cps.forEach((cp, i) => {
    const f = fold(cp);
    folded += f;
    for (let k = 0; k < f.length; k++) origin.push(i);
  });
  const found: Occurrence[] = [];
  terms.forEach((term, t) => {
    const needle = fold(term.normalize("NFC"));
    if (!needle) return;
    for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + 1)) {
      const before = at > 0 ? (origin[at - 1] as number) : -1;
      const after = origin[at + needle.length];
      const start = origin[at] as number;
      // A code point can fold to several units (a Hangul syllable to its jamo): never match from
      // inside one, i.e. where the unit before belongs to the same code point.
      const insideCodePoint = before === start;
      const boundedBefore = !insideCodePoint && (before === -1 || !WORD.test(cps[before] ?? ""));
      const boundedAfter = after === undefined || !WORD.test(cps[after] ?? "");
      if (boundedBefore && boundedAfter) found.push({ term: t, start });
    }
  });
  return found.sort((a, b) => a.start - b.start);
}

/** How many distinct `terms` occur in `text` as whole words, compared like the index. */
export function termsIn(text: string, terms: string[]): number {
  return new Set(occurrences(Array.from(text), terms).map((o) => o.term)).size;
}

const units = (cps: string[], from: number, to: number) => {
  let n = 0;
  for (let i = from; i < to; i++) n += (cps[i] as string).length;
  return n;
};

function endFor(cps: string[], start: number, max: number): number {
  let end = start;
  let n = 0;
  while (end < cps.length && n + (cps[end] as string).length <= max)
    n += (cps[end++] as string).length;
  return end;
}

const isBreak = (cps: string[], i: number) => cps[i] === "\n";
const endsSentence = (cps: string[], i: number) =>
  /[.!?]/.test(cps[i] ?? "") && /\s/.test(cps[i + 1] ?? "");

/** A start in [from, limit] just after a line break or sentence end, else after a space. */
function trimStart(cps: string[], from: number, limit: number): number {
  for (let i = from; i < limit; i++) {
    if (isBreak(cps, i) || endsSentence(cps, i)) return skipSpace(cps, i + 1, limit);
  }
  for (let i = from; i < limit; i++)
    if (/\s/.test(cps[i] as string)) return skipSpace(cps, i, limit);
  return skipSpace(cps, from, limit);
}

function skipSpace(cps: string[], i: number, limit: number): number {
  let j = i;
  while (j < limit && /\s/.test(cps[j] as string)) j++;
  // Never start on a combining mark: it belongs to the letter before.
  while (j < limit && MARK.test(cps[j] as string)) j++;
  return j;
}

/** An end in [limit, to] just after a sentence end or before a line break, else at a space. */
function trimEnd(cps: string[], limit: number, to: number): number {
  for (let i = to - 1; i >= limit; i--) {
    if (isBreak(cps, i)) return i;
    if (endsSentence(cps, i)) return i + 1;
  }
  for (let i = to - 1; i >= limit; i--) if (/\s/.test(cps[i] as string)) return i;
  let end = to;
  // Never end between a letter and its combining marks.
  while (end > limit && MARK.test(cps[end] ?? "")) end--;
  return end;
}

/**
 * The ≤ `maxChars` passage (plus "…" at cuts) with the most distinct `terms`, then the most
 * occurrences, cut at sentence or line boundaries where possible. Without terms, the start.
 */
export function bestPassage(text: string, terms: string[], maxChars: number): string {
  const cps = Array.from(text.trim());
  if (units(cps, 0, cps.length) <= maxChars) return cps.join("");
  const found = occurrences(cps, terms);
  const lead = Math.floor(maxChars / 4);
  let best = { start: 0, end: endFor(cps, 0, maxChars), anchor: 0, distinct: 0, count: 0 };
  for (const o of found) {
    let start = o.start;
    while (start > 0 && units(cps, start - 1, o.start) <= lead) start--;
    const end = endFor(cps, start, maxChars);
    const inside = found.filter((x) => x.start >= start && x.start < end);
    const distinct = new Set(inside.map((x) => x.term)).size;
    if (distinct > best.distinct || (distinct === best.distinct && inside.length > best.count)) {
      best = { start, end, anchor: o.start, distinct, count: inside.length };
    }
  }
  const start = best.start > 0 ? trimStart(cps, best.start, best.anchor) : 0;
  const end =
    best.end < cps.length ? trimEnd(cps, Math.max(start + 1, best.anchor + 1), best.end) : best.end;
  const body = cps.slice(start, end).join("").trim();
  return `${start > 0 ? "…" : ""}${body}${end < cps.length ? "…" : ""}`;
}

/** `text` on one line, cut at a word boundary to `maxChars`. */
export function oneLine(text: string, maxChars: number): string {
  const cps = Array.from(text.replace(/\s+/g, " ").trim());
  if (cps.length <= maxChars) return cps.join("");
  let end = maxChars - 1;
  while (end > 0 && cps[end] !== " ") end--;
  if (end === 0) end = maxChars - 1;
  while (end > 0 && MARK.test(cps[end] ?? "")) end--;
  return `${cps.slice(0, end).join("").trimEnd()}…`;
}
