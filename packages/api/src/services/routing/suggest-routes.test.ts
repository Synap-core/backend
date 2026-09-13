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

  it("without intentText keeps the matcher's order (stable ties)", () => {
    const ranked = rankRouteCandidates({ entity: bookmark, candidates });
    expect(ranked.map((r) => r.candidate.id)).toEqual([
      "pb-archive",
      "pb-review",
    ]);
  });

  it("kind outranks facet outranks any-kind", () => {
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
    expect(ranked.map((r) => r.candidate.id)).toEqual(["kind", "facet", "any"]);
    expect(ranked[1]!.reason).toMatch(/role$/);
    expect(ranked[2]!.reason).toBe("Runs for anything new");
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
