import { describe, expect, it } from "vitest";
import type { PackageUpdateSummary } from "./contract";
import {
  groupUpdates,
  updateGroupOf,
  updateHolds,
  updatesNeedingNothing,
  waitingUpdates,
  type TemplateHealthHold,
} from "./updates-model";

const ZERO = { updates: 0, yours: 0, both: 0, same: 0 };

function summary(over: Partial<PackageUpdateSummary>): PackageUpdateSummary {
  return {
    slug: "builder-workspace",
    kind: "workspace",
    comparedBy: "package",
    name: "Builder",
    installedVersion: "h-1",
    latestVersion: "h-2",
    counts: { ...ZERO },
    dataChanges: 0,
    needs: "review",
    reviewUrl: "/open/update/builder-workspace",
    ...over,
  };
}

function health(over: Partial<TemplateHealthHold>): TemplateHealthHold {
  return {
    packageSlug: "builder-workspace",
    state: "active",
    awaitingApproval: [],
    pendingDataChanges: null,
    updateProposal: null,
    ...over,
  };
}

describe("an update held on a person is not 'Ready'", () => {
  it("waits for approval while the pod says awaiting-approval with live proposals", () => {
    const holds = updateHolds([
      health({ state: "awaiting-approval", awaitingApproval: ["p1"] }),
    ]);
    expect(updateGroupOf(summary({}), holds)).toBe("approval");
    expect(groupUpdates([summary({})], holds).groups[0]?.group).toBe(
      "approval"
    );
    // Counted as waiting, never offered in the batch.
    expect(waitingUpdates([summary({})], holds)).toHaveLength(1);
    expect(updatesNeedingNothing([summary({})], holds)).toHaveLength(0);
  });

  it("an awaiting state with nothing left pending is not a hold", () => {
    const holds = updateHolds([
      health({ state: "awaiting-approval", awaitingApproval: [] }),
    ]);
    expect(updateGroupOf(summary({}), holds)).toBe("review");
  });

  it("a stale awaitingApproval list under another state is not a hold", () => {
    const holds = updateHolds([
      health({ state: "layer-2-not-run", awaitingApproval: ["p1"] }),
    ]);
    expect(holds.size).toBe(0);
  });

  it("pending data changes need the person's OK, ahead of approval", () => {
    const holds = updateHolds([
      health({
        state: "awaiting-approval",
        awaitingApproval: ["p1"],
        pendingDataChanges: { count: 1, sentences: ["x"] },
      }),
    ]);
    expect(updateGroupOf(summary({}), holds)).toBe("consent");
  });

  it("an agent's update request lists its proposal", () => {
    const holds = updateHolds([health({ updateProposal: { id: "p9" } })]);
    expect(holds.get("builder-workspace")?.proposalIds).toEqual(["p9"]);
    expect(updateGroupOf(summary({}), holds)).toBe("approval");
  });

  it("lists each proposal once", () => {
    const holds = updateHolds([
      health({
        state: "awaiting-approval",
        awaitingApproval: ["p1", "p2"],
        updateProposal: { id: "p2" },
      }),
    ]);
    expect(holds.get("builder-workspace")?.proposalIds).toEqual(["p1", "p2"]);
  });

  it("with no hold the pod's needs stand", () => {
    expect(updateGroupOf(summary({}), updateHolds([health({})]))).toBe(
      "review"
    );
    expect(updateGroupOf(summary({}))).toBe("review");
  });
});
