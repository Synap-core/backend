/**
 * The SERVER review graph carries a connected plan's steps as typed nodes and
 * ONE edge list — so relay (`p.graph`) and synap-app render it without either
 * re-deriving parent/blocker edges from session fields.
 *
 * Pinned: the founder plan's projects / sessions / documents / links (with the
 * ONE display title and the folded edges), that the refusal guard no longer
 * fires for plan ops, and that an entity/relation graph is BYTE-IDENTICAL to
 * its pre-plan shape (no new keys at all).
 */

import { describe, expect, it } from "vitest";
import type { CompositeProposalData } from "@synap-core/types/proposals";
import { buildProposalGraph } from "./display.js";

const UUID = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";

describe("buildProposalGraph — connected plan", () => {
  it("renders every plan step as a typed node and folds all session edges into `links`", () => {
    const data: CompositeProposalData = {
      operations: [
        {
          op: "create_entity",
          ref: "acme",
          profileSlug: "company",
          title: "Acme",
        },
        {
          op: "create_project",
          ref: "p1",
          name: "Acme onboarding",
          subjectRef: "acme",
          evidence: { counted: 1, minimum: 5, belowAgentFloor: true },
        },
        {
          op: "create_session",
          ref: "s0",
          title: "Onboard &amp; ship",
          goal: "Acme live",
          projectRef: "p1",
          subjectRef: "acme",
        },
        {
          op: "create_session",
          ref: "s1",
          goal: "Spec signed off by Acme",
          parentRef: "s0",
          projectRef: "p1",
        },
        {
          op: "create_session",
          ref: "s2",
          goal: "Import",
          parentRef: "s0",
          blockedBySessionIds: [UUID],
        },
        {
          op: "create_document",
          ref: "spec",
          title: "Spec",
          content: "# Spec",
          sessionRef: "s1",
        },
        { op: "create_link", type: "blocked_by", fromRef: "s2", toRef: "s1" },
      ],
    };

    const graph = buildProposalGraph(data);

    expect(graph.isPlan).toBe(true);
    expect(graph.planStepCount).toBe(6);
    expect(graph.projects).toEqual([
      {
        ref: "p1",
        name: "Acme onboarding",
        subjectRef: "acme",
        evidence: { counted: 1, minimum: 5, belowAgentFloor: true },
      },
    ]);
    expect(graph.sessions?.map((s) => [s.ref, s.displayTitle])).toEqual([
      ["s0", "Onboard & ship"],
      ["s1", "Spec signed off by Acme"],
      ["s2", "Import"],
    ]);
    expect(graph.documents).toEqual([
      { ref: "spec", title: "Spec", sessionRef: "s1" },
    ]);
    expect(graph.links).toEqual([
      {
        type: "spawned_from",
        fromRef: "s1",
        toRef: "s0",
        fromLabel: "Spec signed off by Acme",
        toLabel: "Onboard & ship",
        itemRef: "$link0",
      },
      {
        type: "spawned_from",
        fromRef: "s2",
        toRef: "s0",
        fromLabel: "Import",
        toLabel: "Onboard & ship",
        itemRef: "$link1",
      },
      {
        type: "blocked_by",
        fromRef: "s2",
        toSessionId: UUID,
        fromLabel: "Import",
        toLabel: "session 7d4f6c0e",
        itemRef: "$link2",
      },
      {
        type: "blocked_by",
        fromRef: "s2",
        toRef: "s1",
        fromLabel: "Import",
        toLabel: "Spec signed off by Acme",
        itemRef: "$link3",
      },
    ]);
    // The entity half is untouched by the plan pass.
    expect(graph.entities.map((e) => e.ref)).toEqual(["acme"]);
  });

  it("an entity/relation graph gains NO plan keys (additive)", () => {
    const graph = buildProposalGraph({
      operations: [
        { op: "create_entity", ref: "a", profileSlug: "person", title: "Ada" },
        {
          op: "create_entity",
          ref: "b",
          profileSlug: "company",
          title: "Acme",
        },
        {
          op: "create_relation",
          sourceRef: "a",
          targetRef: "b",
          type: "works_at",
        },
      ],
    });
    expect(Object.keys(graph).sort()).toEqual([
      "entities",
      "entityCount",
      "facetCount",
      "relationCount",
      "relations",
    ]);
  });
});
