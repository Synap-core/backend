import { describe, it, expect } from "vitest";
import { lensAffinity, LENS_AFFINITY } from "./lens-signal.js";

const WS = "ws-focus";
const OTHER = "ws-other";
const focus = { workspaceId: WS, projectIds: new Set(["member", "both"]) };

describe("lensAffinity — one signal, checked in order", () => {
  it("orders workspace > home workspace > project > none", () => {
    const inSpace = lensAffinity({ id: "x", workspaceId: WS }, focus);
    const homed = lensAffinity(
      { id: "x", workspaceId: null, homeWorkspaceId: WS },
      focus
    );
    const member = lensAffinity({ id: "member", workspaceId: OTHER }, focus);
    const none = lensAffinity({ id: "x", workspaceId: OTHER }, focus);
    expect(inSpace).toBe(LENS_AFFINITY.workspace);
    expect(homed).toBe(LENS_AFFINITY.homeWorkspace);
    expect(member).toBe(LENS_AFFINITY.project);
    expect(none).toBe(0);
    expect(inSpace).toBeGreaterThan(homed);
    expect(homed).toBeGreaterThan(member);
    expect(member).toBeGreaterThan(none);
  });

  it("the first match decides: a row in the space AND the project scores as in the space", () => {
    expect(lensAffinity({ id: "both", workspaceId: WS }, focus)).toBe(
      LENS_AFFINITY.workspace
    );
  });

  it("a home counts only on a pod-wide row (a row filed elsewhere is not homed here)", () => {
    expect(
      lensAffinity({ id: "x", workspaceId: OTHER, homeWorkspaceId: WS }, focus)
    ).toBe(0);
  });

  it("is 0 with no focus, and bounded to [0, 1]", () => {
    expect(lensAffinity({ id: "x", workspaceId: WS }, null)).toBe(0);
    expect(lensAffinity({ id: "x", workspaceId: WS }, undefined)).toBe(0);
    expect(lensAffinity({ id: "x", workspaceId: WS }, {})).toBe(0);
    for (const v of Object.values(LENS_AFFINITY)) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("a project-only focus reaches project members", () => {
    expect(
      lensAffinity(
        { id: "member", workspaceId: null },
        { projectIds: new Set(["member"]) }
      )
    ).toBe(LENS_AFFINITY.project);
  });
});
