import { describe, it, expect } from "vitest";
import {
  ADMIN_ACTIONS,
  AGENT_SCHEMA_DEFINITION_EVENT_KEYS,
  AGENT_STRUCTURE_WRITE_EVENT_KEYS,
  ARBITRARY_EXECUTION_EVENT_KEYS,
  DESTRUCTIVE_ACTIONS,
  HUMAN_GATE_EVENT_KEYS,
  PROPOSE_REASON,
  decideAgentPolicy,
  isReversibleWrite,
  type AgentPolicyInput,
} from "./index.js";
// Cross-package SOURCE import, test-only: `@synap-core/types` cannot import the
// engine, so the trust ladder MIRRORS the reason-code reach and this file is
// its tripwire (the `non-widenable-floor.test.ts` precedent).
import {
  GOVERNANCE_REASON_RULE_REACH,
  ruleCanReachReason,
} from "../../types/src/trust-ladder/index.js";

/**
 * TRIPWIRE — the trust ladder's "can an `auto` rule reach this proposal?"
 * table (`GOVERNANCE_REASON_RULE_REACH`) must agree with the ENGINE.
 *
 * For every reason code the engine can emit, a fixture drives
 * `decideAgentPolicy` to exactly that code, then re-runs it with a rung-2.8
 * `auto` verdict. A code the ladder calls `rule`/`below` MUST flip to execute;
 * a code it calls `floor` must NOT — with one stated exception below. A next
 * rung offered on a `floor` item would store a rule that never fires, or worse,
 * one that widens past a floor if the engine ever reordered.
 *
 * DERIVED, not hand-listed: the fixture table is keyed by `PROPOSE_REASON`
 * and the first test asserts its key set EQUALS the engine's, so a new reason
 * code fails here until it has a fixture AND a classification.
 *
 * WHAT IT DOES NOT COVER: a code the engine emits at TWO rungs (`CHANNEL_PROPOSE`
 * at 2.7x and 7) is classified `ambiguous` and never offered; only one of its
 * sites is driven here. `AGENT_OWNED_DESTRUCTIVE` is only reachable with the
 * raw `allowDestructiveAutoApprove` opt-in (2.5 returns first otherwise); a
 * rule WOULD flip it, so it is classified `floor` as "never offered" — and its
 * action is destructive, which the reversibility input excludes as well.
 */

const key = (k: string) => {
  const dot = k.lastIndexOf(".");
  return { subjectType: k.slice(0, dot), action: k.slice(dot + 1) };
};

const FIXTURES: Record<keyof typeof PROPOSE_REASON, AgentPolicyInput> = {
  ADMIN: key(ADMIN_ACTIONS.find((k) => k.includes("."))!),
  HUMAN_GATE: key(HUMAN_GATE_EVENT_KEYS[0]!),
  ARBITRARY_EXECUTION: key(ARBITRARY_EXECUTION_EVENT_KEYS[0]!),
  POD_ADMIN_SCHEMA_CHANGE: {
    subjectType: "property_def",
    action: "create",
    podAdminSchemaChange: true,
  },
  AGENT_SCHEMA_DEFINITION: key(AGENT_SCHEMA_DEFINITION_EVENT_KEYS[0]!),
  AGENT_STRUCTURE_WRITE: key(AGENT_STRUCTURE_WRITE_EVENT_KEYS[0]!),
  SCOPE_IDENTITY_CHANGE: {
    subjectType: "entity",
    action: "update",
    forcePropose: true,
  },
  DESTRUCTIVE_HARD_FLOOR: {
    subjectType: "entity",
    action: DESTRUCTIVE_ACTIONS[0]!,
  },
  UNTRUSTED_ORIGIN: {
    subjectType: "entity",
    action: "update",
    originTrust: "untrusted",
  },
  DAILY_WRITE_CEILING: {
    subjectType: "entity",
    action: "update",
    ceilingVerdict: "propose",
  },
  USER_OBSERVATION_INFERENCE: {
    subjectType: "entity",
    action: "create",
    subjectProfileSlug: "user_observation",
  },
  CAPABILITY_PROPOSE: {
    subjectType: "capability",
    action: "run",
    capabilityGovernance: "propose",
  },
  GOVERNANCE_RULE: {
    subjectType: "entity",
    action: "update",
    governanceRuleVerdict: "propose",
  },
  AGENT_OWNED_DESTRUCTIVE: {
    subjectType: "entity",
    action: DESTRUCTIVE_ACTIONS[0]!,
    governanceMode: "agent-owned",
    allowDestructiveAutoApprove: true,
  },
  WRITES_REQUIRE_PROPOSAL: {
    subjectType: "entity",
    action: "update",
    writesRequireProposal: true,
  },
  CHANNEL_PROPOSE: {
    subjectType: "entity",
    action: "update",
    channelCapabilities: { canAct: false, canPropose: true },
  },
};

describe("trust ladder reach ↔ the engine", () => {
  it("classifies EXACTLY the engine's reason codes (a new code fails here)", () => {
    const engine = Object.keys(PROPOSE_REASON).sort();
    expect(Object.keys(GOVERNANCE_REASON_RULE_REACH).sort()).toEqual(engine);
    expect(Object.keys(FIXTURES).sort()).toEqual(engine);
    // Non-vacuity: the table is the size of the engine, and both halves exist.
    expect(engine.length).toBeGreaterThan(10);
    const reaches = Object.values(GOVERNANCE_REASON_RULE_REACH);
    expect(reaches).toContain("floor");
    expect(reaches).toContain("rule");
  });

  it("each fixture drives the engine to exactly its own code", () => {
    for (const [code, input] of Object.entries(FIXTURES)) {
      const decided = decideAgentPolicy(input);
      expect(decided.verdict, code).toBe("propose");
      expect(
        decided.verdict === "propose" ? decided.reasonCode : undefined,
        code
      ).toBe(code);
    }
  });

  it("rule/below codes flip to execute under an `auto` rule; floor codes do not", () => {
    for (const [code, input] of Object.entries(FIXTURES)) {
      const withRule = decideAgentPolicy({
        ...input,
        governanceRuleVerdict: "auto",
      });
      const reach = (GOVERNANCE_REASON_RULE_REACH as Record<string, string>)[
        code
      ];
      if (reach === "rule" || reach === "below") {
        expect(withRule.verdict, code).toBe("execute");
        expect(ruleCanReachReason(code), code).toBe(true);
        continue;
      }
      expect(ruleCanReachReason(code), code).toBe(false);
      if (code === "AGENT_OWNED_DESTRUCTIVE") {
        // The stated exception: a rule would flip it, so it is NEVER offered —
        // and its action is destructive, so reversibility refuses it too.
        expect(isReversibleWrite(`${input.subjectType}.${input.action}`)).toBe(
          false
        );
        continue;
      }
      if (reach === "ambiguous") continue;
      expect(withRule.verdict, code).not.toBe("execute");
    }
  });
});
