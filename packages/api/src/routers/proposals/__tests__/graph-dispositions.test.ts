/**
 * Unit tests for the Phase-2 per-item cascade (`applyGraphDispositions`).
 *
 * This is the riskiest Phase-2 logic — partial-applying a graph proposal with
 * cascade-reject. Pure/DB-free, so it runs without a DATABASE_URL and replaces a
 * whole class of manual "does rejecting X drop its links" dogfood checks.
 */

import { describe, it, expect } from "vitest";
import { opRef } from "@synap-core/types/proposals";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  applyGraphDispositions,
  type GraphDispositionMap,
} from "../graph-dispositions.js";

// A graph: PersonA ($op0/$primary), CompanyB ($op1); A --works_at--> B ($rel0);
// B --owns--> A ($rel1).
function graph(): CompositeProposalOperation[] {
  return [
    { op: "create_entity", profileSlug: "person", title: "Person A" },
    { op: "create_entity", profileSlug: "company", title: "Company B" },
    {
      op: "create_relation",
      type: "works_at",
      sourceRef: opRef(0),
      targetRef: opRef(1),
    },
    {
      op: "create_relation",
      type: "owns",
      sourceRef: opRef(1),
      targetRef: opRef(0),
    },
  ];
}

describe("applyGraphDispositions", () => {
  it("empty map ⇒ identity (whole-proposal apply, byte-identical)", () => {
    const ops = graph();
    expect(applyGraphDispositions(ops, {})).toEqual(ops);
  });

  it("accept-all ⇒ identity", () => {
    const ops = graph();
    const d: GraphDispositionMap = {
      [opRef(0)]: { status: "accept" },
      [opRef(1)]: { status: "accept" },
      $rel0: { status: "accept" },
      $rel1: { status: "accept" },
    };
    expect(applyGraphDispositions(ops, d)).toEqual(ops);
  });

  it("reject an entity ⇒ drops it AND cascade-drops every relation touching it", () => {
    // Reject Person A ($op0). Both relations reference $op0 → both cascade-drop.
    const out = applyGraphDispositions(graph(), {
      [opRef(0)]: { status: "reject", reasonCode: "not_relevant" },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ op: "create_entity", title: "Company B" });
  });

  it("reject a relation by $relN ⇒ drops only that relation, keeps entities + other links", () => {
    const out = applyGraphDispositions(graph(), {
      $rel0: { status: "reject", reasonCode: "wrong_link_type" },
    });
    // 2 entities + the surviving $rel1.
    expect(out).toHaveLength(3);
    expect(out.filter((o) => o.op === "create_relation")).toHaveLength(1);
    expect(out.find((o) => o.op === "create_relation")).toMatchObject({
      type: "owns",
    });
  });

  it("edit an entity ⇒ merges title + properties (the edit-persistence channel)", () => {
    const ops: CompositeProposalOperation[] = [
      {
        op: "create_entity",
        profileSlug: "person",
        title: "Old",
        properties: { a: 1 },
      },
    ];
    const out = applyGraphDispositions(ops, {
      [opRef(0)]: {
        status: "edit",
        edits: { title: "New", properties: { b: 2 } },
      },
    });
    expect(out[0]).toMatchObject({
      op: "create_entity",
      title: "New",
      properties: { a: 1, b: 2 }, // properties MERGE, not replace
    });
  });

  it("cascade-drops a facet on a KEPT entity whose contextRef points at a rejected entity", () => {
    // CompanyB carries a 'client' facet contextRef'd to PersonA; reject PersonA →
    // CompanyB is kept but its client facet is dropped (dangling contextRef).
    const ops: CompositeProposalOperation[] = [
      { op: "create_entity", profileSlug: "person", title: "Person A" },
      {
        op: "create_entity",
        profileSlug: "company",
        title: "Company B",
        facets: [
          { profileSlug: "client", contextRef: opRef(0) },
          { profileSlug: "partner" }, // no contextRef → survives
        ],
      },
    ];
    const out = applyGraphDispositions(ops, {
      [opRef(0)]: { status: "reject" },
    });
    expect(out).toHaveLength(1);
    const company = out[0] as Extract<
      CompositeProposalOperation,
      { op: "create_entity" }
    >;
    expect(company.facets).toEqual([{ profileSlug: "partner" }]);
  });

  it("matches an entity's `ref` alias (not just $opN) for reject + cascade", () => {
    const ops: CompositeProposalOperation[] = [
      { op: "create_entity", profileSlug: "person", title: "A", ref: "a" },
      { op: "create_entity", profileSlug: "company", title: "B", ref: "b" },
      {
        op: "create_relation",
        type: "works_at",
        sourceRef: "a",
        targetRef: "b",
      },
    ];
    // Reject by the op's own ref key.
    const out = applyGraphDispositions(ops, { a: { status: "reject" } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ref: "b" });
  });

  it("never leaves a dangling relation (the invariant guard does not throw on valid input)", () => {
    // Rejecting the target entity must also drop the relation — no throw.
    expect(() =>
      applyGraphDispositions(graph(), { [opRef(1)]: { status: "reject" } })
    ).not.toThrow();
    const out = applyGraphDispositions(graph(), {
      [opRef(1)]: { status: "reject" },
    });
    expect(out.filter((o) => o.op === "create_relation")).toHaveLength(0);
  });
});
