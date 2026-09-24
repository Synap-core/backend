/**
 * The destination rule. Each row is chosen to rule out a plausible WRONG rule:
 * - deterministic placement is pinned (rules out "demote to a hint");
 * - headless never applies the suggestion (rules out "silent move");
 * - interactive untouched applies it (rules out "UI says X, lands elsewhere");
 * - remove pins the non-AI destination (rules out "remove = pod-wide");
 * - choosing the suggestion itself counts as accepted, not changed.
 */
import { describe, it, expect } from "vitest";
import {
  deriveCaptureProjectOutcome,
  deriveWorkspacePlacementView,
  type CapturePlacement,
} from "./capture-routing-types.js";

const ALTS = [
  { workspaceId: "crm", workspaceName: "CRM", weight: 0.8 },
  { workspaceId: "fin", workspaceName: "Finance", weight: 0.15 },
];
const AMBIENT_WITH_SUGGESTION: CapturePlacement = {
  workspaceId: "home",
  workspaceName: "Home",
  deterministic: false,
  suggestion: {
    workspaceId: "crm",
    workspaceName: "CRM",
    reason: "Fits CRM best",
    alternatives: ALTS,
  },
};
const DETERMINISTIC: CapturePlacement = {
  workspaceId: "eng",
  workspaceName: "Engineering",
  deterministic: true,
};
const I = { interactive: true };
const H = { interactive: false };

describe("deriveWorkspacePlacementView", () => {
  it("deterministic placement is sent as an explicit placement, on every door", () => {
    for (const opts of [I, H]) {
      const v = deriveWorkspacePlacementView(
        DETERMINISTIC,
        { kind: "default" },
        opts
      );
      expect(v.destination.workspaceId).toBe("eng");
      expect(v.aiSuggested).toBe(false);
      expect(v.execute).toEqual({ targetWorkspaceId: "eng" });
    }
  });

  it("interactive + untouched: the suggestion is the destination, saving accepts it", () => {
    const v = deriveWorkspacePlacementView(
      AMBIENT_WITH_SUGGESTION,
      { kind: "default" },
      I
    );
    expect(v.destination).toEqual({ workspaceId: "crm", workspaceName: "CRM" });
    expect(v.aiSuggested).toBe(true);
    expect(v.canRemove).toBe(true);
    expect(v.alternatives).toBe(ALTS);
    expect(v.execute).toEqual({
      targetWorkspaceId: "crm",
      workspaceChoice: "accepted",
    });
  });

  it("headless never applies the suggestion — it stays a proposal", () => {
    const v = deriveWorkspacePlacementView(
      AMBIENT_WITH_SUGGESTION,
      { kind: "default" },
      H
    );
    expect(v.destination.workspaceId).toBe("home");
    expect(v.aiSuggested).toBe(false);
    expect(v.execute).toEqual({ workspaceChoice: "ignored" });
  });

  it("remove keeps it where it would have landed, explicitly", () => {
    const v = deriveWorkspacePlacementView(
      AMBIENT_WITH_SUGGESTION,
      { kind: "removed" },
      I
    );
    expect(v.destination.workspaceId).toBe("home");
    expect(v.aiSuggested).toBe(false);
    expect(v.execute).toEqual({
      targetWorkspaceId: "home",
      workspaceChoice: "removed",
    });
  });

  it("choosing another workspace is a change; choosing the suggestion is an accept", () => {
    const changed = deriveWorkspacePlacementView(
      AMBIENT_WITH_SUGGESTION,
      { kind: "chosen", workspaceId: "fin", workspaceName: "Finance" },
      I
    );
    expect(changed.execute).toEqual({
      targetWorkspaceId: "fin",
      workspaceChoice: "changed",
    });
    const same = deriveWorkspacePlacementView(
      AMBIENT_WITH_SUGGESTION,
      { kind: "chosen", workspaceId: "crm", workspaceName: "CRM" },
      H
    );
    expect(same.execute).toEqual({
      targetWorkspaceId: "crm",
      workspaceChoice: "accepted",
    });
  });

  it("a chosen workspace with no AI suggestion records no AI choice", () => {
    const v = deriveWorkspacePlacementView(
      DETERMINISTIC,
      { kind: "chosen", workspaceId: "fin", workspaceName: "Finance" },
      I
    );
    expect(v.execute).toEqual({ targetWorkspaceId: "fin" });
  });

  it("no placement block (older pod) claims nothing", () => {
    const v = deriveWorkspacePlacementView(undefined, { kind: "default" }, I);
    expect(v.destination.workspaceId).toBeNull();
    expect(v.execute).toEqual({});
  });
});

/**
 * The project-outcome rule. Each row rules out a plausible WRONG rule:
 * - zero candidates ⇒ `not_offered` EVEN IF the model volunteered a reason
 *   (rules out "reason present ⇒ declined", which would report a judgement
 *   about a candidate set that did not exist);
 * - candidates + silence ⇒ `unstated` (rules out "null ⇒ not_offered", the
 *   collapse the discriminator exists to undo);
 * - a picked id ⇒ `selected`, never `declined` (rules out "reason ⇒ declined");
 * - a whitespace-only reason is silence (rules out a truthy-string test).
 *
 * The SEAM — that the capture door passes the right arguments here — is pinned
 * separately in `api/src/routers/__tests__/capture.project-outcome.test.ts`;
 * this file cannot see a wrong argument.
 */
describe("deriveCaptureProjectOutcome", () => {
  it.each([
    ["no candidates, silence", 0, null, null, "not_offered"],
    [
      "no candidates, but a reason anyway",
      0,
      null,
      "nothing to match",
      "not_offered",
    ],
    ["candidates, silence", 4, null, null, "unstated"],
    ["candidates, whitespace-only reason", 4, null, "   ", "unstated"],
    ["candidates, a real reason", 4, null, "no initiative fits", "declined"],
    [
      "candidates, a pick with a reason",
      4,
      "p1",
      "it is about the launch",
      "selected",
    ],
    ["candidates, a pick with no reason", 4, "p1", null, "selected"],
  ] as const)("%s ⇒ %s", (_label, count, id, reason, expected) => {
    expect(
      deriveCaptureProjectOutcome({
        availableProjectCount: count,
        targetProjectId: id,
        targetProjectReason: reason,
      })
    ).toBe(expected);
  });
});
