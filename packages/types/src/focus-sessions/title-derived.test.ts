import { describe, it, expect } from "vitest";
import {
  buildDerivedSessionTitle,
  buildRunSessionStartTitle,
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

  it("strips markdown markup a captured document's first line carries", () => {
    // Live 2026-09-20: a session on the pod was named
    // "## Design Philosophy: The Spine and the Flow". The GENERATED path
    // already stripped these; the derived path did not, so the same text read
    // as prose when a model named it and as raw markup when the pod did.
    expect(
      buildDerivedSessionTitle({
        kind: "capture",
        label: "## Design Philosophy: The Spine and the Flow",
      })
    ).toBe("Design Philosophy: The Spine and the Flow");
    expect(
      buildDerivedSessionTitle({ kind: "capture", label: "**Bold thing**" })
    ).toBe("Bold thing");
    expect(
      buildDerivedSessionTitle({ kind: "capture", label: "> quoted line" })
    ).toBe("quoted line");
  });

  it("DISCRIMINATING: leaves markup that is the person's own words alone", () => {
    // The whole reason both regexes are anchored. A reader that strips `#`
    // anywhere agrees with a correct one on every heading above, and only
    // these rows rule it out.
    expect(
      buildDerivedSessionTitle({ kind: "capture", label: "Acme is #1 in EMEA" })
    ).toBe("Acme is #1 in EMEA");
    expect(
      buildDerivedSessionTitle({ kind: "capture", label: "Revenue > costs" })
    ).toBe("Revenue > costs");
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

describe("derived names never read as cut (c-auto-titles, plan 9992207a)", () => {
  const LONG =
    "Every new title and knowledge entry on a personal pod is short and specific, and the backlog is repaired";

  it("a nameless work session is named from its goal, shortened at a clause", () => {
    const t = buildDerivedSessionTitle({ kind: "goal", goal: LONG });
    expect(t.length).toBeLessThanOrEqual(GENERATED_TITLE_MAX);
    expect(t).not.toMatch(/…$/);
    expect(LONG.startsWith(t)).toBe(true);
    expect(buildDerivedSessionTitle({ kind: "goal", goal: "  " })).toBe(
      "Work session"
    );
  });

  it("a run with no subject is named by its instance date, kept whole", () => {
    const at = new Date("2026-10-12T09:00:00Z");
    expect(
      buildDerivedSessionTitle({
        kind: "run",
        name: "Daily client briefing",
        at,
      })
    ).toBe("Daily client briefing — 12 Oct");
    const long = buildDerivedSessionTitle({
      kind: "run",
      name: 'When a post enters "Briefed", propose running "Produce content" for that post',
      at,
    });
    expect(long.endsWith(" — 12 Oct")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(GENERATED_TITLE_MAX);
    expect(long).not.toMatch(/…/);
  });

  it("a subject outranks the date", () => {
    expect(
      buildDerivedSessionTitle({
        kind: "run",
        name: "Client onboarding",
        subject: "Harbor Goods",
        at: new Date("2026-10-12T09:00:00Z"),
      })
    ).toBe("Client onboarding · Harbor Goods");
  });

  it("a receipt named by a proposal title takes the quoted object, not the verb", () => {
    expect(
      buildDerivedSessionTitle({
        kind: "receipt",
        doing: 'Create Knowledge "Grants deny by default for every agent key"',
      })
    ).toBe("Grants deny by default for every agent key");
    // Words that only resemble the shape are left alone.
    expect(
      buildDerivedSessionTitle({
        kind: "receipt",
        doing: "Create a launch plan",
      })
    ).toBe("Create a launch plan");
  });

  it("no derived or generated name ends in an ellipsis", () => {
    const names = [
      buildDerivedSessionTitle({ kind: "capture", label: LONG }),
      buildDerivedSessionTitle({ kind: "import", label: LONG }),
      buildDerivedSessionTitle({ kind: "receipt", doing: LONG }),
      buildDerivedSessionTitle({ kind: "run", name: LONG, subject: "Acme" }),
      sanitizeGeneratedTitle(LONG)!,
    ];
    for (const n of names) {
      expect(n).not.toMatch(/…$/);
      expect(n.length).toBeLessThanOrEqual(GENERATED_TITLE_MAX);
    }
  });
});

describe("buildRunSessionStartTitle — the name a run will carry, said before it exists", () => {
  it("is the SAME name the run session gets (one derivation)", () => {
    expect(
      buildRunSessionStartTitle({
        playbookName: "Qualify a lead",
        subjectNames: ["Acme Corp"],
      })
    ).toBe(
      buildDerivedSessionTitle({
        kind: "run",
        name: "Qualify a lead",
        subject: "Acme Corp",
      })
    );
    expect(
      buildRunSessionStartTitle({
        playbookName: "Qualify a lead",
        subjectNames: ["Acme Corp"],
      })
    ).toBe("Qualify a lead · Acme Corp");
  });

  it("names a subject-less run by its playbook alone — never a guessed date", () => {
    expect(buildRunSessionStartTitle({ playbookName: "Weekly review" })).toBe(
      "Weekly review"
    );
  });

  it("names a batch by its first subject and how many more, else by the count", () => {
    expect(
      buildRunSessionStartTitle({
        playbookName: "Qualify a lead",
        subjectNames: ["Ada", "Grace"],
        subjectCount: 4,
      })
    ).toBe("Qualify a lead · Ada + 3 more");
    expect(
      buildRunSessionStartTitle({
        playbookName: "Qualify a lead",
        subjectCount: 4,
      })
    ).toBe("Qualify a lead · 4 sessions");
  });

  it("drops an unresolved subject rather than printing an id", () => {
    expect(
      buildRunSessionStartTitle({
        playbookName: "Qualify a lead",
        subjectNames: [undefined, "42574b37-aecf-4ef4-9312-249a82e20213"],
      })
    ).toBe("Qualify a lead");
  });
});
