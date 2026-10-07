/**
 * The proposal types a playbook stage may WAIT FOR (`AWAITED_GATE_PROPOSAL_TYPES`,
 * @synap/playbooks — dependency-free, so it mirrors the strings) are exactly the
 * dev approval types this package files, and each has the approve executor that
 * advances the session past the waiting stage. A type in the set with no
 * executor would leave a stage waiting for an approval nothing applies.
 */
import { describe, it, expect } from "vitest";
import { AWAITED_GATE_PROPOSAL_TYPES } from "@synap/playbooks";
import {
  DEV_DEPLOY_APPROVAL_TYPE,
  DEV_PLAN_APPROVAL_TYPE,
  stageAfterDevGate,
} from "./dev-approval.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";
import { registerDevApprovalExecutors } from "../../routers/proposals/executors/dev-approval.js";

describe("awaited gate types === the dev approval types, each executable", () => {
  it("the mirror matches the api constants", () => {
    expect([...AWAITED_GATE_PROPOSAL_TYPES].sort()).toEqual(
      [DEV_PLAN_APPROVAL_TYPE, DEV_DEPLOY_APPROVAL_TYPE].sort()
    );
  });

  it("every awaited type has a registered focus_session approve executor", () => {
    proposalExecRegistry._reset();
    registerDevApprovalExecutors();
    for (const type of AWAITED_GATE_PROPOSAL_TYPES) {
      expect(
        proposalExecRegistry.resolveExact(`focus_session/${type}`),
        type
      ).toBeTruthy();
    }
    proposalExecRegistry._reset();
  });

  it("stageAfterDevGate reads the same rule: the stage after the one waiting for it", () => {
    const stages = [
      { key: "intake" },
      { key: "plan", gate: { proposalType: DEV_PLAN_APPROVAL_TYPE } },
      { key: "build" },
      {
        key: "ship",
        gate: { kind: "human", capability: DEV_DEPLOY_APPROVAL_TYPE },
      },
      { key: "done" },
    ];
    expect(stageAfterDevGate(stages, DEV_PLAN_APPROVAL_TYPE)).toBe("build");
    expect(stageAfterDevGate(stages, DEV_DEPLOY_APPROVAL_TYPE)).toBe("done");
    // A human stage-gate is not a wait for a dev approval.
    expect(
      stageAfterDevGate(
        [{ key: "a", gate: { kind: "human" } }, { key: "b" }],
        DEV_PLAN_APPROVAL_TYPE
      )
    ).toBeNull();
  });
});
