/**
 * Preference-scope guard — "which row applies, and which row does a write hit".
 *
 * The DISCRIMINATING case for the precedence is the one where BOTH rows exist:
 * a test with only one row present passes under "workspace wins", "pod wins",
 * and "whichever is non-null", so it rules nothing out. Every case below is
 * chosen so that at least one candidate rule would get it wrong.
 */
import { describe, it, expect } from "vitest";

import {
  resolveEffectivePrefs,
  shadowingWorkspaceIds,
} from "../preference-scope.js";

interface Row {
  workspaceId: string | null;
  quietHoursStart: string;
}
const pod: Row = { workspaceId: null, quietHoursStart: "22:00" };
const ws: Row = { workspaceId: "ws-1", quietHoursStart: "09:00" };

describe("resolveEffectivePrefs — the reader's precedence, unchanged", () => {
  it("prefers the WORKSPACE row when both exist (the discriminating case)", () => {
    const { row, scope } = resolveEffectivePrefs(pod, ws);
    expect(row).toBe(ws);
    expect(scope).toBe("workspace");
    // Named explicitly: this is the assertion that would fail if writes-go-pod
    // were "reconciled" by also flipping the reader to prefer the pod row —
    // which would silently change what every existing override does.
    expect(row?.quietHoursStart).toBe("09:00");
  });

  it("falls back to the POD row when there is no workspace override", () => {
    // THE DEFECT THIS PINS. `notifCenter.getPrefs` used to read the workspace
    // row ALONE. A founder whose preferences live on the pod-wide row — which
    // is now where every write lands by default — therefore saw them as UNSET
    // in every workspace: a settings screen confidently showing the wrong
    // state, and quiet hours reading as "off" while the pod was enforcing them.
    // Reverting to that behaviour (dropping the podRow branch) makes this go
    // red with `expected null to be { workspaceId: null, … }` — "nothing
    // configured" standing in for a real stored preference.
    const { row, scope } = resolveEffectivePrefs(pod, null);
    expect(row).toBe(pod);
    expect(scope).toBe("pod");
    // Reachability, not shape: assert the stored VALUE arrives, not merely
    // that some row did. A projection that returned an empty row would satisfy
    // the identity check above in a world where `toBe` were `toBeTruthy`.
    expect(row?.quietHoursStart).toBe("22:00");
  });

  it("resolves the workspace row when there is no pod row", () => {
    const { row, scope } = resolveEffectivePrefs(null, ws);
    expect(row).toBe(ws);
    expect(scope).toBe("workspace");
  });

  it("returns null + null scope for 'nothing configured' — not a silent default", () => {
    // Empty ≠ failed: the absence of both rows is reported as an absence, with
    // no invented row standing in for it.
    expect(resolveEffectivePrefs(null, null)).toEqual({
      row: null,
      scope: null,
    });
    expect(resolveEffectivePrefs(undefined, undefined)).toEqual({
      row: null,
      scope: null,
    });
  });
});

describe("shadowingWorkspaceIds — a pod-wide write's honest blind spots", () => {
  it("names every workspace override and excludes the pod-wide row itself", () => {
    expect(
      shadowingWorkspaceIds([
        { workspaceId: null },
        { workspaceId: "ws-1" },
        { workspaceId: "ws-2" },
      ])
    ).toEqual(["ws-1", "ws-2"]);
  });

  it("is empty when the user has only a pod-wide row", () => {
    expect(shadowingWorkspaceIds([{ workspaceId: null }])).toEqual([]);
    expect(shadowingWorkspaceIds([])).toEqual([]);
  });
});
