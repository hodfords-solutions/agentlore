import { CORRECTION_WORDS, DECISION_WORDS } from "./languages/index.js";
import { termsIn } from "./passage.js";
import { WORD_CHAR } from "./text.js";

/** Who said the part of a transcript chunk that matched, and the file an agent's turn cites. */
export interface Provenance {
  /** "agent" is a prompt another agent wrote (a parent agent's task for a subagent). */
  speaker: "user" | "assistant" | "agent";
  /** The first file path (with `:line` when given) the matching sentences of an assistant turn cite. */
  cites?: string;
  /** Some matching sentences of that turn cite no file: the agent's own conclusions sit beside it. */
  uncited?: boolean;
  /** A user turn that decides something ("we'll go with…"). */
  decided?: boolean;
}

/**
 * Whether a text holds one of `phrases` as whole words, ignoring case but not diacritics
 * ("résumé" is not "resume").
 */
function phraseMatcher(phrases: readonly string[]): (text: string) => boolean {
  const escaped = phrases.map((p) =>
    p
      .normalize("NFC")
      .replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")
      .replace(/ /g, "\\s+"),
  );
  const pattern = new RegExp(`(?<!${WORD_CHAR})(?:${escaped.join("|")})(?!${WORD_CHAR})`, "iu");
  return (text) => pattern.test(text.normalize("NFC"));
}

/** Words a user decides or corrects with: the language packs', plus any of the user's own. */
export interface ExtraWords {
  decisionWords?: readonly string[];
  correctionWords?: readonly string[];
}

/** Tests for decisions and corrections (see `phrases`). */
export interface Phrases {
  decides(text: string): boolean;
  corrects(text: string): boolean;
}

/** The language packs' decision and correction words, with `extra` ones added. */
export function phrases(extra: ExtraWords = {}): Phrases {
  return {
    decides: phraseMatcher([...DECISION_WORDS, ...(extra.decisionWords ?? [])]),
    corrects: phraseMatcher([...CORRECTION_WORDS, ...(extra.correctionWords ?? [])]),
  };
}

export const DEFAULT_PHRASES: Phrases = phrases();

/** Turns as `chunkRecords` writes them: "role: text", separated by a blank line. */
const TURN = /(?:^|\n\n)(user|assistant|agent): /g;

const FILE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|md|mdx|ya?ml|toml|ini|py|rb|go|rs|java|kt|cs|cshtml|csproj|sln|sql|sh|ps1|php|swift|c|h|cpp|hpp|vue|svelte|html|css|scss|xml|tf|gradle|txt|lock|env|proto|graphql";
/** A path ending in a known file extension, optionally with `:line`. */
const FILE_REFERENCE = new RegExp(
  `(?<![\\w./-])(?:[\\w.-]+/)*[\\w-][\\w.-]*\\.(?:${FILE_EXTENSIONS})(?::\\d+)?(?![\\w/])`,
);

/** Lines, and sentences within them: a citation only supports the sentence it is in. */
const SENTENCE_END = /\n|(?<=[.!?。])\s+|\s+(?:→|=>)\s+/;

interface Turn {
  speaker: Provenance["speaker"];
  text: string;
}

function turns(text: string): Turn[] {
  const found: Turn[] = [];
  const starts = [...text.matchAll(TURN)];
  starts.forEach((match, i) => {
    const from = (match.index ?? 0) + match[0].length;
    const to = starts[i + 1]?.index ?? text.length;
    found.push({ speaker: match[1] as Turn["speaker"], text: text.slice(from, to) });
  });
  return found;
}

/**
 * Who said the turn of a transcript chunk holding most of `terms` (the earliest on a tie). For an
 * assistant turn, the file its matching sentences cite, and whether some of them cite none;
 * undefined for text without turns (notes, code). With `speaker`, only that speaker's turns
 * holding a term count, and undefined means there is none.
 */
export function provenance(
  text: string,
  terms: string[],
  speaker?: Provenance["speaker"],
  words: Phrases = DEFAULT_PHRASES,
): Provenance | undefined {
  let best: Turn | undefined;
  let bestCount = speaker ? 0 : -1;
  for (const turn of turns(text)) {
    if (speaker && turn.speaker !== speaker) continue;
    const count = termsIn(turn.text, terms);
    if (count > bestCount) {
      best = turn;
      bestCount = count;
    }
  }
  if (!best) return undefined;
  if (best.speaker === "user")
    return words.decides(best.text) ? { speaker: "user", decided: true } : { speaker: "user" };
  if (best.speaker !== "assistant") return { speaker: best.speaker };
  const matching = best.text.split(SENTENCE_END).filter((sentence) => termsIn(sentence, terms) > 0);
  const cited = matching.map((sentence) => sentence.match(FILE_REFERENCE)?.[0]);
  const cites = cited.find((file) => file !== undefined);
  if (!cites) return { speaker: "assistant" };
  return cited.includes(undefined)
    ? { speaker: "assistant", cites, uncited: true }
    : { speaker: "assistant", cites };
}

/**
 * The passages of a chunk's text that correct an earlier claim about the query: a sentence with a
 * correction word and `terms` (two of them when there are more), with the sentence before it,
 * which often states the claim being corrected.
 */
export function corrections(
  text: string,
  terms: string[],
  words: Phrases = DEFAULT_PHRASES,
): string[] {
  if (!words.corrects(text)) return [];
  const needed = Math.min(2, terms.length);
  const sentences = text.split(SENTENCE_END);
  return sentences.flatMap((sentence, i) =>
    words.corrects(sentence) && termsIn(`${sentences[i - 1] ?? ""} ${sentence}`, terms) >= needed
      ? [`${sentences[i - 1] ?? ""} ${sentence}`]
      : [],
  );
}

/** A short label: the user's words and cited files are evidence, an agent's conclusion is not. */
export function provenanceLabel({ speaker, cites, uncited, decided }: Provenance): string {
  if (speaker === "user") return decided ? "user decided" : "user said";
  if (speaker === "agent") return "agent task";
  if (!cites) return "agent claim, unverified";
  return uncited ? `agent cites ${cites} + unverified claims` : `agent cites ${cites}`;
}
