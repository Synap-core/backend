import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  rankRouteCandidates,
  suggestRoutesForEntities,
  type RouteCandidate,
} from "./suggest-routes.js";

/**
 * FIXTURE DISCIPLINE: the discriminating input is two candidates for the SAME
 * kind where only one matches the intent text, placed so the textual match is
 * SECOND in the matcher's (updatedAt) order — a ranker that ignores text keeps
 * it second.
 */

const bookmark = { entityId: "e1", profileSlug: "bookmark" };

const candidates: RouteCandidate[] = [
  {
    kind: "playbook",
    id: "pb-archive",
    name: "Archive old links",
    text: ["Move stale bookmarks away"],
    subjectProfileSlug: "bookmark",
  },
  {
    kind: "playbook",
    id: "pb-review",
    name: "Weekly review habit",
    text: ["Read and triage what you saved"],
    subjectProfileSlug: "bookmark",
  },
];

describe("rankRouteCandidates", () => {
  it("with intentText, ranks the textual match FIRST and says why", () => {
    const ranked = rankRouteCandidates({
      entity: bookmark,
      intentText: "I want to review these every week… reviews on Sunday",
      candidates,
    });
    expect(ranked.map((r) => r.candidate.id)).toEqual([
      "pb-review",
      "pb-archive",
    ]);
    expect(ranked[0]!.signals[0]).toEqual({
      type: "intent",
      terms: ["review"],
    });
    expect(ranked[0]!.reason).toMatch(
      /^You mentioned “review” · Made for .+ items$/
    );
    expect(ranked[1]!.reason).toMatch(/^Made for .+ items$/);
  });

  it("breaks an exact tie by NAME, never by the matcher's (updatedAt) order", () => {
    // Both are kind matches with no intent: identical relevance. Input order
    // puts "Weekly…" first (the most recently edited); the name puts
    // "Archive…" first. Reversing the input must not change the answer.
    const reversed = [...candidates].reverse();
    for (const pool of [candidates, reversed]) {
      const ranked = rankRouteCandidates({
        entity: bookmark,
        candidates: pool,
      });
      expect(ranked.map((r) => r.candidate.id)).toEqual([
        "pb-archive",
        "pb-review",
      ]);
    }
  });

  it("a subject-less candidate with no intent match is NOT returned", () => {
    const ranked = rankRouteCandidates({
      entity: { profileSlug: "person", facetSlugs: ["client"] },
      candidates: [
        {
          kind: "automation",
          id: "any",
          name: "Log everything",
          subjectProfileSlug: null,
        },
        {
          kind: "playbook",
          id: "facet",
          name: "Onboard",
          subjectProfileSlug: "client",
        },
        {
          kind: "playbook",
          id: "kind",
          name: "Intro",
          subjectProfileSlug: "person",
        },
      ],
    });
    // "Runs for anything new" is true of it for EVERY request, so it is not
    // evidence: kind and facet come back, the any-kind automation does not.
    expect(ranked.map((r) => r.candidate.id)).toEqual(["kind", "facet"]);
    expect(ranked[1]!.reason).toMatch(/role$/);
  });

  it("anyKind rides along only with a real intent match", () => {
    const ranked = rankRouteCandidates({
      entity: { profileSlug: "person" },
      intentText: "log everything",
      candidates: [
        {
          kind: "automation",
          id: "any",
          name: "Log everything",
          subjectProfileSlug: null,
        },
        {
          kind: "automation",
          id: "any-silent",
          name: "Archive",
          subjectProfileSlug: null,
        },
      ],
    });
    expect(ranked.map((r) => r.candidate.id)).toEqual(["any"]);
    expect(ranked[0]!.signals.map((s) => s.type)).toEqual([
      "intent",
      "anyKind",
    ]);
    expect(ranked[0]!.reason).toMatch(/· Runs for anything new$/);
  });
});

describe("rankRouteCandidates — rarity (IDF over the pool)", () => {
  const pb = (id: string, name: string, text: string): RouteCandidate => ({
    kind: "playbook",
    id,
    name,
    text: [text],
    subjectProfileSlug: null,
  });

  it("a word every candidate shares outweighs nothing: the rare word wins", () => {
    // "agent" is in 3 of 5, "build" in 1, "each" in 2. "common" hits
    // agent+each, "rare" hits build+each: two words each, so under a flat
    // per-word sum they tie and the input order decides — that is the defect. Under IDF the one holding the RARE word
    // must win, whatever the input order.
    const pool = [
      pb("common", "Agent upkeep", "an agent that tidies each record"),
      pb("rare", "Dev session", "each step: build then verify"),
      pb("f1", "Agent one", "agent notes"),
      pb("f2", "Agent two", "agent notes"),
      pb("f3", "Other", "nothing to see"),
    ];
    for (const candidates of [pool, [...pool].reverse()]) {
      const ranked = rankRouteCandidates({
        entity: {},
        intentText: "build an agent for each",
        candidates,
      });
      expect(ranked[0]!.candidate.id).toBe("rare");
      // f3 matched no word and has no subject: not returned.
      expect(ranked.map((r) => r.candidate.id)).not.toContain("f3");
    }
  });

  it("a one-candidate pool still ranks by words (smoothed IDF never zeroes)", () => {
    const [only] = rankRouteCandidates({
      entity: {},
      intentText: "build",
      candidates: [pb("x", "Build", "")],
    });
    expect(only!.score).toBeGreaterThan(0);
  });
});

/**
 * THE MEASURED CASE, from the live pod (read-only `synap_match_playbooks`,
 * 2026-09-28): the space-brief intent ranked "CRM Hygiene" first on the words
 * "agent" + "each", tied at 6.5 with "AI Dev Session" ("build" + "each") and
 * won on updatedAt. The fixture is the 20-candidate pool that call ranked,
 * with the real goal texts, in the order the pod returned them — so CRM
 * Hygiene PRECEDES AI Dev Session, and an order-keeping tie-break reproduces
 * the defect.
 */
describe("rankRouteCandidates — the live CRM Hygiene case", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./__fixtures__/live-playbook-pool-2026-09-28.json",
        import.meta.url
      ),
      "utf-8"
    )
  ) as {
    candidates: Array<{
      id: string;
      name: string;
      goalTemplate: string;
      subjectProfileSlug: string | null;
    }>;
  };
  // Exactly how `playbooks.matchForEntity` builds its candidates.
  const pool: RouteCandidate[] = fixture.candidates.map((p) => ({
    kind: "playbook",
    id: p.id,
    name: p.name,
    text: [p.goalTemplate],
    subjectProfileSlug: p.subjectProfileSlug,
  }));
  const INTENT =
    "Design and build a feature: space brief so an agent knows what each space is for, then fix MCP discovery gaps";

  it("the fixture is the live pool (non-vacuity)", () => {
    expect(pool).toHaveLength(20);
    const names = pool.map((p) => p.name);
    expect(names.indexOf("CRM Hygiene")).toBeLessThan(
      names.indexOf("AI Dev Session")
    );
  });

  it("ranks AI Dev Session above CRM Hygiene", () => {
    const ranked = rankRouteCandidates({
      entity: {},
      intentText: INTENT,
      candidates: pool,
    });
    const names = ranked.map((r) => r.candidate.name);
    expect(names[0]).toBe("AI Dev Session");
    expect(names.indexOf("AI Dev Session")).toBeLessThan(
      names.indexOf("CRM Hygiene")
    );
  });

  it("returns only candidates that matched a word (no bare 'Runs for anything new')", () => {
    const ranked = rankRouteCandidates({
      entity: {},
      intentText: INTENT,
      candidates: pool,
    });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.length).toBeLessThan(pool.length);
    for (const r of ranked) {
      expect(r.signals.some((s) => s.type === "intent")).toBe(true);
    }
    // Named: these matched no word of the intent on the live call.
    const returned = new Set(ranked.map((r) => r.candidate.name));
    for (const silent of [
      "Dogfood sweep",
      "Security Audit",
      "Market Research Sprint",
    ]) {
      expect(returned.has(silent)).toBe(false);
    }
  });
});

describe("suggestRoutesForEntities", () => {
  it("merges playbooks and automations per entity, drops signal-less candidates, caps the list", () => {
    const [s] = suggestRoutesForEntities({
      intentText: "weekly review",
      entities: [
        {
          ...bookmark,
          candidates: [
            ...candidates,
            {
              kind: "automation",
              id: "au-other",
              name: "Other",
              subjectProfileSlug: "task",
            },
          ],
        },
      ],
      limit: 1,
    });
    expect(s!.entityId).toBe("e1");
    expect(s!.suggestions.map((r) => r.candidate.id)).toEqual(["pb-review"]);
  });
});
