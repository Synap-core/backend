/**
 * The `use_kind` suggestions for an item whose kind is missing — ranked from
 * what the pod stores on each kind, no model involved.
 *
 * Each row rules out a wrong ranking:
 *  - `research` names the missing kind in its synonyms and has NO field in
 *    common; `finding` shares every field but no vocabulary. Research first
 *    rules out "field overlap before vocabulary".
 *  - `insight` shares one of two fields; `trends-digest` only resembles the
 *    name. Insight first rules out "names before fields".
 *  - `pain-point` scores nothing and is absent: an unranked kind is not a
 *    suggestion.
 *  - `trend` (the missing slug, now available here) outranks everything.
 */
import { describe, expect, it } from "vitest";
import {
  compareSignals,
  nameSimilarity,
  rankKindSuggestions,
  scoreKindCandidate,
  type KindCandidate,
} from "./resolve-kind-rank.js";

const missing = { slug: "trend", kindName: "Trend" };
const item = {
  title: "Agent-memory users now demand deletion",
  propertyKeys: ["description", "evidence"],
};

const research: KindCandidate = {
  slug: "research",
  displayName: "Research",
  synonyms: ["trends", "study"],
  fieldSlugs: ["conclusion"],
};
const finding: KindCandidate = {
  slug: "finding",
  displayName: "Finding",
  fieldSlugs: ["description", "evidence"],
};
const insight: KindCandidate = {
  slug: "insight",
  displayName: "Insight",
  fieldSlugs: ["evidence"],
};
const digest: KindCandidate = {
  slug: "trends-digest",
  displayName: "Trends digest",
  fieldSlugs: [],
};
const painPoint: KindCandidate = {
  slug: "pain-point",
  displayName: "Pain point",
  fieldSlugs: ["severity"],
};

describe("rankKindSuggestions", () => {
  it("ranks vocabulary, then fields, then names, and drops what scores nothing", () => {
    const ranked = rankKindSuggestions({
      missing,
      item,
      candidates: [painPoint, digest, insight, finding, research],
      limit: 10,
    });
    expect(ranked.map((r) => r.slug)).toEqual([
      "research",
      "finding",
      "insight",
      "trends-digest",
    ]);
    expect(ranked[0]!.signals).toMatchObject({
      vocabulary: true,
      fieldOverlap: 0,
    });
    expect(ranked[1]!.signals.fieldOverlap).toBe(1);
    expect(ranked[2]!.signals.fieldOverlap).toBe(0.5);
    expect(ranked[3]!.signals.similarity).toBeGreaterThan(0);
  });

  it("puts the missing slug itself first once it is available", () => {
    const ranked = rankKindSuggestions({
      missing,
      item,
      candidates: [
        research,
        { slug: "trend", displayName: "Trend", fieldSlugs: [] },
      ],
    });
    expect(ranked[0]!.slug).toBe("trend");
    expect(ranked[0]!.signals.sameSlug).toBe(true);
  });

  it("reads the missing kind's own synonyms and a shared semanticSlug", () => {
    const viaMissingSynonyms = scoreKindCandidate(
      { ...missing, synonyms: ["signal"] },
      item,
      { slug: "signal", displayName: "Signal", fieldSlugs: [] }
    );
    expect(viaMissingSynonyms.vocabulary).toBe(true);
    const viaSemantic = scoreKindCandidate(
      { ...missing, semanticSlug: "market-signal" },
      item,
      {
        slug: "movement",
        displayName: "Movement",
        semanticSlug: "market-signal",
        fieldSlugs: [],
      }
    );
    expect(viaSemantic.vocabulary).toBe(true);
  });

  it("counts the candidate named in the item's title", () => {
    const s = scoreKindCandidate(missing, item, {
      slug: "deletion-request",
      displayName: "Deletion",
      fieldSlugs: [],
    });
    expect(s.similarity).toBe(0.5);
  });

  it("keeps at most `limit`, 3 by default", () => {
    const ranked = rankKindSuggestions({
      missing,
      item,
      candidates: [research, finding, insight, digest],
    });
    expect(ranked).toHaveLength(3);
  });

  it("compares tiers in order", () => {
    const base = {
      sameSlug: false,
      vocabulary: false,
      fieldOverlap: 0,
      similarity: 0,
    };
    expect(
      compareSignals(
        { ...base, vocabulary: true },
        { ...base, fieldOverlap: 1, similarity: 1 }
      )
    ).toBeLessThan(0);
    expect(
      compareSignals({ ...base, fieldOverlap: 0.1 }, { ...base, similarity: 1 })
    ).toBeLessThan(0);
  });

  it("measures name closeness as words, plural-tolerant", () => {
    expect(nameSimilarity("Trend", "trends")).toBe(1);
    expect(nameSimilarity("trend", "pain-point")).toBeLessThan(0.5);
  });
});
