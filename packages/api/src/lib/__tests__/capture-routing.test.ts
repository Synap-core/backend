/**
 * Unit tests for the pure capture-routing decision + shared tunables.
 * These cover the routing "brain" without a DB/IS, so the gate/mode/BYOA/
 * auto-tune behavior is proven automatically rather than by manual dogfooding.
 */

import { describe, it, expect } from "vitest";
import { resolveCaptureRouting } from "../capture-routing.js";
import {
  AUTO_ROUTE_MIN_CONFIDENCE,
  BYOA_DEFAULT_ROUTE_CONFIDENCE,
  BELOW_GATE_CONFIDENCE,
  ROUTE_TUNING_CEIL,
  clampWindowDays,
} from "../routing-tunables.js";

const WS_A = "11111111-1111-1111-1111-111111111111"; // ambient/current
const WS_B = "22222222-2222-2222-2222-222222222222"; // target (member)
const WS_C = "33333333-3333-3333-3333-333333333333"; // target (NON-member)
const members = [WS_A, WS_B];

describe("resolveCaptureRouting — AUTO mode gate", () => {
  it("moves to the target when confidence ≥ gate AND target is a member", () => {
    const r = resolveCaptureRouting({
      mode: "auto",
      aiWorkspaceId: WS_B,
      aiConfidence: 0.9,
      currentWorkspaceId: WS_A,
      memberWorkspaceIds: members,
    });
    expect(r.workspaceId).toBe(WS_B);
    expect(r.movedToWorkspace).toBe(WS_B);
  });

  it("stays put when confidence is BELOW the gate (the below-gate degrade case)", () => {
    const r = resolveCaptureRouting({
      mode: "auto",
      aiWorkspaceId: WS_B,
      aiConfidence: BELOW_GATE_CONFIDENCE, // 0.5 < 0.6
      currentWorkspaceId: WS_A,
      memberWorkspaceIds: members,
    });
    expect(r.workspaceId).toBe(WS_A);
    expect(r.movedToWorkspace).toBeUndefined();
  });

  it("stays put when the target is NOT a member, even at confidence 1.0", () => {
    const r = resolveCaptureRouting({
      mode: "auto",
      aiWorkspaceId: WS_C,
      aiConfidence: 1,
      currentWorkspaceId: WS_A,
      memberWorkspaceIds: members,
    });
    expect(r.workspaceId).toBe(WS_A);
    expect(r.movedToWorkspace).toBeUndefined();
  });

  it("is a no-op when the target equals the current workspace", () => {
    const r = resolveCaptureRouting({
      mode: "auto",
      aiWorkspaceId: WS_A,
      aiConfidence: 1,
      currentWorkspaceId: WS_A,
      memberWorkspaceIds: members,
    });
    expect(r.workspaceId).toBe(WS_A);
    expect(r.movedToWorkspace).toBeUndefined();
  });

  it("is a no-op when there is no target pick", () => {
    const r = resolveCaptureRouting({
      mode: "auto",
      aiWorkspaceId: null,
      aiConfidence: 1,
      currentWorkspaceId: WS_A,
      memberWorkspaceIds: members,
    });
    expect(r.workspaceId).toBe(WS_A);
    expect(r.movedToWorkspace).toBeUndefined();
  });

  it("treats confidence exactly AT the gate as passing", () => {
    const r = resolveCaptureRouting({
      mode: "auto",
      aiWorkspaceId: WS_B,
      aiConfidence: AUTO_ROUTE_MIN_CONFIDENCE, // 0.6 >= 0.6
      currentWorkspaceId: WS_A,
      memberWorkspaceIds: members,
    });
    expect(r.movedToWorkspace).toBe(WS_B);
  });
});

describe("resolveCaptureRouting — BYOA (no self-reported confidence)", () => {
  it("uses the BYOA default (0.7) so an explicit member pick auto-applies", () => {
    expect(BYOA_DEFAULT_ROUTE_CONFIDENCE).toBeGreaterThanOrEqual(
      AUTO_ROUTE_MIN_CONFIDENCE
    );
    const r = resolveCaptureRouting({
      mode: "auto",
      aiWorkspaceId: WS_B,
      aiConfidence: null, // BYOA agent didn't self-report
      currentWorkspaceId: WS_A,
      memberWorkspaceIds: members,
    });
    expect(r.movedToWorkspace).toBe(WS_B);
  });

  it("still gates BYOA on membership (null confidence can't bypass the member check)", () => {
    const r = resolveCaptureRouting({
      mode: "auto",
      aiWorkspaceId: WS_C, // non-member
      aiConfidence: null,
      currentWorkspaceId: WS_A,
      memberWorkspaceIds: members,
    });
    expect(r.movedToWorkspace).toBeUndefined();
  });
});

describe("resolveCaptureRouting — auto-tuned per-workspace gate", () => {
  it("blocks a move that clears the flat floor but not the raised (tuned) gate", () => {
    const r = resolveCaptureRouting({
      mode: "auto",
      aiWorkspaceId: WS_B,
      aiConfidence: 0.65, // > 0.6 flat floor
      minConfidence: 0.85, // but a mis-route-prone workspace raised the bar
      currentWorkspaceId: WS_A,
      memberWorkspaceIds: members,
    });
    expect(r.movedToWorkspace).toBeUndefined();
  });

  it("allows a move that clears the tuned gate", () => {
    const r = resolveCaptureRouting({
      mode: "auto",
      aiWorkspaceId: WS_B,
      aiConfidence: 0.9,
      minConfidence: 0.85,
      currentWorkspaceId: WS_A,
      memberWorkspaceIds: members,
    });
    expect(r.movedToWorkspace).toBe(WS_B);
  });

  it("never tunes below the flat floor (ceil ≥ floor invariant)", () => {
    expect(ROUTE_TUNING_CEIL).toBeGreaterThanOrEqual(AUTO_ROUTE_MIN_CONFIDENCE);
  });
});

describe("resolveCaptureRouting — ASK & LOCKED modes never move", () => {
  it("ASK surfaces a pendingWorkspaceSwitch and stays put", () => {
    const r = resolveCaptureRouting({
      mode: "ask",
      aiWorkspaceId: WS_B,
      aiConfidence: 0.99,
      aiReason: "looks like CRM",
      currentWorkspaceId: WS_A,
      memberWorkspaceIds: members,
    });
    expect(r.workspaceId).toBe(WS_A);
    expect(r.movedToWorkspace).toBeUndefined();
    expect(r.pendingWorkspaceSwitch).toEqual({
      suggestedWorkspaceId: WS_B,
      reason: "looks like CRM",
      confidence: 0.99,
    });
  });

  it("LOCKED never moves and never suggests", () => {
    const r = resolveCaptureRouting({
      mode: "locked",
      aiWorkspaceId: WS_B,
      aiConfidence: 1,
      currentWorkspaceId: WS_A,
      memberWorkspaceIds: members,
    });
    expect(r.workspaceId).toBe(WS_A);
    expect(r.movedToWorkspace).toBeUndefined();
    expect(r.pendingWorkspaceSwitch).toBeUndefined();
  });
});

describe("clampWindowDays", () => {
  it("floors at 1, ceils at 365, defaults undefined to 30", () => {
    expect(clampWindowDays(0)).toBe(1);
    expect(clampWindowDays(-5)).toBe(1);
    expect(clampWindowDays(1_000_000)).toBe(365);
    expect(clampWindowDays(undefined)).toBe(30);
    expect(clampWindowDays(50)).toBe(50);
  });
});

describe("gate-tunable invariants (SSOT)", () => {
  it("BELOW_GATE_CONFIDENCE is strictly below the auto-apply floor", () => {
    expect(BELOW_GATE_CONFIDENCE).toBeLessThan(AUTO_ROUTE_MIN_CONFIDENCE);
  });
});
