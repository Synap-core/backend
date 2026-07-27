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

  // ── Wave 2 (Membership → Visibility) — the pod-shared widening ────────────
  it("shows another POD MEMBER's pod-wide facet (pod-wide IS the share signal)", () => {
    expect(
      isFacetVisibleForLens(
        { workspaceId: null, userId: "someone-else" },
        null,
        viewerId,
        true
      )
    ).toBe(true);
    expect(
      isFacetVisibleForLens(
        { workspaceId: null, userId: "someone-else" },
        "workspace-a",
        viewerId,
        true
      )
    ).toBe(true);
  });

  it("pod membership does NOT widen the WORKSPACE lens — a foreign workspace facet stays hidden", () => {
    expect(
      isFacetVisibleForLens(
        { workspaceId: "workspace-a", userId: "someone-else" },
        "workspace-b",
        viewerId,
        true
      )
    ).toBe(false);
    // …nor does it leak a workspace-scoped facet into the POD lens.
    expect(
      isFacetVisibleForLens(
        { workspaceId: "workspace-a", userId: "someone-else" },
        null,
        viewerId,
        true
      )
    ).toBe(false);
  });
});
