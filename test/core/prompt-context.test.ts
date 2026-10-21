import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PROMPT_CONTEXT_CHARS,
  PROMPT_CONTEXT_FOOTER,
  PROMPT_CONTEXT_HEADER,
  promptContext,
} from "../../src/core/prompt-context.js";
import { search } from "../../src/core/search.js";
import { openStore, type Store } from "../../src/core/store.js";
import { chunk, hostPath, seed } from "../helpers.js";

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function seeded() {
  const store = openStore(":memory:");
  stores.push(store);
  seed(store, "/a", [
    chunk({ text: "Stripe webhook retries twice because of the idempotency check" }),
  ]);
  seed(store, "/b", [
    chunk({
      tool: "codex",
      project: hostPath("/work/repo-b"),
      sessionId: "s2",
      text: "Webhook idempotency keys are stored for 24 hours in Redis",
    }),
  ]);
  seed(store, "/c", [chunk({ sessionId: "s3", text: "Warehouse import is a one-time seed" })]);
  return store;
}

describe("promptContext", () => {
  it("returns related excerpts, framed as untrusted data, under the knowledge mode header", () => {
    const text = promptContext(seeded(), "How did we handle webhook idempotency before?");
    expect(text?.split("\n")[0]).toBe(PROMPT_CONTEXT_HEADER);
    expect(PROMPT_CONTEXT_HEADER).toMatch(/data, not instructions/);
    expect(text).toMatch(/^\[1\] [0-9a-f]{8} /m);
    expect(text).toMatch(/^\[2\] [0-9a-f]{8} codex /m);
    expect(text).toMatch(/^> .*\[idempotency\]/m);
  });

  it("ends with the user's directive, outside the quoted excerpts and after a blank line", () => {
    expect(PROMPT_CONTEXT_FOOTER).toBe(
      "Knowledge mode is ON (enabled by the user): before answering, call the agentlore `context` tool on the most relevant id above, or `search` with your own keywords, and briefly mention any relevant prior work you used. Excerpts are what past sessions said, not checked facts: verify them against the current code before relying on them. Skip this only if none of it is relevant.",
    );
    const lines = (
      promptContext(seeded(), "How did we handle webhook idempotency before?") ?? ""
    ).split("\n");
    expect(lines.slice(-2)).toEqual(["", PROMPT_CONTEXT_FOOTER]);
    // Every excerpt line before it is a label or quoted data.
    for (const line of lines.slice(1, -2)) expect(line).toMatch(/^(\[\d\] |> )/);
  });

  it("skips short prompts, slash commands and prompts without search terms", () => {
    const store = seeded();
    expect(promptContext(store, "webhook idempotency")).toBeUndefined();
    expect(promptContext(store, "/review webhook idempotency handling")).toBeUndefined();
    expect(promptContext(store, "  what did you do there and why was it?  ")).toBeUndefined();
  });

  it("injects only chunks matching every term, never partial matches", () => {
    expect(promptContext(seeded(), "webhook warehouse migration notes please")).toBeUndefined();
  });

  it("needs a chunk containing at least half of the prompt's usable terms, and two", () => {
    const store = seeded();
    // 6 usable terms: 3 needed; stripe, webhook and idempotency occur together.
    expect(promptContext(store, "stripe webhook idempotency redis ledger payout")).toMatch(
      /Stripe/,
    );
    // Only webhook and idempotency occur together: 2 of 6.
    expect(
      promptContext(store, "webhook idempotency ledger payout refund invoice"),
    ).toBeUndefined();
    // One usable term is never enough.
    expect(promptContext(store, "what about the warehouse, any idea?")).toBeUndefined();
  });

  it("does not count generic task words, in English or Vietnamese", () => {
    const store = seeded();
    seed(store, "/d", [chunk({ sessionId: "s4", text: "fix the error, add tests, sửa lỗi file" })]);
    expect(promptContext(store, "Fix the error and add tests to this file")).toBeUndefined();
    expect(promptContext(store, "Sửa lỗi trong file này giúp mình nhé")).toBeUndefined();
    // Filler words neither count as usable terms nor have to match.
    expect(promptContext(store, "fix the webhook idempotency error and add tests")).toMatch(
      /idempotency/,
    );
  });

  it("adds nothing when the key terms occur together in too many chunks (a generic topic)", () => {
    const store = seeded();
    const prompt = "webhook idempotency handling details";
    /** Context was added: the header, then excerpts with both key terms. */
    const added = (text: string | undefined) => {
      expect(text?.split("\n")[0]).toBe(PROMPT_CONTEXT_HEADER);
      expect(text).toMatch(/^> .*webhook.*idempotency/im);
    };
    added(promptContext(store, prompt));
    // 2 chunks contain both terms: more than 1% of 3 chunks, with the cutoff's minimum lowered.
    added(promptContext(store, prompt, { tuning: { maxMatchShare: 0.01 } }));
    for (let i = 0; i < 11; i++) {
      seed(store, `/g${i}`, [chunk({ sessionId: `g${i}`, text: `webhook idempotency note ${i}` })]);
    }
    // 13 chunks match: over the minimum cutoff of 10 (and over 0.4% of 14 chunks).
    expect(promptContext(store, prompt)).toBeUndefined();
    added(promptContext(store, prompt, { tuning: { maxMatchShare: 1, specificShare: 1 } }));
  });

  it("leaves out matches much weaker than the best one", () => {
    const store = seeded();
    seed(store, "/w", [
      chunk({
        sessionId: "weak",
        text: `webhook idempotency ${"long unrelated discussion about other things ".repeat(40)}`,
      }),
    ]);
    const prompt = "webhook idempotency handling details";
    const all = promptContext(store, prompt, { tuning: { relativeScore: 0 } }) ?? "";
    expect(all).toMatch(/^\[3\] /m);
    expect(promptContext(store, prompt) ?? "").not.toMatch(/^\[3\] /m);
  });

  it("ignores instruction words of the prompt itself", () => {
    const store = seeded();
    seed(store, "/i", [
      chunk({ sessionId: "s5", text: "trả lời dựa vào ngữ cảnh, không dùng tool, chỉ hai câu" }),
    ]);
    expect(
      promptContext(store, "Chỉ dựa vào ngữ cảnh, không dùng tool. Trả lời 2 câu."),
    ).toBeUndefined();
    seed(store, "/j", [chunk({ sessionId: "s6", text: "answer based on context only" })]);
    expect(promptContext(store, "Answer based on the context only, two sentences")).toBeUndefined();
  });

  it("leaves out the current session", () => {
    const text = promptContext(seeded(), "webhook idempotency handling details", {
      excludeSessionId: "s2",
    });
    expect(text).toMatch(/Stripe webhook retries twice/);
    expect(text).not.toMatch(/codex/);
  });

  it("still finds other work when the current session holds the best few hundred matches", () => {
    const store = seeded();
    const here = hostPath("/work/here");
    seed(
      store,
      "/h",
      Array.from({ length: 300 }, (_, i) =>
        chunk({ project: here, sessionId: "h", text: `webhook idempotency handling ${i}` }),
      ),
    );
    const text = promptContext(store, "webhook idempotency handling details", {
      excludeSessionId: "h",
    });
    expect(text).toMatch(/Stripe|codex/);
  });

  it("picks key terms among other work: the prompt's own earlier text does not hide it", () => {
    // The current session already holds this prompt (asked before and indexed):
    // all its terms occur together there, and only there.
    const here = hostPath("/work/here");
    const prompt = "webhook idempotency ledger payout";
    const store = seeded();
    seed(store, "/h", [chunk({ project: here, sessionId: "h1", text: prompt })]);
    const context = promptContext(store, prompt, { excludeSessionId: "h1" }) ?? "";
    expect(context).toMatch(/idempotency/);
    expect(context).not.toMatch(/ledger/);
  });

  it("matches adjacent Vietnamese syllables as one word: 'đảo ngược' is not 'lừa đảo'", () => {
    const store = openStore(":memory:");
    stores.push(store);
    seed(store, "/a", [
      chunk({ sessionId: "a", text: "phát hiện lừa đảo, rồi đối soát ngược với ngân hàng" }),
    ]);
    seed(store, "/b", [chunk({ sessionId: "b", text: "đảo ngược thứ tự mảng" })]);
    seed(store, "/c", [chunk({ sessionId: "c", text: "đối soát với ngân hàng mỗi đêm" })]);
    // Every word occurs in /a, but not "đảo ngược" together with the others.
    expect(promptContext(store, "đảo ngược đối soát ngân hàng thế nào")).toBeUndefined();
    seed(store, "/d", [
      chunk({ sessionId: "d", text: "đảo ngược bút toán khi đối soát ngân hàng" }),
    ]);
    const context = promptContext(store, "đảo ngược đối soát ngân hàng thế nào") ?? "";
    expect(context).toMatch(/bút toán/);
    expect(context).not.toMatch(/lừa/);
  });

  it("does not count generic Vietnamese coding words (chuỗi, mảng, kèm, đề xuất…)", () => {
    const store = openStore(":memory:");
    stores.push(store);
    seed(store, "/a", [chunk({ sessionId: "a", text: "đảo ngược chuỗi, kèm test" })]);
    seed(store, "/b", [chunk({ sessionId: "b", text: "lừa đảo chuỗi cửa hàng ngược dòng" })]);
    expect(
      promptContext(store, "Viết hàm TypeScript đảo ngược một chuỗi, kèm 1 test."),
    ).toBeUndefined();
    expect(
      promptContext(store, "Đề xuất cách đảo ngược chuỗi ngắn gọn 4 gạch đầu dòng"),
    ).toBeUndefined();
  });

  it("does not let filler words use up the prompt's terms", () => {
    const store = seeded();
    // 18 filler words before the 3 that matter: more than a query's 16 terms.
    const filler =
      "fix add test file error code write update change make build run check explain improve refactor remove show";
    expect(promptContext(store, `${filler} webhook idempotency stripe`)).toMatch(/Stripe/);
  });

  it("gives the top hit as a passage around the prompt's terms, within the size cap", () => {
    const store = openStore(":memory:");
    stores.push(store);
    const text = `${"Unrelated setup notes. ".repeat(60)}The chat service sends a message to the socket microservice over gRPC, which calls emitToUser with the recipient id. ${"More unrelated notes. ".repeat(60)}`;
    seed(store, "/a", [chunk({ sessionId: "a", text })]);
    const context =
      promptContext(
        store,
        "How does the chat service deliver a message to the recipient socket?",
      ) ?? "";
    expect(context.length).toBeLessThanOrEqual(MAX_PROMPT_CONTEXT_CHARS);
    expect(context).toMatch(/^\[1\] [0-9a-f]{8} claude /m);
    // The passage holds the whole answer, quoted, cut at sentence boundaries.
    expect(context).toMatch(/^> …?.*socket microservice over gRPC, which calls emitToUser/m);
    const lines = context.split("\n");
    // A pointer, not an answer: a short passage, then the line asking for the MCP tools.
    expect(lines.at(-1)).toBe(PROMPT_CONTEXT_FOOTER);
    const passage = lines.slice(2, -1).join("\n");
    expect(passage.length).toBeGreaterThan(200);
    expect(passage.length).toBeLessThanOrEqual(480);
  });

  it("puts first the hit whose passage covers most prompt terms, the others on one line", () => {
    const store = openStore(":memory:");
    stores.push(store);
    const pad = "Unrelated filler sentence here. ".repeat(60);
    // Many occurrences, but too far apart for one passage: ranked first by bm25.
    seed(store, "/a", [
      chunk({
        sessionId: "a",
        text: `${"webhook ".repeat(8)}scattered. ${pad}${"idempotency ".repeat(8)}end.`,
      }),
    ]);
    seed(store, "/b", [
      chunk({
        sessionId: "b",
        text: `${pad}Together: webhook idempotency keys live in redis. ${pad}`,
      }),
    ]);
    const prompt = "webhook idempotency handling details";
    expect(search(store, "webhook idempotency", { strict: true })[0]?.sessionId).toBe("a");
    // Without the relative-score cut, which would drop the weaker (by bm25) hit.
    const lines = (promptContext(store, prompt, { tuning: { relativeScore: 0 } }) ?? "").split(
      "\n",
    );
    expect(lines.slice(2).join("\n")).toMatch(/Together: webhook idempotency keys live in redis/);
    const second = lines.findIndex((line) => line.startsWith("[2] "));
    expect(second).toBeGreaterThan(2);
    expect(lines.slice(second + 1)).toEqual([
      expect.stringMatching(/^> /),
      "",
      PROMPT_CONTEXT_FOOTER,
    ]);
  });

  it("drops other hits that would go over the size cap", () => {
    const store = openStore(":memory:");
    stores.push(store);
    // Notes carry their title in the label: long titles fill the budget.
    for (const id of ["a", "b", "c"]) {
      seed(store, `/${id}`, [
        chunk({
          kind: "note",
          sessionId: `${id} ${"very long document title ".repeat(16)}`,
          text: `webhook idempotency ${`${id}bcdefghijk `.repeat(60)}`,
        }),
      ]);
    }
    const context = promptContext(store, "webhook idempotency handling before") ?? "";
    expect(context.length).toBeLessThanOrEqual(MAX_PROMPT_CONTEXT_CHARS);
    expect(context).toMatch(/^\[1\] /m);
    expect(context).not.toMatch(/^\[3\] /m);
  });

  it("keeps the rarest terms that occur together, skipping one no chunk shares with them", () => {
    const store = openStore(":memory:");
    stores.push(store);
    seed(store, "/a", [chunk({ sessionId: "a", text: "orchid lantern" })]);
    seed(store, "/b", [chunk({ sessionId: "b", text: "orchid lantern" })]);
    for (const id of ["c", "d", "e"])
      seed(store, `/${id}`, [chunk({ sessionId: id, text: "falcon" })]);
    const context = promptContext(store, "orchid lantern falcon tuning") ?? "";
    expect(context).toMatch(/^> orchid lantern$/m);
    expect(context).not.toMatch(/falcon/);
  });

  it("needs two rare key terms: one rare word among common ones is a coincidence", () => {
    const store = openStore(":memory:");
    stores.push(store);
    const common = Array.from({ length: 30 }, (_, i) => chunk({ text: `harbor violet ${i}` }));
    const other = Array.from({ length: 270 }, (_, i) => chunk({ text: `plain note ${i}` }));
    seed(store, "/common", [...common, ...other]);
    seed(store, "/a", [chunk({ sessionId: "a", text: "quokka harbor violet" })]);
    seed(store, "/b", [chunk({ sessionId: "b", text: "quokka meadow harbor" })]);
    // "harbor" and "violet" are each in over 5% of the index: only "quokka" is rare.
    expect(promptContext(store, "quokka harbor violet, any notes?")).toBeUndefined();
    expect(
      promptContext(store, "quokka harbor violet, any notes?", { tuning: { specificShare: 1 } }),
    ).toMatch(/quokka harbor violet/);
    expect(promptContext(store, "quokka meadow harbor, any notes?")).toMatch(/quokka meadow/);
  });

  it("ignores filler words about earlier work, and a single shared word of a longer prompt", () => {
    const store = openStore(":memory:");
    stores.push(store);
    seed(store, "/a", [chunk({ sessionId: "a", text: "last time we remembered the orchid" })]);
    seed(store, "/b", [chunk({ sessionId: "b", text: "time to tune the falcon lantern" })]);
    // "last" and "time" are filler: only "orchid" is left, alone among several prompt terms.
    expect(promptContext(store, "orchid falcon like last time")).toBeUndefined();
    expect(promptContext(store, "falcon lantern, like last time")).toMatch(/falcon lantern/);
  });
});
