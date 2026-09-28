import { describe, expect, it } from "vitest";
import { isFacetVisibleForLens } from "../utils/facet-visibility.js";

describe("isFacetVisibleForLens", () => {
  const viewerId = "viewer";

  it("keeps another user's pod-private facet below the owner floor (viewer is NOT a pod member — the default, fail closed)", () => {
    expect(
      isFacetVisibleForLens(
        { workspaceId: null, userId: "someone-else" },
        null,
        viewerId
      )
    ).toBe(false);
    expect(
      isFacetVisibleForLens(
        { workspaceId: null, userId: "someone-else" },
        "workspace-a",
        viewerId
      )
    ).toBe(false);
  });

  it("shows the viewer's pod facet at pod and workspace lenses", () => {
    expect(
      isFacetVisibleForLens(
        { workspaceId: null, userId: viewerId },
        null,
        viewerId
      )
    ).toBe(true);
    expect(
      isFacetVisibleForLens(
        { workspaceId: null, userId: viewerId },
        "workspace-a",
        viewerId
      )
    ).toBe(true);
  });

  it("shows workspace facets only through their matching lens", () => {
    expect(
      isFacetVisibleForLens(
        { workspaceId: "workspace-a", userId: "someone-else" },
        "workspace-a",
        viewerId
      )
    ).toBe(true);
    expect(
      isFacetVisibleForLens(
        { workspaceId: "workspace-a", userId: viewerId },
        "workspace-b",
        viewerId
      )
    ).toBe(false);
  });

  // ── Decision B (2026-09-27) — shared only via a role granted to my space ──
  const SHARED = new Set(["role-client"]);
  it("shows another user's pod-wide facet ONLY when its role is shared with the viewer", () => {
    const facet = {
      workspaceId: null,
      userId: "someone-else",
      profileId: "role-client",
    };
    expect(isFacetVisibleForLens(facet, null, viewerId, SHARED)).toBe(true);
    expect(isFacetVisibleForLens(facet, "workspace-a", viewerId, SHARED)).toBe(
      true
    );
    // Pod membership alone (no granted role) shares nothing.
    expect(isFacetVisibleForLens(facet, null, viewerId, new Set())).toBe(false);
    // A role NOT granted to the viewer's spaces stays hidden.
    expect(
      isFacetVisibleForLens(
        { ...facet, profileId: "role-other" },
        null,
        viewerId,
        SHARED
      )
    ).toBe(false);
  });

  it("pod membership does NOT widen the WORKSPACE lens — a foreign workspace facet stays hidden", () => {
    expect(
      isFacetVisibleForLens(
        { workspaceId: "workspace-a", userId: "someone-else" },
        "workspace-b",
        viewerId,
        new Set(["role-client"])
      )
    ).toBe(false);
    // …nor does it leak a workspace-scoped facet into the POD lens.
    expect(
      isFacetVisibleForLens(
        { workspaceId: "workspace-a", userId: "someone-else" },
        null,
        viewerId,
        new Set(["role-client"])
      )
    ).toBe(false);
  });
});
