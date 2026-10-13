/**
 * An AGENT handing a session to ANOTHER agent — `focus_session.assign_agent`
 * (founder, 2026-10-12: "if not overridden, ask for approval for non-cancelable
 * actions").
 *
 * The rule, at the engine:
 *  - it PROPOSES by default (it is not on the auto-approve list, so rung 9);
 *  - a `governance_rules` row that resolves `auto` for it (rung 2.8) EXECUTES —
 *    the override the decision names; nothing floors it above the rules store;
 *  - the pod's `@reversible` class row cannot widen it: the door is classed
 *    `disruptive`.
 *
 * The doors that ASK this question (an agent adding someone other than itself)
 * are pinned in `api/src/services/focus-sessions/__tests__/agent-hand-off.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_AUTO_APPROVE,
  agentHasCapability,
  grantRequestKey,
  GATE_WRITE_DOORS,
  decideAgentPolicy,
  isAutoApproved,
  isReversibleWrite,
  nonWidenableFloorFor,
  requiredPermissionFor,
} from "./index.js";

const pair = { subjectType: "focus_session", action: "assign_agent" } as const;

describe("focus_session.assign_agent — an agent handing work to another agent", () => {
  it("is a declared gate door, a write", () => {
    expect(Object.keys(GATE_WRITE_DOORS)).toContain("focus_session/assign_agent");
    expect(requiredPermissionFor("assign_agent")).toBe("write");
  });

  it("proposes by default — while an ordinary session update auto-applies", () => {
    expect(isAutoApproved("focus_session.assign_agent", undefined)).toBe(false);
    expect(DEFAULT_AUTO_APPROVE).not.toContain("focus_session.assign_agent");
    expect(decideAgentPolicy({ ...pair }).verdict).toBe("propose");
    // CONTROL: the same subject's plain update is auto — the difference is the
    // door, not the subject.
    expect(
      decideAgentPolicy({ subjectType: "focus_session", action: "update" })
        .verdict
    ).toBe("execute");
  });

  it("an `auto` governance rule overrides it", () => {
    expect(
      decideAgentPolicy({
        ...pair,
        governanceRuleVerdict: "auto",
        governanceRuleId: "rule-hand-off",
      })
    ).toEqual({ verdict: "execute", governanceRuleId: "rule-hand-off" });
    expect(nonWidenableFloorFor("focus_session.assign_agent")).toBeNull();
  });

  it("is GRANTED as a session update: a key that may update a session may ask to hand it on", () => {
    expect(grantRequestKey("focus_session", "assign_agent")).toEqual({
      subject: "session",
      action: "update",
    });
    expect(
      agentHasCapability(
        "focus_session.assign_agent",
        "focus_session",
        ["session.update"]
      )
    ).toBe(true);
    expect(
      agentHasCapability("focus_session.assign_agent", "focus_session", [
        "session.read",
      ])
    ).toBe(false);
  });

  it("is not reversible, so the `@reversible` class row never covers it", () => {
    expect(isReversibleWrite("focus_session.assign_agent")).toBe(false);
    expect(isReversibleWrite("focus_session.update")).toBe(true);
  });
});
