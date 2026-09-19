import { describe, it, expect } from "vitest";
import {
  buildDerivedSessionTitle,
  sanitizeGeneratedTitle,
  readTitleSource,
  canAutoRetitle,
  GENERATED_TITLE_MAX,
} from "./index.js";

describe("buildDerivedSessionTitle", () => {
  it("names a run by playbook and subject", () => {
    expect(buildDerivedSessionTitle({ kind: "run", name: "CRM Hygiene" })).toBe(
      "CRM Hygiene"
    );
    expect(
      buildDerivedSessionTitle({
        kind: "run",
        name: "Research Competitor",
        subject: "Acme",
      })
    ).toBe("Research Competitor · Acme");
  });

  it("turns a captured URL into its host, never the query string", () => {
    expect(
      buildDerivedSessionTitle({
        kind: "capture",
        label:
          "https://linktr.ee/buisae.studio?utm_source=ig&utm_medium=social",
      })
    ).toBe("Link from linktr.ee");
  });

  it("never leaks ids into a receipt name", () => {
    const out = buildDerivedSessionTitle({
      kind: "receipt",
      doing: 'Create Link "420dfd95 --references--> d4b84ad8"',
    });
    expect(out).not.toMatch(/420dfd95|d4b84ad8/);
    expect(
      buildDerivedSessionTitle({ kind: "receipt", agentLabel: "Claude Code" })
    ).toBe("Changes by Claude Code");
    expect(buildDerivedSessionTitle({ kind: "receipt" })).toBe("Agent changes");
  });

  it("bounds every derived name", () => {
    const out = buildDerivedSessionTitle({
      kind: "capture",
      label: "word ".repeat(40),
    });
    expect(out.length).toBeLessThanOrEqual(GENERATED_TITLE_MAX);
  });
});

describe("sanitizeGeneratedTitle", () => {
  it("strips reasoning, quotes, prefixes and trailing punctuation", () => {
    expect(
      sanitizeGeneratedTitle(
        '<think>hmm</think>\n"Relay theme follows system."'
      )
    ).toBe("Relay theme follows system");
    expect(sanitizeGeneratedTitle("Title: Billing launch")).toBe(
      "Billing launch"
    );
  });

  it("refuses ids, links and empty answers", () => {
    expect(sanitizeGeneratedTitle("https://example.com/x")).toBeNull();
    expect(
      sanitizeGeneratedTitle("Session 1c96e9fb-76db-4958-b103-83d6e4a330c2")
    ).toBeNull();
    expect(sanitizeGeneratedTitle("   ")).toBeNull();
    expect(sanitizeGeneratedTitle(undefined)).toBeNull();
  });
});

describe("title provenance", () => {
  it("reads legacy rows safely", () => {
    expect(readTitleSource({ title: null, metadata: {} })).toBe("derived");
    expect(readTitleSource({ title: "Named", metadata: null })).toBe("agent");
    expect(
      readTitleSource({ title: "x", metadata: { titleSource: "human" } })
    ).toBe("human");
  });

  it("never lets automation replace a human or agent title", () => {
    expect(
      canAutoRetitle({ title: "x", metadata: { titleSource: "human" } })
    ).toBe(false);
    expect(
      canAutoRetitle({ title: "x", metadata: { titleSource: "agent" } })
    ).toBe(false);
    expect(
      canAutoRetitle({ title: "x", metadata: { titleSource: "generated" } })
    ).toBe(true);
    expect(canAutoRetitle({ title: null, metadata: {} })).toBe(true);
  });
});

describe("titleSourcePatch", () => {
  it("is the metadata patch a naming door merges", async () => {
    const { titleSourcePatch, canAutoRetitle } = await import("./title.js");
    expect(titleSourcePatch("human")).toEqual({ titleSource: "human" });
    expect(
      canAutoRetitle({ title: "x", metadata: titleSourcePatch("agent") })
    ).toBe(false);
    expect(
      canAutoRetitle({ title: null, metadata: titleSourcePatch("derived") })
    ).toBe(true);
  });
});
