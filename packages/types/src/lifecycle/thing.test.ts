import { describe, expect, it } from "vitest";
import {
  kindCurrentStatus,
  thingStatusStrips,
  UNCLASSIFIED_STATUS,
  type ThingLifecycle,
  type ThingLifecycleRead,
} from "./index.js";
import { resolveStatusLabel } from "../vocabulary/index.js";

const deal: ThingLifecycle = {
  property: "commercialStage",
  options: [
    { key: "lead", label: "Lead", category: "open" },
    { key: "proposal", category: "active" },
    { key: "won", label: "Won", category: "done" },
    { key: "lost", label: "Lost", category: "lost" },
  ],
};
const client: ThingLifecycle = {
  property: "status",
  options: [
    { key: "active", label: "Active", category: "active" },
    { key: "churned", label: "Churned", category: "lost" },
  ],
};
const ok = (lifecycle: ThingLifecycle): ThingLifecycleRead => ({
  status: "ok",
  lifecycle,
});

describe("kindCurrentStatus (W18: the column is the store)", () => {
  it("reads the status column first, even when the projection disagrees", () => {
    expect(
      kindCurrentStatus("won", { commercialStage: "lead" }, "commercialStage")
    ).toBe("won");
  });
  it("falls back to the projection when the column is empty", () => {
    expect(
      kindCurrentStatus(null, { commercialStage: "lead" }, "commercialStage")
    ).toBe("lead");
    expect(kindCurrentStatus("  ", {}, "commercialStage")).toBeNull();
  });
});

describe("thingStatusStrips", () => {
  it("kind first, then roles; each strip stands where its store says", () => {
    const strips = thingStatusStrips({
      entityId: "e1",
      profileSlug: "deal",
      status: "proposal",
      properties: { commercialStage: "lead" },
      roles: [{ slug: "client", facetId: "f1", label: "", status: "active" }],
      reads: { deal: ok(deal), client: ok(client) },
    });
    expect(strips.map((s) => s.key)).toEqual(["kind:deal", "role:f1"]);
    const [kind, role] = strips;
    if (kind?.state !== "ready" || role?.state !== "ready") throw new Error();
    expect(kind.from).toBe("proposal");
    expect(kind.subject).toEqual({
      kind: "kind",
      entityId: "e1",
      property: "commercialStage",
    });
    expect(kind.steps.find((s) => s.position === "current")?.key).toBe(
      "proposal"
    );
    expect(kind.labelOf("proposal")).toBe(resolveStatusLabel("proposal"));
    expect(role.from).toBe("active");
    expect(role.label).toBe("Client");
    expect(role.subject).toEqual({ kind: "role", entityId: "e1", facetId: "f1" });
  });

  it("a failed read is a failed strip; undeclared, loading and option-less are omitted", () => {
    const strips = thingStatusStrips({
      entityId: "e1",
      profileSlug: "deal",
      roles: [
        { slug: "client", facetId: "f1", status: null },
        { slug: "partner", facetId: "f2", status: null },
        { slug: "investor", facetId: "f3", status: null },
      ],
      reads: {
        deal: { status: "failed" },
        client: { status: "undeclared" },
        partner: { status: "loading" },
        investor: ok({ property: "stage", options: [] }),
      },
    });
    expect(strips).toEqual([
      {
        key: "kind:deal",
        slug: "deal",
        of: "kind",
        label: "Deal",
        state: "failed",
      },
    ]);
  });

  it("a role with no facet id draws but cannot be moved; showKind:false drops the kind", () => {
    const strips = thingStatusStrips({
      entityId: "e1",
      profileSlug: "deal",
      showKind: false,
      roles: [{ slug: "client", facetId: null, label: "Customer", status: "churned" }],
      reads: { deal: ok(deal), client: ok(client) },
    });
    expect(strips).toHaveLength(1);
    const [role] = strips;
    if (role?.state !== "ready") throw new Error();
    expect(role.subject).toBeNull();
    expect(role.label).toBe("Customer");
    expect(role.steps.find((s) => s.position === "off")?.key).toBe("churned");
  });
});

describe("UNCLASSIFIED_STATUS", () => {
  it("has its own words in the vocabulary (never a humanized key)", () => {
    expect(resolveStatusLabel(UNCLASSIFIED_STATUS)).toBe(
      "Not a declared status"
    );
  });
});
