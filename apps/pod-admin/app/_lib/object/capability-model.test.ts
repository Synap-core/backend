import { describe, expect, it } from "vitest";
import {
  capabilityStatusPill,
  mayTurnVerbsOn,
  whoTurnsVerbsOn,
  type CapabilityStatus,
} from "./capability-model";

const WS = "11111111-2222-4333-8444-555555555555";

describe("mayTurnVerbsOn — the pod's own gate, as an offer", () => {
  it("a space's verbs: its owner only", () => {
    expect(
      mayTurnVerbsOn({
        workspaceId: WS,
        roleInSpace: "owner",
        viewerIsPodAdmin: false,
      })
    ).toBe(true);
    for (const roleInSpace of ["admin", "member", "viewer", null, undefined]) {
      expect(
        mayTurnVerbsOn({ workspaceId: WS, roleInSpace, viewerIsPodAdmin: true })
      ).toBe(false);
    }
  });

  it("pod-wide verbs: a pod admin only", () => {
    expect(
      mayTurnVerbsOn({
        workspaceId: null,
        roleInSpace: undefined,
        viewerIsPodAdmin: true,
      })
    ).toBe(true);
    expect(
      mayTurnVerbsOn({
        workspaceId: null,
        roleInSpace: "owner",
        viewerIsPodAdmin: false,
      })
    ).toBe(false);
  });
});

describe("capabilityStatusPill", () => {
  it("reads every state as a pill, an account problem as down", () => {
    const all: CapabilityStatus[] = [
      "available",
      "needs_connection",
      "connected",
      "draft",
      "ready",
      "partial",
      "unavailable",
    ];
    for (const s of all) expect(capabilityStatusPill(s).label).toBeTruthy();
    expect(capabilityStatusPill("ready").kind).toBe("healthy");
    expect(capabilityStatusPill("draft").kind).toBe("stale");
    expect(capabilityStatusPill("needs_connection").kind).toBe("down");
  });
});

describe("whoTurnsVerbsOn", () => {
  it("names the space, or the pod", () => {
    expect(whoTurnsVerbsOn("Sales")).toBe(
      "Only an owner of Sales can turn its actions on or off."
    );
    expect(whoTurnsVerbsOn(null)).toMatch(/pod admin/);
  });
});
