/**
 * D7 TRUSTED-ISSUER SCOPE FLOOR — the owner's consent to a wider Control
 * Plane grant is ALWAYS a person's decision.
 *
 * `trusted_issuer.widen_scopes` is filed directly at boot (never through the
 * gate), so this floor is defence in depth for the day it is routed through
 * `decideAgentPolicy`, AND the live reason `governanceRules.create` refuses a
 * rule for it (`nonWidenableFloorFor`). It sits on the HUMAN GATE rung: no
 * rule, list, ownership or twin rung below can resolve it to execute.
 *
 * Each widener is paired with a CONTROL write the same widener really does
 * execute, so a green row is the floor at work, not an inert input.
 */
import { describe, it, expect } from "vitest";
import {
  DIRECT_PROPOSAL_DOORS,
  HUMAN_GATE_EVENT_KEYS,
  decideAgentPolicy,
  nonWidenableFloorFor,
} from "./index.js";

/** subject + verb — what a gate or a rule built from the proposal composes. */
const KEY = "trusted_issuer.widen_scopes";
/** `${targetType}.${proposalType}` of the direct door (dotted proposalType). */
const DOOR_KEY = "trusted_issuer.trusted_issuer.widen_scopes";

const WIDENERS: Array<[string, Parameters<typeof decideAgentPolicy>[0]]> = [
  [
    "a rung-2.8 governance rule says auto",
    { subjectType: "", action: "", governanceRuleVerdict: "auto" },
  ],
  [
    "autoApproveFor names it (rung 4)",
    {
      subjectType: "",
      action: "",
      autoApproveFor: ["*.*", "trusted_issuer.*", KEY, "entity.*"],
    },
  ],
  [
    "the agent owns the workspace (rung 3)",
    { subjectType: "", action: "", isAgentOwnedWorkspace: true },
  ],
  [
    "the agent is a twin that writes without proposals",
    { subjectType: "", action: "", writesRequireProposal: false },
  ],
];

describe("trusted_issuer.widen_scopes — a person decides (D7)", () => {
  it("is a declared direct door and a HUMAN GATE under both spellings", () => {
    expect(Object.keys(DIRECT_PROPOSAL_DOORS)).toContain(
      "trusted_issuer/trusted_issuer.widen_scopes"
    );
    expect(HUMAN_GATE_EVENT_KEYS).toContain(KEY);
    expect(HUMAN_GATE_EVENT_KEYS).toContain(DOOR_KEY);
  });

  it.each([KEY, DOOR_KEY])(
    "%s is non-widenable: no rule can resolve it",
    (k) => {
      expect(nonWidenableFloorFor(k)).toBe("HUMAN_GATE");
    }
  );

  it.each(WIDENERS)("an agent proposes when %s", (_label, base) => {
    for (const [subjectType, action] of [
      ["trusted_issuer", "widen_scopes"],
      ["trusted_issuer", "trusted_issuer.widen_scopes"],
    ]) {
      expect(decideAgentPolicy({ ...base, subjectType, action })).toMatchObject(
        { verdict: "propose", reasonCode: "HUMAN_GATE" }
      );
    }
    const control = decideAgentPolicy({
      ...base,
      subjectType: "entity",
      action: "update",
    });
    expect(control.verdict).toBe("execute");
  });
});
