/**
 * `bodyPlacementFor` — where a document created as an entity's body is filed
 * (a part follows its whole, founder decision 22226da5). Pure: no database.
 *
 * Rows rule out: the requested space winning over the entity's (the bug), a
 * homed pod-wide entity's body left pod-wide, an un-homed pod-wide entity
 * changing today's behaviour, a silent override (no warning), and a key BOUND
 * to another space filing into the entity's space anyway.
 */
import { describe, it, expect } from "vitest";
import { bodyPlacementFor, withPlacementWarning } from "./body-placement.js";

const W = "11111111-1111-4111-8111-111111111111";
const X = "22222222-2222-4222-8222-222222222222";
const H = "33333333-3333-4333-8333-333333333333";
const E = "44444444-4444-4444-8444-444444444444";

describe("bodyPlacementFor", () => {
  it("an entity in a space: the body goes there, whatever was requested", () => {
    expect(
      bodyPlacementFor({ id: E, workspaceId: W, homeWorkspaceId: null }, null)
    ).toEqual({ workspaceId: W });
    expect(
      bodyPlacementFor(
        { id: E, workspaceId: W, homeWorkspaceId: null },
        undefined
      )
    ).toEqual({ workspaceId: W });
  });

  it("a different requested space is not honoured, and the receipt says so", () => {
    const placed = bodyPlacementFor(
      { id: E, workspaceId: W, homeWorkspaceId: null },
      X
    );
    expect(placed.workspaceId).toBe(W);
    expect(placed.warning).toContain(W);
    expect(placed.warning).toContain(X);
  });

  it("a pod-wide entity filed for a space: the body goes to that space", () => {
    expect(
      bodyPlacementFor({ id: E, workspaceId: null, homeWorkspaceId: H }, null)
    ).toEqual({ workspaceId: H });
  });

  it("a pod-wide entity with no home keeps today's placement (the requested space, or none)", () => {
    expect(
      bodyPlacementFor({ id: E, workspaceId: null, homeWorkspaceId: null }, X)
    ).toEqual({ workspaceId: X });
    expect(
      bodyPlacementFor(
        { id: E, workspaceId: null, homeWorkspaceId: null },
        undefined
      )
    ).toEqual({ workspaceId: null });
  });

  it("a key bound to another space is refused; one bound to the entity's space files there", () => {
    expect(() =>
      bodyPlacementFor({ id: E, workspaceId: W, homeWorkspaceId: null }, X, {
        keyType: "service",
        keyWorkspaceId: X,
      })
    ).toThrow(/confined/);
    expect(
      bodyPlacementFor({ id: E, workspaceId: W, homeWorkspaceId: null }, W, {
        keyType: "service",
        keyWorkspaceId: W,
      })
    ).toEqual({ workspaceId: W });
  });
});

describe("withPlacementWarning", () => {
  it("appends to the receipt's warnings, and leaves a receipt alone when there is none", () => {
    expect(
      withPlacementWarning(
        { status: "created", warnings: ["a"] },
        { workspaceId: W, warning: "b" }
      )
    ).toEqual({ status: "created", warnings: ["a", "b"] });
    const receipt = { status: "created" };
    expect(withPlacementWarning(receipt, { workspaceId: W })).toBe(receipt);
    expect(withPlacementWarning(receipt, undefined)).toBe(receipt);
  });
});
