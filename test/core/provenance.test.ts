import { describe, expect, it } from "vitest";
import { corrections, provenance, provenanceLabel } from "../../src/core/provenance.js";

describe("provenance", () => {
  it("attributes the match to the turn holding most of the terms", () => {
    const text = [
      "user: Atlas is our own multi-tenant platform; Acme is one tenant.",
      "assistant: Acme is only a tenant, so the sunset schedule is not in its hands.",
    ].join("\n\n");
    expect(provenance(text, ["atlas", "platform", "tenant"])).toEqual({ speaker: "user" });
    expect(provenance(text, ["sunset", "schedule"])).toEqual({ speaker: "assistant" });
  });

  it("notes the first file an agent's turn cites, with its line", () => {
    const text =
      "assistant: The handler returns `Please try again later.` (src/Api/GlobalExceptionHandler.cs:41), see also README.md.";
    expect(provenance(text, ["handler"])).toEqual({
      speaker: "assistant",
      cites: "src/Api/GlobalExceptionHandler.cs:41",
    });
    expect(provenance("assistant: Documented in `docs/architecture.md`.", ["documented"])).toEqual({
      speaker: "assistant",
      cites: "docs/architecture.md",
    });
  });

  it("covers only the sentences holding a citation: a conclusion beside one stays unverified", () => {
    const text =
      "assistant: The atlas status note lists every tenant (docs/status.md:41).\nAcme is only a tenant → the atlas sunset is not in its hands.";
    expect(provenance(text, ["atlas", "tenant"])).toEqual({
      speaker: "assistant",
      cites: "docs/status.md:41",
      uncited: true,
    });
    // Sentences without the terms do not count against the citation.
    expect(provenance(`${text}\nUnrelated aside.`, ["status", "note"])).toEqual({
      speaker: "assistant",
      cites: "docs/status.md:41",
    });
  });

  it("does not take hosts, ports, versions or sentences for files", () => {
    for (const text of [
      "assistant: Call example.com:8443 with node 22.1 then retry. Done.",
      "assistant: Use v1.2.3 and e.g. the default.",
    ]) {
      expect(provenance(text, ["retry", "default"])).toEqual({ speaker: "assistant" });
    }
  });

  it("labels a parent agent's task as an agent prompt, and has no speaker for documents", () => {
    expect(provenance("agent: Find where tenants are created.", ["tenants"])).toEqual({
      speaker: "agent",
    });
    expect(provenance("# Notes\nTenants are created on signup.", ["tenants"])).toBeUndefined();
  });

  it("looks only at one speaker's turns holding a term, when asked", () => {
    const text =
      "user: keep the ledger\n\nassistant: The ledger stays in postgres, the ledger queue too.";
    expect(provenance(text, ["ledger", "postgres"], "user")).toEqual({ speaker: "user" });
    expect(provenance(text, ["postgres"], "user")).toBeUndefined();
  });

  it("marks a user turn that decides something", () => {
    expect(provenance("user: ok, we'll go with postgres for the ledger", ["ledger"])).toEqual({
      speaker: "user",
      decided: true,
    });
    expect(provenance("user: chốt dùng postgres cho ledger", ["ledger"])).toEqual({
      speaker: "user",
      decided: true,
    });
    expect(provenance("user: which ledger store?", ["ledger"])).toEqual({ speaker: "user" });
  });

  it("prefers the earlier turn on a tie", () => {
    const text = "user: tenant setup?\n\nassistant: tenant setup is done in the seed.";
    expect(provenance(text, ["tenant", "setup"])).toEqual({ speaker: "user" });
  });
});

describe("provenanceLabel", () => {
  it("says who said it, and that an agent's own conclusion is unverified", () => {
    expect(provenanceLabel({ speaker: "user" })).toBe("user said");
    expect(provenanceLabel({ speaker: "agent" })).toBe("agent task");
    expect(provenanceLabel({ speaker: "assistant", cites: "a.ts:3" })).toBe("agent cites a.ts:3");
    expect(provenanceLabel({ speaker: "assistant" })).toBe("agent claim, unverified");
    expect(provenanceLabel({ speaker: "assistant", cites: "a.ts:3", uncited: true })).toBe(
      "agent cites a.ts:3 + unverified claims",
    );
  });
});

describe("corrections", () => {
  it("finds a sentence with a correction word and the query's terms, with the one before", () => {
    const terms = ["acme", "tenant"];
    expect(corrections("user: That is wrong: Acme is not just a tenant.", terms)).toHaveLength(1);
    const [found] = corrections(
      "user: Acme is one tenant, they said. That is wrong, see the register.",
      terms,
    );
    expect(found).toContain("Acme is one tenant, they said.");
    expect(corrections("user: Nói Acme chỉ là tenant là sai.", terms)).toHaveLength(1);
    // Diacritics count: "sài" is not "sai".
    expect(corrections("user: Acme tenant ở Sài Gòn.", terms)).toEqual([]);
    expect(corrections("user: Wrong file.\nIt was fine.\nAcme is a tenant.", terms)).toEqual([]);
  });
});
