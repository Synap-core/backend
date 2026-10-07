/**
 * `resolveStageGate` — the ONE reader of a stage's entry gate.
 *
 * Two properties matter and neither is obvious:
 *   • a stage stored BEFORE gates existed must resolve to "no gate", never throw
 *     (stages live in jsonb; every reader gets an untyped bag),
 *   • an UNRECOGNISED gate must not fall through to the human path. A gate kind
 *     this pod does not understand means the author asked for a ceremony this
 *     pod cannot perform — treating it as `human` would let the stage pass under
 *     the wrong one, which is worse than not gating at all.
 */

import { describe, it, expect } from "vitest";
import {
  resolveStageGate,
  stageGateProposalType,
  DEFAULT_STAGE_GATE_PROPOSAL_TYPE,
  STAGE_GATE_PROPOSAL_TYPES,
  AWAITED_GATE_PROPOSAL_TYPES,
} from "./index.js";

describe("resolveStageGate", () => {
  it("a stage with no gate resolves to undefined — the pre-gate default", () => {
    expect(
      resolveStageGate({ key: "qualify", name: "Qualify" })
    ).toBeUndefined();
    expect(resolveStageGate({})).toBeUndefined();
    expect(resolveStageGate(null)).toBeUndefined();
    expect(resolveStageGate(undefined)).toBeUndefined();
  });

  it("reads a human gate", () => {
    expect(resolveStageGate({ gate: { kind: "human" } })).toEqual({
      kind: "human",
    });
  });

  it("an unknown gate kind is NOT treated as human", () => {
    expect(resolveStageGate({ gate: { kind: "timer" } })).toBeUndefined();
    expect(resolveStageGate({ gate: true })).toBeUndefined();
    expect(resolveStageGate({ gate: "human" })).toBeUndefined();
  });

  it("keeps a registered proposalType and DROPS an unregistered one", () => {
    expect(
      resolveStageGate({
        gate: { kind: "human", proposalType: "playbook.stage_gate" },
      })
    ).toEqual({ kind: "human", proposalType: "playbook.stage_gate" });
    // An unregistered type has no executor: honouring it would file a gate that
    // approves green and never resumes the run. Falling back to the default is
    // the only outcome that keeps the session recoverable.
    expect(
      resolveStageGate({ gate: { kind: "human", proposalType: "made.up" } })
    ).toEqual({ kind: "human" });
  });
});

describe("stageGateProposalType", () => {
  it("defaults to playbook.stage_gate", () => {
    expect(stageGateProposalType({ kind: "human" })).toBe(
      DEFAULT_STAGE_GATE_PROPOSAL_TYPE
    );
  });

  it("every declared type is in the registered set", () => {
    expect(STAGE_GATE_PROPOSAL_TYPES).toContain(
      DEFAULT_STAGE_GATE_PROPOSAL_TYPE
    );
    for (const t of STAGE_GATE_PROPOSAL_TYPES) {
      expect(stageGateProposalType({ kind: "human", proposalType: t })).toBe(t);
    }
  });
});

describe("resolveStageGate — a stage that WAITS FOR a named proposal", () => {
  it("non-vacuity: the awaited set holds the two dev approvals", () => {
    expect([...AWAITED_GATE_PROPOSAL_TYPES].sort()).toEqual([
      "dev.deploy_approval",
      "dev.plan_approval",
    ]);
  });

  it.each([
    [{ proposalType: "dev.plan_approval" }],
    [{ kind: "awaits", proposalType: "dev.plan_approval" }],
    // `kind: "human"` naming an awaited type must NOT become a second, human gate.
    [{ kind: "human", proposalType: "dev.plan_approval" }],
    // The legacy authoring spelling.
    [{ kind: "human", capability: "dev.plan_approval" }],
  ])("%j waits for dev.plan_approval — never a human gate", (gate) => {
    expect(resolveStageGate({ gate })).toEqual({
      kind: "awaits",
      proposalType: "dev.plan_approval",
    });
  });

  it("an unknown named type is NOT awaited (closed set): human stays human, bare stays ungated", () => {
    expect(
      resolveStageGate({ gate: { kind: "human", proposalType: "made.up" } })
    ).toEqual({ kind: "human" });
    expect(
      resolveStageGate({ gate: { proposalType: "made.up" } })
    ).toBeUndefined();
  });

  it("a check gate stays a check gate even when it names a type", () => {
    expect(
      resolveStageGate({
        gate: { kind: "check", proposalType: "dev.plan_approval" },
      })
    ).toEqual({ kind: "check" });
  });
});
