import { checkCitation } from "./citations.js";
import { labelField, NO_HITS } from "./format.js";
import { STOPWORDS } from "./languages/index.js";
import { normalizeProject } from "./project.js";
import {
  corrections,
  DEFAULT_PHRASES,
  type Phrases,
  type Provenance,
  provenance,
} from "./provenance.js";
import type { Candidate, SemanticCandidate, Store } from "./store.js";
import { foldDiacritics, WORD_CHAR } from "./text.js";
import type { SearchHit } from "./types.js";

/** Results returned when the caller does not ask for a number. */
export const DEFAULT_LIMIT = 5;
/** Candidates fetched per wanted result, so that per-session diversity can still fill `limit`. */
const OVERFETCH = 4;
/** bm25 matches fetched per query; other ranking signals are computed only for these. */
export const CANDIDATES = 200;
/** Multiplies a subagent chunk's (negative) bm25, ranking it below main-session chunks. */
const SIDECHAIN_WEIGHT = 0.6;
/**
 * Multiplies a transcript chunk's bm25 by who said its matched part: the user's words and an
 * agent citing a file are evidence; an agent's own conclusion may be a wrong guess, and a task
 * one agent gave another only restates what was asked.
 */
const PROVENANCE_WEIGHT = { user: 1, cited: 1, claim: 0.8, agent: 0.5 } as const;
/**
 * Multiplies the bm25 of a session written to in the last LIVE_MS: usually the asking session or
 * a sibling working on the same task, whose turns echo the query rather than answer it.
 */
const LIVE_WEIGHT = 0.5;
export const LIVE_MS = 30 * 60 * 1000;
const provenanceWeight = (said: Provenance | undefined) =>
  !said
    ? 1
    : said.speaker === "assistant"
      ? PROVENANCE_WEIGHT[said.cites && !said.uncited ? "cited" : "claim"]
      : PROVENANCE_WEIGHT[said.speaker];
/**
 * Multiplies the bm25 of a project memory note (docs/adr/0004): what sessions consolidated about a
 * project ranks above the conversations it came from.
 */
const NOTE_WEIGHT = 1.5;
/** Multiplies the bm25 of a hit a later hit seems to correct (see `correctsClaim`). */
const CORRECTED_WEIGHT = 0.6;
/** Hits this similar to a better one (Jaccard of word 3-grams) are left out as duplicates. */
const DUPLICATE_SIMILARITY = 0.7;
/** Results kept per session, so one long session does not crowd out the others. */
const MAX_PER_SESSION = 2;
/** Max terms per query; words over MAX_TERM_LENGTH are dropped (no real word is that long). */
export const MAX_TERMS = 16;
const MAX_TERM_LENGTH = 64;

export interface SearchOptions {
  limit?: number;
  /** Terms (words or adjacent-word phrases, see `promptTerms`) to use instead of the query's. */
  terms?: string[];
  /** Only results from this project (a session's working directory; see `normalizeProject`). */
  project?: string;
  /** Only chunks containing every term: no partial matches to fill the remaining places. */
  strict?: boolean;
  /** Leave out the chunks of this session. */
  excludeSessionId?: string;
  /** Leave out the chunks of this project and its subfolders (see `normalizeProject`). */
  excludeProject?: string;
  /** Drop matches below this share (0-1) of the best bm25: a floor independent of index size. */
  relativeScore?: number;
  /** Only chunks starting at or after this ISO 8601 time (see `dateBound`), the date shown. */
  since?: string;
  /** Only chunks starting before this ISO 8601 time (see `dateBound`). */
  until?: string;
  /** Only transcript chunks where the user's own words hold a term ("user"), and decide ("decision"). */
  said?: "user" | "decision";
  /** The current time in ms, for telling live sessions; defaults to `Date.now()`. */
  now?: number;
  /** Decision and correction words; the language packs' by default (see `phrases`). */
  phrases?: Phrases;
  /**
   * The query's embedding: semantic matches are fused with the keyword ones (reciprocal rank
   * fusion), so a chunk that says the same thing in other words can be found too.
   */
  vector?: Float32Array;
}

/** Semantic matches fetched per search, before filters on who said them. */
const SEMANTIC_CANDIDATES = 50;
/** Reciprocal rank fusion's constant (equal for both lists, so they interleave). */
const RRF_K = 60;
/** Characters of a semantic match's text shown when no query word occurs in it. */
const HEAD_CHARS = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An ISO 8601 bound for `since` or `until` from a date (YYYY-MM-DD, a UTC day, inclusive: `until`
 * becomes the next day's start) or a full timestamp; undefined when it is neither.
 */
export function dateBound(value: string, side: "since" | "until"): string | undefined {
  const text = value.trim();
  const day = DATE.test(text);
  const ms = Date.parse(day ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(ms) || (!day && !/^\d{4}-\d{2}-\d{2}T/.test(text))) return undefined;
  // Date.parse rolls an impossible day over ("02-30" is March 2).
  if (day && new Date(ms).toISOString().slice(0, 10) !== text) return undefined;
  return new Date(day && side === "until" ? ms + DAY_MS : ms).toISOString();
}

/** Accented words are compared exactly: words differing from a stopword only by marks are kept. */
const ACCENTED_STOPWORDS = new Set(STOPWORDS);
/** For words typed without diacritics, which may stand for any accented form. */
const UNACCENTED_STOPWORDS = new Set(STOPWORDS.map(foldDiacritics));

const isStopword = (word: string) => {
  const plain = foldDiacritics(word);
  return plain === word ? UNACCENTED_STOPWORDS.has(word) : ACCENTED_STOPWORDS.has(word);
};

const WORDS = new RegExp(`${WORD_CHAR}+`, "gu");

/** The words of a free-text query, lowercase, in order, repeats included. */
export const queryWords = (query: string): string[] =>
  query.normalize("NFC").toLowerCase().match(WORDS) ?? [];

/** Whether a query word is never a search term: a stopword, or too short or long to be one. */
export const isIgnoredWord = (word: string): boolean =>
  word.length < 2 || word.length > MAX_TERM_LENGTH || isStopword(word);

/** Whether a term has diacritics: the index folds them, so it may match other words too. */
export const isAccented = (term: string): boolean => foldDiacritics(term) !== term;

/** Unique, lowercase search terms of a free-text query, without stopwords, capped. */
export function toFtsTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of queryWords(query)) {
    if (terms.size >= MAX_TERMS) break;
    if (!isIgnoredWord(word)) terms.add(word);
  }
  return [...terms];
}

/** An FTS5 MATCH expression with every term quoted, so query text is never FTS syntax. */
export function matchExpression(terms: string[], operator: "AND" | "OR"): string {
  return terms.map((term) => `"${term}"`).join(` ${operator} `);
}

/** Counts how many of `terms` occur in a text as whole words (or phrases), ignoring case. */
function exactTermCounter(terms: string[]): (text: string) => number {
  const patterns = terms.map(
    (term) =>
      new RegExp(
        `(?<!${WORD_CHAR})${term
          .replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")
          .replace(/ /g, "\\s+")}(?!${WORD_CHAR})`,
        "iu",
      ),
  );
  return (text) => {
    const normalized = text.normalize("NFC");
    return patterns.filter((pattern) => pattern.test(normalized)).length;
  };
}

/**
 * Counts how many accented `terms` occur in a text spelled exactly or without any diacritics: the
 * index folds them, so "côte" also matches "côté", a different word, but "cote" may be either.
 */
function compatibleTermCounter(terms: string[]): (text: string) => number {
  const exact = terms.map((term) => exactTermCounter([term]));
  const plain = terms.map((term) => exactTermCounter([foldDiacritics(term)]));
  return (text) => terms.filter((_, i) => exact[i]?.(text) || plain[i]?.(text)).length;
}

interface Ranked extends Candidate {
  /** bm25 weighted by subagent, live session and provenance: lower is better. */
  score: number;
  said?: Provenance;
  correctedBy?: string;
}

/** Candidates whose provenance is read at a time, best first, until the rest cannot rank. */
const WEIGH_BATCH = 20;

interface RankContext {
  store: Store;
  terms: string[];
  accented: string[];
  /** Chunk texts read so far in this search. */
  texts: Map<number, string>;
  /** Sessions written to in the last LIVE_MS. */
  live: Set<string>;
  said?: SearchOptions["said"];
  phrases: Phrases;
}

/**
 * The best `keep` candidates: by count of accented terms spelled exactly (the index folds
 * diacritics), then bm25 weighted by subagent, live session and provenance. Candidates matching
 * an accented term only in another accented form are left out: with `all`, when one such term is
 * missing; else when they hold no term at all. Notes start ahead (NOTE_WEIGHT, known without
 * their text); the other weights only lower a score, so chunk texts are read best first and only
 * until no unread candidate could still rank.
 */
function rank(
  { store, terms, accented, texts, live, said: only, phrases: words }: RankContext,
  candidates: Candidate[],
  keep: number,
  all: boolean,
): Ranked[] {
  const read = (rowids: number[]) => {
    const missing = rowids.filter((rowid) => !texts.has(rowid));
    for (const [rowid, text] of store.chunkTexts(missing)) texts.set(rowid, text);
  };
  const exact = new Map<number, number>();
  if (accented.length) {
    read(candidates.map((c) => c.rowid));
    const count = exactTermCounter(accented);
    const compatible = compatibleTermCounter(accented);
    const plain = exactTermCounter(terms.filter((term) => !isAccented(term)));
    candidates = candidates.filter((c) => {
      const text = texts.get(c.rowid) ?? "";
      const found = compatible(text);
      return all
        ? found === accented.length
        : found > 0 || plain(foldDiacritics(text.normalize("NFC"))) > 0;
    });
    for (const c of candidates) exact.set(c.rowid, count(texts.get(c.rowid) ?? ""));
  }
  const compare = (a: Ranked, b: Ranked) =>
    (exact.get(b.rowid) ?? 0) - (exact.get(a.rowid) ?? 0) || a.score - b.score;
  // Stable: equal candidates keep the store's bm25 order.
  const order = candidates
    .map((c) => ({ ...c, score: c.bm25 * (c.kind === "note" ? NOTE_WEIGHT : 1) }))
    .sort(compare);
  const ranked: Ranked[] = [];
  for (let at = 0; at < order.length; at += WEIGH_BATCH) {
    const batch = order.slice(at, at + WEIGH_BATCH);
    read(batch.map((c) => c.rowid));
    for (const c of batch) {
      const said =
        c.kind === "transcript"
          ? provenance(texts.get(c.rowid) ?? "", terms, only && "user", words)
          : undefined;
      if (only && !said) continue;
      if (only === "decision" && !said?.decided) continue;
      const weight =
        (c.sidechain ? SIDECHAIN_WEIGHT : 1) *
        (live.has(c.sessionId) ? LIVE_WEIGHT : 1) *
        provenanceWeight(said);
      ranked.push({ ...c, score: c.score * weight, ...(said ? { said } : {}) });
    }
    const next = order[at + WEIGH_BATCH];
    if (!next || ranked.filter((r) => compare(r, next) <= 0).length >= keep) break;
  }
  markCorrected(ranked, terms, texts, words);
  return ranked.sort(compare).slice(0, keep);
}

/** Distinctive words a correction must share with the chunk it corrects, besides the query's. */
const MIN_SHARED_WORDS = 3;
/** A shared word counts only if at most this share of the candidates hold it. */
const MAX_WORD_SHARE = 0.25;
/** A chunk that would correct more hits than this is a summary of them, not a correction. */
const MAX_CORRECTED = 2;
const CONTENT_WORD = new RegExp(`${WORD_CHAR}{3,}`, "gu");

/** Lowercase, unaccented words of 3+ letters that are not stopwords or in `except`. */
function contentWords(text: string, except: Set<string>): Set<string> {
  const words = foldDiacritics(text.normalize("NFC").toLowerCase()).match(CONTENT_WORD) ?? [];
  return new Set(words.filter((w) => !except.has(w) && !UNACCENTED_STOPWORDS.has(w)));
}

/**
 * Demote and link a candidate when a later transcript chunk among them corrects a claim about the
 * query, in words few other candidates use (a heuristic, so the label asks).
 */
function markCorrected(
  ranked: Ranked[],
  terms: string[],
  texts: Map<number, string>,
  phraseSet: Phrases,
): void {
  const except = new Set(terms.flatMap((t) => foldDiacritics(t).split(" ")));
  const correctors = ranked.flatMap((r) => {
    if (r.kind !== "transcript") return [];
    const found = corrections(texts.get(r.rowid) ?? "", terms, phraseSet);
    return found.length ? [{ r, words: contentWords(found.join(" "), except) }] : [];
  });
  if (!correctors.length) return;
  const own = new Map(ranked.map((r) => [r.rowid, contentWords(texts.get(r.rowid) ?? "", except)]));
  const holders = new Map<string, number>();
  for (const words of own.values())
    for (const w of words) holders.set(w, (holders.get(w) ?? 0) + 1);
  // The corrector and its target both hold a shared word: count only the other holders.
  const maxHolders = 2 + MAX_WORD_SHARE * ranked.length;
  const corrects = (c: Ranked, words: Set<string>, r: Ranked) => {
    if (c.rowid === r.rowid || c.startedAt <= r.endedAt) return false;
    const theirs = own.get(r.rowid) ?? new Set<string>();
    let shared = 0;
    for (const w of words) {
      if (theirs.has(w) && (holders.get(w) ?? 0) <= maxHolders && ++shared >= MIN_SHARED_WORDS) {
        return true;
      }
    }
    return false;
  };
  for (const { r: c, words } of correctors) {
    const targets = ranked.filter((r) => corrects(c, words, r));
    if (!targets.length || targets.length > MAX_CORRECTED) continue;
    for (const r of targets) {
      if (r.correctedBy) continue;
      r.correctedBy = c.chunkId;
      r.score *= CORRECTED_WEIGHT;
    }
  }
}

/** Search hits for ranked candidates, with snippets for `fts`; vanished chunks are left out. */
function withSnippets(store: Store, fts: string, ranked: Ranked[]): SearchHit[] {
  const snippets = store.snippets(fts, ranked);
  return ranked.flatMap(({ rowid, bm25: _bm25, sidechain: _sidechain, ...hit }) => {
    const snippet = snippets.get(rowid);
    return snippet === undefined ? [] : [{ ...hit, snippet }];
  });
}

const snippetKey = (snippet: string) =>
  snippet
    .replace(/[[\]…]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const WORDS_ANY = new RegExp(`${WORD_CHAR}+`, "gu");
/** Fewer shingles than this and a text is too short to call a duplicate. */
const MIN_SHINGLES = 20;

/** The text's runs of 3 consecutive words: shared runs, not shared vocabulary, make a copy. */
function shingles(text: string): Set<string> {
  const words = text.toLowerCase().match(WORDS_ANY) ?? [];
  const found = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) found.add(words.slice(i, i + 3).join(" "));
  return found;
}

/** Jaccard similarity of two shingle sets; 0 when either text is short. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size < MIN_SHINGLES || b.size < MIN_SHINGLES) return 0;
  let shared = 0;
  for (const shingle of a) if (b.has(shingle)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Keep order, at most MAX_PER_SESSION per session and `limit` in all; skip duplicate snippets and
 * chunks whose text (from `textOf`) mostly repeats a kept one, e.g. a prompt pasted into a
 * subagent or a second session.
 */
function diversify(
  candidates: SearchHit[],
  limit: number,
  textOf: (chunkId: string) => string | undefined,
): SearchHit[] {
  const perSession = new Map<string, number>();
  const snippets = new Set<string>();
  const words: Set<string>[] = [];
  const kept: SearchHit[] = [];
  for (const hit of candidates) {
    if (kept.length >= limit) break;
    const key = snippetKey(hit.snippet);
    if (snippets.has(key)) continue;
    const own = shingles(textOf(hit.chunkId) ?? hit.snippet);
    if (words.some((other) => similarity(own, other) >= DUPLICATE_SIMILARITY)) continue;
    const count = perSession.get(hit.sessionId) ?? 0;
    if (count >= MAX_PER_SESSION) continue;
    perSession.set(hit.sessionId, count + 1);
    snippets.add(key);
    words.push(own);
    kept.push(hit);
  }
  return kept;
}

/**
 * Search the index for free text: chunks with every term first, then partial matches fill the
 * rest. Ranking happens here rather than in the store's SQL so other signals can be fused later.
 */
export function search(store: Store, query: string, options: SearchOptions = {}): SearchHit[] {
  const terms = options.terms ?? toFtsTerms(query);
  if (!terms.length) return [];
  const limit = options.limit ?? DEFAULT_LIMIT;
  const project = normalizeProject(options.project);
  const wanted = limit * OVERFETCH;
  const accented = terms.filter(isAccented);
  const texts = new Map<number, string>();
  const { excludeSessionId, relativeScore, since, until, said } = options;
  const excludeProject = normalizeProject(options.excludeProject);
  const live = store.recentSessions(new Date((options.now ?? Date.now()) - LIVE_MS).toISOString());
  const words = options.phrases ?? DEFAULT_PHRASES;
  const context: RankContext = { store, terms, accented, texts, live, said, phrases: words };
  const candidates = (fts: string, keep: number) => {
    const found = store.searchCandidates({
      fts,
      limit: Math.max(CANDIDATES, keep),
      project,
      excludeSessionId,
      excludeProject,
      since,
      until,
    });
    if (relativeScore === undefined || !found.length) return found;
    const best = Math.min(...found.map((c) => c.bm25));
    return found.filter((c) => c.bm25 <= relativeScore * best);
  };
  const rowids = new Map<string, number>();
  const ranked = (fts: string, keep: number, all: boolean) => {
    const kept = rank(context, candidates(fts, keep), keep, all);
    for (const r of kept) rowids.set(r.chunkId, r.rowid);
    return kept;
  };
  const textOf = (chunkId: string) => {
    const rowid = rowids.get(chunkId);
    return rowid === undefined ? undefined : texts.get(rowid);
  };

  // Phase 1 ranks candidates without snippets; phase 2 makes snippets for the few kept.
  const strictFts = matchExpression(terms, "AND");
  const looseFts = matchExpression(terms, "OR");
  const strict = withSnippets(store, strictFts, ranked(strictFts, wanted, true));
  let pool = strict;
  if (diversify(strict, limit, textOf).length < limit && terms.length >= 2 && !options.strict) {
    // The OR results also contain the AND ones; keep enough to get `wanted` new candidates.
    const seen = new Set(strict.map((hit) => hit.chunkId));
    const loose = ranked(looseFts, wanted + strict.length, false).filter(
      (c) => !seen.has(c.chunkId),
    );
    pool = [...strict, ...withSnippets(store, looseFts, loose)];
  }
  if (options.vector) {
    const semantic = store.semanticCandidates(options.vector, {
      limit: SEMANTIC_CANDIDATES,
      project,
      excludeSessionId,
      excludeProject,
      since,
      until,
    });
    const extra = semanticHits(store, semantic, pool, {
      looseFts,
      terms,
      said,
      texts,
      rowids,
      words,
    });
    pool = fuse(pool, extra);
  }
  return withCitations(diversify(pool, limit, textOf));
}

interface SemanticContext {
  looseFts: string;
  terms: string[];
  said: SearchOptions["said"];
  texts: Map<number, string>;
  rowids: Map<string, number>;
  words: Phrases;
}

/** Hits for semantic matches not already in `pool`, ordered by similarity. */
function semanticHits(
  store: Store,
  semantic: SemanticCandidate[],
  pool: SearchHit[],
  { looseFts, terms, said: only, texts, rowids, words }: SemanticContext,
): SearchHit[] {
  const inPool = new Set(pool.map((hit) => hit.chunkId));
  const fresh = semantic.filter((c) => !inPool.has(c.chunkId));
  const missing = fresh.map((c) => c.rowid).filter((rowid) => !texts.has(rowid));
  for (const [rowid, text] of store.chunkTexts(missing)) texts.set(rowid, text);
  const snippets = store.snippets(looseFts, fresh);
  return fresh.flatMap(({ rowid, bm25: _bm25, sidechain: _sidechain, similarity, ...c }) => {
    const text = texts.get(rowid);
    if (text === undefined) return [];
    const said =
      c.kind === "transcript" ? provenance(text, terms, only && "user", words) : undefined;
    if (only && (!said || (only === "decision" && !said.decided))) return [];
    rowids.set(c.chunkId, rowid);
    const head = text.length > HEAD_CHARS ? `${text.slice(0, HEAD_CHARS)}…` : text;
    return [
      {
        ...c,
        score: -similarity,
        snippet: snippets.get(rowid) ?? head,
        semantic: true,
        ...(said ? { said } : {}),
      },
    ];
  });
}

/**
 * Keyword hits in their own order (which weighs who said them), with semantic-only hits
 * interleaved by rank: reciprocal rank fusion where each hit counts in the list that found it.
 */
function fuse(keyword: SearchHit[], extra: SearchHit[]): SearchHit[] {
  const scores = new Map<string, number>();
  keyword.forEach((hit, i) => {
    scores.set(hit.chunkId, 1 / (RRF_K + i + 1));
  });
  extra.forEach((hit, i) => {
    scores.set(hit.chunkId, 1 / (RRF_K + i + 1));
  });
  // Stable: on a tie, the keyword hit goes first.
  return [...keyword, ...extra].sort(
    (a, b) => (scores.get(b.chunkId) ?? 0) - (scores.get(a.chunkId) ?? 0),
  );
}

/** Hits whose cited file is gone or changed since say so (only the few returned are checked). */
function withCitations(hits: SearchHit[]): SearchHit[] {
  return hits.map((hit) => {
    const cites = hit.said?.cites;
    const citation = cites && checkCitation(cites, hit.project, hit.endedAt);
    return citation ? { ...hit, citation } : hit;
  });
}

/** The no-results message; with a project filter, also how many matches exist in other projects. */
export function noHitsMessage(store: Store, query: string, project?: string): string {
  const filter = normalizeProject(project);
  const terms = toFtsTerms(query);
  if (!filter || !terms.length) return NO_HITS;
  const elsewhere = store.countMatches(matchExpression(terms, "OR"));
  if (!elsewhere) return NO_HITS;
  return `No results in project ${labelField(filter)}; ${elsewhere} result${elsewhere === 1 ? "" : "s"} elsewhere — omit project to see them.`;
}
