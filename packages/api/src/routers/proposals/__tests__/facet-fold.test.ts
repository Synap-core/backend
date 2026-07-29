/**
 * Unit tests for the approve-time FACET channel — the domain-agnostic pure
 * helpers that fold the facets a CALLER explicitly named onto the surviving
 * create_entity ops of a composite proposal. There is NO kind/relation/default
 * logic here: the backend attaches exactly what the caller listed in
 * `facetsByRef` (composite) — nothing about "company"/"person"/"works_at".
 *
 * Pure/DB-free (mirrors graph-dispositions.test.ts): runs without a DATABASE_URL.
 */

import { describe, it, expect } from "vitest";
import { opRef } from "@synap-core/types/proposals";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  survivingEntityFacetSlices,
  foldFacetsIntoOps,
  type FacetSpec,
  type GraphDispositionMap,
} from "../graph-dispositions.js";

// A small graph: entity a1 (explicit ref), a2 (explicit ref), plus one ref-less
// op ($op2) to prove positional-ref ($opN) resolution.
function graph(): CompositeProposalOperation[] {
  return [
    { op: "create_entity", ref: "a1", profileSlug: "company", title: "Acme" },
    { op: "create_entity", ref: "a2", profileSlug: "person", title: "Ada" },
    { op: "create_entity", profileSlug: "note", title: "Ref-less" }, // $op2
  ];
}

const facetsOf = (op: CompositeProposalOperation): FacetSpec[] =>
  op.op === "create_entity" ? ((op.facets as FacetSpec[]) ?? []) : [];

describe("survivingEntityFacetSlices (caller-named facets, no policy)", () => {
  it("attaches facetsByRef to the matching ref; unnamed refs get []", () => {
    const slices = survivingEntityFacetSlices(graph(), undefined, {
      a1: [{ profileSlug: "lead" }],
    });
    expect(slices).toEqual([
      { ref: "a1", facets: [{ profileSlug: "lead" }] },
      { ref: "a2", facets: [] },
      { ref: opRef(2), facets: [] },
    ]);
  });

  it("no facetsByRef at all → every surviving entity gets []", () => {
    const slices = survivingEntityFacetSlices(graph(), undefined, undefined);
    expect(slices).toEqual([
      { ref: "a1", facets: [] },
      { ref: "a2", facets: [] },
      { ref: opRef(2), facets: [] },
    ]);
  });

  it("[] for a ref = explicitly no facet", () => {
    const slices = survivingEntityFacetSlices(graph(), undefined, {
      a1: [],
    });
    expect(slices.find((s) => s.ref === "a1")?.facets).toEqual([]);
  });

  it("alias resolution: a ref-less op is keyed by its positional $opN ref", () => {
    const slices = survivingEntityFacetSlices(graph(), undefined, {
      [opRef(2)]: [{ profileSlug: "partner" }],
    });
    expect(slices.find((s) => s.ref === opRef(2))?.facets).toEqual([
      { profileSlug: "partner" },
    ]);
  });

  it("never double-attaches a slug the op already declares", () => {
    const ops: CompositeProposalOperation[] = [
      {
        op: "create_entity",
        ref: "a1",
        profileSlug: "company",
        title: "Acme",
        facets: [{ profileSlug: "lead" }],
      },
    ];
    const slices = survivingEntityFacetSlices(ops, undefined, {
      a1: [{ profileSlug: "lead" }, { profileSlug: "partner" }],
    });
    // "lead" already present → dropped; "partner" added.
    expect(slices[0]?.facets).toEqual([{ profileSlug: "partner" }]);
  });

  it("collapses duplicates within the caller's list", () => {
    const slices = survivingEntityFacetSlices(graph(), undefined, {
      a1: [{ profileSlug: "lead" }, { profileSlug: "lead" }],
    });
    expect(slices.find((s) => s.ref === "a1")?.facets).toEqual([
      { profileSlug: "lead" },
    ]);
  });

  it("a REJECTED entity is dropped before the fold (yields no slice)", () => {
    const dispositions: GraphDispositionMap = { a2: { status: "reject" } };
    const slices = survivingEntityFacetSlices(graph(), dispositions, {
      a1: [{ profileSlug: "lead" }],
      a2: [{ profileSlug: "prospect" }], // rejected → never emitted
    });
    expect(slices.map((s) => s.ref)).toEqual(["a1", opRef(2)]);
    expect(slices.find((s) => s.ref === "a1")?.facets).toEqual([
      { profileSlug: "lead" },
    ]);
  });
});

describe("foldFacetsIntoOps", () => {
  it("appends the named facets to surviving create_entity ops, in order", () => {
    const ops = graph();
    const slices = survivingEntityFacetSlices(ops, undefined, {
      a1: [{ profileSlug: "lead" }],
      [opRef(2)]: [{ profileSlug: "partner" }],
    });
    const folded = foldFacetsIntoOps(ops, slices);
    expect(facetsOf(folded[0])).toEqual([{ profileSlug: "lead" }]); // a1
    expect(facetsOf(folded[1])).toEqual([]); // a2 unnamed
    expect(facetsOf(folded[2])).toEqual([{ profileSlug: "partner" }]); // $op2
    // does not mutate the input ops
    expect(facetsOf(ops[0])).toEqual([]);
  });

  it("preserves an op's pre-declared facets (adds beside them)", () => {
    const ops: CompositeProposalOperation[] = [
      {
        op: "create_entity",
        ref: "a1",
        profileSlug: "company",
        title: "Acme",
        facets: [{ profileSlug: "customer" }],
      },
    ];
    const slices = survivingEntityFacetSlices(ops, undefined, {
      a1: [{ profileSlug: "lead" }],
    });
    const folded = foldFacetsIntoOps(ops, slices);
    expect(facetsOf(folded[0])).toEqual([
      { profileSlug: "customer" },
      { profileSlug: "lead" },
    ]);
  });
});
