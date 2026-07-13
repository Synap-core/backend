import { describe, expect, it } from "vitest";
import { isFacetVisibleForLens } from "../utils/facet-visibility.js";

describe("isFacetVisibleForLens", () => {
  const viewerId = "viewer";

  it("keeps another user's pod-private facet below the owner floor", () => {
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
});
