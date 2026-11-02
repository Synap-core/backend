/**
 * The outward floor in the engine (`NAMED_RULE_ONLY_EVENT_KEYS`, finding
 * c173cc51, rung 2.88): a session's tool grant and a capability run execute
 * only when a rule NAMES the write (2.8). Workspace ownership (3) and the
 * auto-approve lists (4, 8) never execute one: an agent granting itself a tool
 * in its own space writes an `auto` grant the gate then honours for every send.
 */
import { describe, it, expect } from "vitest";
import {
  NAMED_RULE_ONLY_EVENT_KEYS,
  decideAgentPolicy,
  nonWidenableFloorFor,
} from "./index.js";

const GRANT = {
  subjectType: "focus_session",
  action: "grant_capability",
} as const;
const RUN = { subjectType: "capability", action: "run" } as const;

describe("named-rule-only writes (the outward floor)", () => {
  it("an agent cannot grant itself a tool in its own space", () => {
    // No reason code: the proposal it gets in a space it does not own (rung 9).
    expect(
      decideAgentPolicy({ ...GRANT, isAgentOwnedWorkspace: true })
    ).toEqual({ verdict: "propose" });
  });

  it("no auto-approve list executes a grant or a run", () => {
    for (const input of [GRANT, RUN]) {
      expect(
        decideAgentPolicy({
          ...input,
          autoApproveFor: ["focus_session.*", "capability.*"],
        }).verdict,
        `${input.subjectType}.${input.action}`
      ).toBe("propose");
    }
    expect(
      decideAgentPolicy({ ...RUN, isAgentOwnedWorkspace: true }).verdict
    ).toBe("propose");
  });

  it("a broad auto rule handed in is not trusted; a rule naming the write executes", () => {
    expect(
      decideAgentPolicy({
        ...GRANT,
        isAgentOwnedWorkspace: true,
        governanceRuleVerdict: "auto",
        governanceRuleNamesWrite: false,
      }).verdict
    ).toBe("propose");
    expect(
      decideAgentPolicy({
        ...GRANT,
        governanceRuleVerdict: "auto",
        governanceRuleId: "rule-exact-grant",
        governanceRuleNamesWrite: true,
      })
    ).toEqual({ verdict: "execute", governanceRuleId: "rule-exact-grant" });
  });

  it("a rule on the exact key can still be stored: no floor refuses it", () => {
    for (const key of NAMED_RULE_ONLY_EVENT_KEYS) {
      expect(nonWidenableFloorFor(key), key).toBeNull();
    }
  });

  it("control: ownership still executes a write that stays in the pod", () => {
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "update",
        isAgentOwnedWorkspace: true,
      }).verdict
    ).toBe("execute");
  });

  it("control: the capability gate's own verdict still decides a run (2.7)", () => {
    expect(
      decideAgentPolicy({ ...RUN, capabilityGovernance: "auto" }).verdict
    ).toBe("execute");
  });
});
