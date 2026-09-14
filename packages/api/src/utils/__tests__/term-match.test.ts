/**
 * The ONE term matcher, JS adapter. The SQL adapter and the SQL↔JS parity are
 * driven on PGlite in `services/skills/__tests__/skill-ranking.pglite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  queryTerms,
  rankByTerms,
  rarityWeight,
  scoreTextMatch,
  type MatchableText,
} from "../term-match.js";

type Cap = { name: string; description: string };
const fields = (c: Cap): MatchableText => ({
  primary: c.name,
  tertiary: c.description,
});

describe("rankByTerms — rarity weighting", () => {
  // The live defect shape: the generic stem hits NAMES, the distinctive word
  // hits only DESCRIPTIONS, and no candidate hits both.
  const caps: Cap[] = [
    { name: "creating views", description: "views over data" },
    { name: "creating profiles", description: "kinds" },
    { name: "creative loop", description: "iterate" },
    { name: "creating apps", description: "starter" },
    { name: "lenses", description: "organise work into a project" },
    { name: "filler", description: "nothing" },
  ];

  it("ranks the distinctive term's hit above the generic term's name hits", () => {
    const ranked = rankByTerms("create a project", caps, fields).map(
      (r) => r.item.name
    );
    expect(ranked[0]).toBe("lenses");
    expect(ranked).toHaveLength(5);
  });

  it("measures rarity over the candidates it is given", () => {
    // Same query; the only difference is how common `project` is in the set.
    const common: Cap[] = [
      { name: "creating views", description: "x" },
      { name: "a", description: "project" },
      { name: "b", description: "project" },
      { name: "c", description: "project" },
      { name: "d", description: "project" },
    ];
    const ranked = rankByTerms("create project", common, fields);
    expect(ranked[0]!.item.name).toBe("creating views");
  });

  it("drops zero-score candidates and keeps input order on ties", () => {
    const ranked = rankByTerms(
      "zork",
      [
        { name: "b zork", description: "" },
        { name: "none", description: "" },
        { name: "a zork", description: "" },
      ],
      fields
    ).map((r) => r.item.name);
    expect(ranked).toEqual(["b zork", "a zork"]);
  });

  it("rarityWeight is 0 for a term that hits nothing and falls as it spreads", () => {
    expect(rarityWeight(10, 0)).toBe(0);
    expect(rarityWeight(10, 1)).toBeGreaterThan(rarityWeight(10, 5));
  });
});

describe("rankByTerms — says why each candidate matched", () => {
  it("lists the hit terms rarest first, and the fields they hit", () => {
    const ranked = rankByTerms(
      "create project",
      [
        { name: "creating views", description: "x" },
        { name: "creating apps", description: "x" },
        { name: "lenses", description: "a project" },
        { name: "creating projects", description: "x" },
      ],
      fields
    );
    const byName = Object.fromEntries(
      ranked.map((r) => [r.item.name, r.match])
    );
    expect(byName["creating projects"]).toEqual({
      terms: ["project", "creat"],
      fields: ["name"],
    });
    expect(byName["lenses"]).toEqual({
      terms: ["project"],
      fields: ["description"],
    });
  });

  it("names the field tiers the way the door asks", () => {
    const [r] = rankByTerms(
      "send",
      [{ name: "gmail", verbs: ["gmail_send"] }],
      (c) => ({ primary: c.name, secondary: c.verbs }),
      { primary: "name", secondary: "verbs", tertiary: "description" }
    );
    expect(r!.match.fields).toEqual(["verbs"]);
  });
});

describe("queryTerms", () => {
  it("drops stopwords, stems lightly, and never returns nothing for real input", () => {
    expect(queryTerms("Capturing sessions")).toEqual(["captur", "session"]);
    expect(queryTerms("how to create a project")).toEqual(["creat", "project"]);
    expect(queryTerms("how to")).toEqual(["how", "to"]);
    expect(queryTerms("gmail_send")).toEqual(["gmail_send"]);
    expect(queryTerms("   ")).toEqual([]);
  });
});

describe("scoreTextMatch", () => {
  it("scores an exact primary match highest", () => {
    const exact = scoreTextMatch("gmail_send", { primary: "gmail_send" });
    const partial = scoreTextMatch("gmail", { primary: "gmail_send" });
    expect(exact).toBeGreaterThan(partial);
  });

  it("matches on secondary (verb labels) and tertiary (description) fields", () => {
    const bySecondary = scoreTextMatch("send", {
      primary: "Gmail",
      secondary: ["gmail_send"],
    });
    const byTertiary = scoreTextMatch("email", {
      primary: "Gmail",
      tertiary: "Send an email via the connected account",
    });
    expect(bySecondary).toBeGreaterThan(0);
    expect(byTertiary).toBeGreaterThan(0);
  });

  it("uses the shared terms (stopwords dropped, stemmed)", () => {
    expect(
      scoreTextMatch("the sending", { primary: "gmail", tertiary: "send mail" })
    ).toBeGreaterThan(0);
  });

  it("returns 0 when no token matches anything", () => {
    expect(
      scoreTextMatch("nonexistent", {
        primary: "Gmail",
        secondary: ["gmail_send"],
        tertiary: "Send email",
      })
    ).toBe(0);
  });

  it("returns 0 for an empty/whitespace query", () => {
    expect(scoreTextMatch("   ", { primary: "Gmail" })).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(scoreTextMatch("GMAIL", { primary: "gmail_send" })).toBeGreaterThan(
      0
    );
  });
});
