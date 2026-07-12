import { describe, it, expect } from "vitest";
import { inheritRelationWorkspaceId } from "../relation-workspace-inherit.js";

const AMBIENT = "amb-ws";
const WS_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("inheritRelationWorkspaceId (D4)", () => {
  it("two pod-wide endpoints → pod-wide edge (NULL)", () => {
    expect(inheritRelationWorkspaceId([null, null], AMBIENT)).toBeNull();
  });

  it("exactly one workspace-scoped endpoint → that endpoint's lens", () => {
    expect(inheritRelationWorkspaceId([WS_A, null], AMBIENT)).toBe(WS_A);
    expect(inheritRelationWorkspaceId([null, WS_A], AMBIENT)).toBe(WS_A);
  });

  it("both scoped & equal → that shared lens", () => {
    expect(inheritRelationWorkspaceId([WS_A, WS_A], AMBIENT)).toBe(WS_A);
  });

  it("both scoped & DIFFERENT → ambient fallback (open edge case)", () => {
    expect(inheritRelationWorkspaceId([WS_A, WS_B], AMBIENT)).toBe(AMBIENT);
  });

  it("endpoints not both loaded → ambient fallback (can't safely infer)", () => {
    expect(inheritRelationWorkspaceId([WS_A], AMBIENT)).toBe(AMBIENT);
    expect(inheritRelationWorkspaceId([], AMBIENT)).toBe(AMBIENT);
    expect(inheritRelationWorkspaceId([null], AMBIENT)).toBe(AMBIENT);
  });
});
