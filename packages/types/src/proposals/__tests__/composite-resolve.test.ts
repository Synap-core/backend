import { describe, it, expect } from "vitest";
import {
  registerEntityRef,
  resolveCompositeRef,
  PRIMARY_REF,
  isCompositeProposalData,
  type CompositeProposalData,
} from "../index.js";

/**
 * Unit tests for the composite-proposal approve resolution logic — the pure
 * core of the generalized graph-approve loop in proposals.ts (which is
 * human-gated and DB-backed, so its logic is extracted here to be testable).
 */
describe("registerEntityRef + resolveCompositeRef", () => {
  it("maps $opN, op ref, and $primary (first only) to the real id", () => {
    const map: Record<string, string> = {};
    // op index 0, ref "t1", first entity
    registerEntityRef(map, 0, "t1", "real-A", true);
    // op index 2, ref "t2", not first
    registerEntityRef(map, 2, "t2", "real-B", false);

    // positional handles
    expect(resolveCompositeRef(map, "$op0")).toBe("real-A");
    expect(resolveCompositeRef(map, "$op2")).toBe("real-B");
    // op refs
    expect(resolveCompositeRef(map, "t1")).toBe("real-A");
    expect(resolveCompositeRef(map, "t2")).toBe("real-B");
    // $primary only points at the FIRST entity
    expect(resolveCompositeRef(map, PRIMARY_REF)).toBe("real-A");
  });

  it("treats an unknown ref as an existing entity UUID (pass-through)", () => {
    const map: Record<string, string> = {};
    registerEntityRef(map, 0, "t1", "real-A", true);
    // a real UUID that isn't an in-proposal ref → returned as-is (link to
    // pre-existing data)
    const existing = "11111111-2222-3333-4444-555555555555";
    expect(resolveCompositeRef(map, existing)).toBe(existing);
  });

  it("handles entity ops without an explicit ref (positional still works)", () => {
    const map: Record<string, string> = {};
    registerEntityRef(map, 0, undefined, "real-A", true);
    expect(resolveCompositeRef(map, "$op0")).toBe("real-A");
    expect(resolveCompositeRef(map, PRIMARY_REF)).toBe("real-A");
  });

  it("end-to-end: resolves a 2-entity + 2-relation graph correctly", () => {
    // Mirrors what /import/analyze produces: t1↔t2 cross-links.
    const data: CompositeProposalData = {
      operations: [
        {
          op: "create_entity",
          ref: "t1",
          profileSlug: "project",
          title: "Alpha",
        },
        { op: "create_entity", ref: "t2", profileSlug: "person", title: "Bob" },
        {
          op: "create_relation",
          type: "references",
          sourceRef: "t1",
          targetRef: "t2",
        },
        {
          op: "create_relation",
          type: "references",
          sourceRef: "t2",
          targetRef: "t1",
        },
      ],
    };
    expect(isCompositeProposalData(data)).toBe(true);

    // simulate pass 1 (create entities → ids)
    const map: Record<string, string> = {};
    const ids = ["id-alpha", "id-bob"];
    let primarySeen = false;
    let e = 0;
    data.operations.forEach((op, i) => {
      if (op.op !== "create_entity") return;
      registerEntityRef(map, i, op.ref, ids[e++], !primarySeen);
      primarySeen = true;
    });

    // simulate pass 2 (resolve relations)
    const rels = data.operations
      .filter((o) => o.op === "create_relation")
      .map((o) => ({
        source: resolveCompositeRef(
          map,
          (o as { sourceRef: string }).sourceRef
        ),
        target: resolveCompositeRef(
          map,
          (o as { targetRef: string }).targetRef
        ),
      }));

    expect(rels).toEqual([
      { source: "id-alpha", target: "id-bob" },
      { source: "id-bob", target: "id-alpha" },
    ]);
  });
});
