/**
 * Rule Loop (NS1-A) — the three new composite ops.
 *
 * Exercises `materializeCompositeGraph` with STUB callers, which is the honest
 * unit boundary: each caller is the seam where the real code routes to an
 * existing canonical door (skills service / automations materializer / rule
 * service). What these tests pin is the materializer's own contract —
 * ordering, ref resolution, the forced-disabled guarantee, and per-op
 * resilience — not the doors' internals.
 */

import { describe, it, expect, vi } from "vitest";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { isCompositeProposalData } from "@synap-core/types/proposals";
import {
  materializeCompositeGraph,
  type AutomationCreateCaller,
  type RuleCreateCaller,
  type SkillCreateCaller,
} from "./materialize-composite.js";

const noopEntityCaller = { create: vi.fn() };
const noopRelationCaller = { create: vi.fn() };

function stubSkillCaller(id = "skill-1"): SkillCreateCaller {
  return { create: vi.fn().mockResolvedValue({ id }) };
}
function stubAutomationCaller(id = "auto-1"): AutomationCreateCaller {
  return { create: vi.fn().mockResolvedValue({ id }) };
}
function stubRuleCaller(id = "rule-1"): RuleCreateCaller {
  return { create: vi.fn().mockResolvedValue({ id }) };
}

const skillOp: CompositeProposalOperation = {
  op: "create_skill",
  ref: "fact1",
  name: "Client folder convention",
  body: "Inside the Drive folder, one subfolder per client.",
  scope: "workspace",
};

const automationOp: CompositeProposalOperation = {
  op: "create_automation",
  ref: "beh1",
  name: "Create client subfolder",
  triggerType: "event",
  flowDefinition: { nodes: [], edges: [] },
};

const ruleOp: CompositeProposalOperation = {
  op: "create_rule",
  ref: "rule1",
  intent: "Inside that Drive folder, one subfolder per client.",
  scope: { kind: "workspace", workspaceId: "ws-1" },
  factRef: "fact1",
  behaviourRefs: ["beh1"],
};

describe("Rule Loop composite ops", () => {
  it("a create_automation op materialises DISABLED even when it says enabled:true", async () => {
    const automationCaller = stubAutomationCaller();
    const result = await materializeCompositeGraph(
      [{ ...automationOp, enabled: true } as CompositeProposalOperation],
      noopEntityCaller,
      noopRelationCaller,
      undefined,
      { automationCaller }
    );

    expect(automationCaller.create).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(result.automations).toEqual([
      expect.objectContaining({
        automationId: "auto-1",
        enabled: false,
        enabledRequested: true,
        enabledOverridden: true,
      }),
    ]);
  });

  it("ONE approval materialises skill + automation + rule together, refs resolved in-batch", async () => {
    const skillCaller = stubSkillCaller("skill-77");
    const automationCaller = stubAutomationCaller("auto-88");
    const ruleCaller = stubRuleCaller("rule-99");

    const result = await materializeCompositeGraph(
      // Deliberately declared in an order where the rule op comes FIRST, to
      // prove ordering comes from the pass structure, not from operations[].
      [ruleOp, skillOp, automationOp],
      noopEntityCaller,
      noopRelationCaller,
      undefined,
      { skillCaller, automationCaller, ruleCaller }
    );

    expect(result.skills).toEqual([
      { ref: "fact1", opIndex: 1, skillId: "skill-77" },
    ]);
    expect(result.automations[0]?.automationId).toBe("auto-88");
    expect(result.rules).toEqual([
      {
        ref: "rule1",
        opIndex: 0,
        ruleId: "rule-99",
        factSkillId: "skill-77",
        automationIds: ["auto-88"],
      },
    ]);
    // factRef / behaviourRefs resolved through the SAME ref→realId map
    // relations use — the rule caller never sees a ref.
    expect(ruleCaller.create).toHaveBeenCalledWith(
      expect.objectContaining({
        factSkillId: "skill-77",
        automationIds: ["auto-88"],
      })
    );
  });

  it("a rule ref may be a real UUID for a pre-existing object", async () => {
    const ruleCaller = stubRuleCaller();
    const existing = "11111111-2222-3333-4444-555555555555";
    await materializeCompositeGraph(
      [{ ...ruleOp, factRef: existing, behaviourRefs: [] }],
      noopEntityCaller,
      noopRelationCaller,
      undefined,
      { ruleCaller }
    );
    expect(ruleCaller.create).toHaveBeenCalledWith(
      expect.objectContaining({ factSkillId: existing })
    );
  });

  it("a failed op does not discard the ops that already succeeded", async () => {
    const skillCaller = stubSkillCaller("skill-ok");
    // The automation door throws — this is where the EXISTING flow validator
    // rejects an invalid flowDefinition (prepareAutomationForMaterialization).
    const automationCaller: AutomationCreateCaller = {
      create: vi.fn().mockRejectedValue(new Error("Invalid flow definition")),
    };
    const ruleCaller = stubRuleCaller("rule-ok");

    const result = await materializeCompositeGraph(
      [skillOp, automationOp, { ...ruleOp, behaviourRefs: [] }],
      noopEntityCaller,
      noopRelationCaller,
      undefined,
      { skillCaller, automationCaller, ruleCaller }
    );

    expect(result.skills).toHaveLength(1);
    expect(result.automations).toHaveLength(0);
    expect(result.rules).toHaveLength(1);
  });

  it("a create_rule whose behaviourRef never materialised is skipped, not silently mis-linked", async () => {
    const automationCaller: AutomationCreateCaller = {
      create: vi.fn().mockRejectedValue(new Error("Invalid flow definition")),
    };
    const ruleCaller = stubRuleCaller();
    const result = await materializeCompositeGraph(
      [automationOp, { ...ruleOp, factRef: undefined }],
      noopEntityCaller,
      noopRelationCaller,
      undefined,
      { automationCaller, ruleCaller }
    );
    // resolveCompositeRef throws on an unknown non-UUID ref → op skipped.
    expect(ruleCaller.create).not.toHaveBeenCalled();
    expect(result.rules).toHaveLength(0);
  });

  // DELIBERATE INVERSION — this case previously asserted "ops are skipped
  // (never thrown) when a caller is not wired", i.e. it PINNED the silent skip.
  // That behaviour was the defect: only one of the materializer's five call
  // sites wired these callers, so the same batch materialized its config ops on
  // the GOVERNED path and dropped them on the AUTO-APPROVED path, reporting
  // success both times. Behaviour must not fork on governance state, so the
  // unwired batch now refuses UP FRONT, before anything is written.
  it("REFUSES a batch whose config op has no wired caller (was: silently skipped)", async () => {
    await expect(
      materializeCompositeGraph(
        [skillOp, automationOp, ruleOp],
        noopEntityCaller,
        noopRelationCaller
      )
    ).rejects.toThrow(/wired no matching caller/);
  });

  it("refuses BEFORE writing anything — an unwirable batch is atomic", async () => {
    // The rule op is unwired; the entity op must NOT have been created.
    const entityCaller = {
      create: vi.fn().mockResolvedValue({ id: "e1", profileSlug: "note" }),
    };
    await expect(
      materializeCompositeGraph(
        [
          { op: "create_entity", ref: "e1", profileSlug: "note", title: "n" },
          ruleOp,
        ] as CompositeProposalOperation[],
        entityCaller as unknown as typeof noopEntityCaller,
        noopRelationCaller,
        undefined,
        // skill/automation callers present, ruleCaller deliberately absent.
        {
          skillCaller: stubSkillCaller(),
          automationCaller: stubAutomationCaller(),
        }
      )
    ).rejects.toThrow(/create_rule/);
    expect(entityCaller.create).not.toHaveBeenCalled();
  });

  it("a Rule Loop payload with no entity op is still recognised as composite", () => {
    // The guard used to require operations[0] to be a create_entity, which
    // would have routed a skill+automation+rule proposal to the single-op
    // branches and silently applied nothing.
    expect(
      isCompositeProposalData({ operations: [skillOp, automationOp, ruleOp] })
    ).toBe(true);
    expect(
      isCompositeProposalData({
        // Cast at the OPERATION, not the payload: the payload-level cast still
        // let TS check this literal against the (now five-member) op union, so
        // widening the union broke the very test that guards unknown ops.
        operations: [
          { op: "nonsense" } as unknown as CompositeProposalOperation,
        ],
      } as unknown as Parameters<typeof isCompositeProposalData>[0])
    ).toBe(false);
  });
});
