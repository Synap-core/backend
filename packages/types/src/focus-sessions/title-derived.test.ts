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

  it("drops the machine verb a creator already wrote into the label", () => {
    // Live 2026-09-20: 12 of 50 rows had a derived title BYTE-IDENTICAL to the
    // goal it was built from, because intake stores `goal` as `Capture · <x>`
    // and the backfill hands that whole string over as the label. The name has
    // to be the CONTENT.
    const goal = "Capture · Un des buts de synap: pouvoir dire ce qu'on veut";
    const title = buildDerivedSessionTitle({ kind: "capture", label: goal });
    expect(title).not.toBe(goal);
    expect(title.startsWith("Capture")).toBe(false);
    expect(title).toBe("Un des buts de synap: pouvoir dire ce qu'on veut");
    // The prepending verbs have the same hazard one step earlier.
    expect(
      buildDerivedSessionTitle({ kind: "enrich", label: "Enrich Acme Corp" })
    ).toBe("Enrich Acme Corp");
    expect(
      buildDerivedSessionTitle({ kind: "import", label: "Import Q3 ledger" })
    ).toBe("Import Q3 ledger");
  });

  it("keeps a label that only RESEMBLES the machine verb", () => {
    // The strip is anchored and case-sensitive on purpose: these are a
    // person's own words, not a creator's prefix, and eating them would be a
    // worse bug than the one being fixed.
    expect(
      buildDerivedSessionTitle({ kind: "capture", label: "Capture the flag" })
    ).toBe("Capture the flag");
    expect(
      buildDerivedSessionTitle({ kind: "capture", label: "capture · notes" })
    ).toBe("capture · notes");
    expect(
      buildDerivedSessionTitle({ kind: "import", label: "Important dates" })
    ).toBe("Import Important dates");
  });

  it("falls back to the verb when the label was only the prefix", () => {
    expect(
      buildDerivedSessionTitle({ kind: "capture", label: "Capture · " })
    ).toBe("Capture");
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
