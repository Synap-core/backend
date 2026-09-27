import { describe, it, expect } from "vitest";
import {
  ADMIN_ACTIONS,
  DESTRUCTIVE_ACTIONS,
  ENTITY_BODY_LANES,
  decideAgentPolicy,
  governanceLaneFor,
  type AgentPolicyInput,
} from "./index.js";

/**
 * Text tiers, founder decision (b): a `document.update` on the BODY of a
 * human-owned entity is decided on the lane an `entity.update` of that entity
 * takes — moving prose from a property into the body never changes how an agent
 * edit of it is governed.
 *
 * PARITY is asserted over the cartesian product of every context input the
 * lane rungs can see. The discriminating rows (where the old rule — the real
 * `document.update` key — and the lane rule disagree) are the ones with no rule
 * and no explicit list (rung 8: DEFAULT_AUTO_APPROVE holds `entity.update`, not
 * `document.update`) and the explicit `["entity.update"]` list (rung 4). The
 * product includes both; the non-vacuity check below proves they are present.
 *
 * NOT covered here: the I/O half (which document IS a human-owned body, and that
 * the rule store is queried on the lane key) — see
 * `resolve-agent-governance-decision.body-lane.pglite.test.ts` in @synap/database.
 */

type Context = Omit<AgentPolicyInput, "subjectType" | "action">;

function product(): Context[] {
  const axes: { [K in keyof Context]?: readonly Context[K][] } = {
    governanceRuleVerdict: [undefined, "auto", "propose"],
    autoApproveFor: [undefined, ["entity.update"], ["document.update"], []],
    writesRequireProposal: [undefined, true],
    isAgentOwnedWorkspace: [undefined, true],
    channelCapabilities: [
      undefined,
      { canAct: false, canPropose: true },
      { canAct: false, canPropose: false },
    ],
    originTrust: [undefined, "untrusted"],
    forcePropose: [undefined, true],
    ceilingVerdict: [undefined, "propose"],
  };
  let rows: Context[] = [{}];
  for (const [key, values] of Object.entries(axes)) {
    const next: Context[] = [];
    for (const row of rows) {
      for (const value of values as unknown[]) {
        next.push({ ...row, [key]: value });
      }
    }
    rows = next;
  }
  return rows;
}

const CONTEXTS = product();

describe("entity-body lane (text tiers b)", () => {
  it("a human-owned body's document.update decides exactly like entity.update, in every context", () => {
    for (const ctx of CONTEXTS) {
      const asBody = decideAgentPolicy({
        ...ctx,
        subjectType: "document",
        action: "update",
        bodyOfHumanOwnedEntity: true,
      });
      const asEntity = decideAgentPolicy({
        ...ctx,
        subjectType: "entity",
        action: "update",
      });
      expect({ ctx, verdict: asBody.verdict }).toEqual({
        ctx,
        verdict: asEntity.verdict,
      });
    }
  });

  it("non-vacuity: the product holds rows where the real key and the lane disagree", () => {
    const disagreeing = CONTEXTS.filter(
      (ctx) =>
        decideAgentPolicy({ ...ctx, subjectType: "document", action: "update" })
          .verdict !==
        decideAgentPolicy({ ...ctx, subjectType: "entity", action: "update" })
          .verdict
    );
    expect(CONTEXTS.length).toBeGreaterThan(500);
    expect(disagreeing.length).toBeGreaterThan(0);
    // The plainest one: no rule, no list — the pod's default.
    expect(
      decideAgentPolicy({
        subjectType: "document",
        action: "update",
        bodyOfHumanOwnedEntity: true,
      }).verdict
    ).toBe("execute");
  });

  it("without the classification, a document.update keeps its own (stricter) lane", () => {
    expect(
      decideAgentPolicy({ subjectType: "document", action: "update" }).verdict
    ).toBe("propose");
    expect(
      decideAgentPolicy({
        subjectType: "document",
        action: "update",
        bodyOfHumanOwnedEntity: false,
      }).verdict
    ).toBe("propose");
  });

  it("never widens past a floor: destructive and admin document verbs stay gated", () => {
    const floored = [
      ...DESTRUCTIVE_ACTIONS.map((action) => ({
        subjectType: "document",
        action,
      })),
      ...ADMIN_ACTIONS.map((key) => {
        const dot = key.lastIndexOf(".");
        return { subjectType: key.slice(0, dot), action: key.slice(dot + 1) };
      }),
    ];
    expect(floored.length).toBeGreaterThan(3);
    for (const key of floored) {
      const decided = decideAgentPolicy({
        ...key,
        bodyOfHumanOwnedEntity: true,
        governanceRuleVerdict: "auto",
        autoApproveFor: ["*"],
      });
      expect({ key, verdict: decided.verdict }).toEqual({
        key,
        verdict: "propose",
      });
    }
  });

  it("the agent's forced review (replace_all) still proposes on a body", () => {
    expect(
      decideAgentPolicy({
        subjectType: "document",
        action: "update",
        bodyOfHumanOwnedEntity: true,
        forcePropose: true,
      }).verdict
    ).toBe("propose");
  });

  it("CBAC stays keyed on the real event: an entity-only allowlist still denies a document write", () => {
    expect(
      decideAgentPolicy({
        subjectType: "document",
        action: "update",
        bodyOfHumanOwnedEntity: true,
        agentCapabilities: ["entity.*"],
      }).verdict
    ).toBe("deny");
  });

  it("only document.update is re-laned; the lane map holds no destructive verb", () => {
    for (const key of Object.keys(ENTITY_BODY_LANES)) {
      const action = key.slice(key.lastIndexOf(".") + 1);
      expect(DESTRUCTIVE_ACTIONS).not.toContain(action);
    }
    expect(governanceLaneFor("document", "section_update", true)).toEqual({
      subjectType: "document",
      action: "section_update",
    });
    expect(governanceLaneFor("document", "update", undefined)).toEqual({
      subjectType: "document",
      action: "update",
    });
  });
});
