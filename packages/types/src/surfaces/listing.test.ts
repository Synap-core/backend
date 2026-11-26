import { describe, expect, it } from "vitest";
import {
  isAnchorIdShaped,
  isOpenableAnchorKind,
  listedSurfaceRows,
  OPENABLE_ANCHOR_KINDS,
  SURFACE_BODIES,
  surfaceBodyLabel,
  surfaceObjectKind,
  type SurfaceRow,
} from "./index.js";

const row = (
  relation: SurfaceRow["relation"],
  slot?: string
): Pick<SurfaceRow, "relation" | "slot"> => ({ relation, slot });

describe("an object's Surfaces list", () => {
  it("lists neither the body, nor a kind's look, nor the page's own detail look", () => {
    const rows = [
      row("body"),
      row("renders", "detail"),
      row("attached", "detail"),
      row("attached"),
      row("attached", "card"),
      row("pinned"),
      row("session-output"),
    ];
    expect(listedSurfaceRows(rows)).toEqual([
      row("attached"),
      row("attached", "card"),
      row("pinned"),
      row("session-output"),
    ]);
  });

  it("names every body through the vocabulary door, never a raw token", () => {
    expect(SURFACE_BODIES.map((b) => surfaceBodyLabel(b))).toEqual([
      "View",
      "Document",
      "HTML artifact",
      "Bento",
      "Whiteboard",
      "Cell",
      "Site",
      "App",
    ]);
    expect(surfaceBodyLabel("whiteboard", "fr")).toBe("Tableau blanc");
  });

  it("opens each body as the kind it is stored as", () => {
    expect(surfaceObjectKind("html")).toBe("document");
    expect(surfaceObjectKind("bento")).toBe("view");
    expect(surfaceObjectKind("whiteboard")).toBe("view");
    expect(surfaceObjectKind("site")).toBe("project");
    expect(surfaceObjectKind("cell")).toBe("cell");
  });

  it("opens an attached surface on its object's page only for a kind the typed route serves", () => {
    expect(OPENABLE_ANCHOR_KINDS).not.toContain("profile");
    expect(isOpenableAnchorKind("entity")).toBe(true);
    expect(isOpenableAnchorKind("profile")).toBe(false);
  });

  it("takes a uuid anchor id, or a profile's slug", () => {
    expect(isAnchorIdShaped("entity", "not-a-uuid")).toBe(false);
    expect(
      isAnchorIdShaped("entity", "0a061a98-05bb-4def-92e6-2c216145a78d")
    ).toBe(true);
    expect(isAnchorIdShaped("profile", "deal")).toBe(true);
  });
});
