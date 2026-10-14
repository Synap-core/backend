/**
 * The `update_*` arms of the composite materializer (a Library rebuild):
 * fail-closed wiring, per-op resilience, and the reused container's ref.
 * The revert half is pinned on real SQL in
 * `services/reversibility/__tests__/update-ops-revert.pglite.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { materializeCompositeGraph } from "./materialize-composite.js";
import { captureGraphEventKeys } from "../services/capture-agent/capture-graph-policy.js";
import { validatePlanOperations } from "../services/capture-agent/capture-plan.js";

const CONTAINER = "11111111-1111-4111-8111-111111111111";
const SKILL = "22222222-2222-4222-8222-222222222222";

const ops = [
  {
    op: "update_entity",
    ref: "group",
    entityId: CONTAINER,
    patch: { description: "new note" },
  },
  { op: "create_entity", ref: "t1", profileSlug: "note", title: "New item" },
  {
    op: "create_relation",
    sourceRef: "group",
    targetRef: "t1",
    type: "parent_of",
  },
  { op: "update_skill", ref: "tool", skillId: SKILL, patch: { body: "b" } },
] as CompositeProposalOperation[];

describe("materializeCompositeGraph — update ops", () => {
  it("refuses a batch carrying an update op when no updateCaller is wired — before any write", async () => {
    const create = vi.fn(async () => ({ id: "e1" }));
    await expect(
      materializeCompositeGraph(ops, { create }, { create: vi.fn() })
    ).rejects.toThrow(/update_entity.*no matching caller/);
    expect(create).not.toHaveBeenCalled();
  });

  it("links a new member to the REUSED container through the update's ref", async () => {
    const relationCreate = vi.fn(async () => ({ id: "r1" }));
    const result = await materializeCompositeGraph(
      ops,
      { create: vi.fn(async () => ({ status: "created", id: "e-new" })) },
      { create: relationCreate },
      undefined,
      {
        updateCaller: {
          apply: vi.fn(async () => ({ before: { a: 1 }, after: { a: 2 } })),
        },
      }
    );
    expect(relationCreate).toHaveBeenCalledWith({
      sourceEntityId: CONTAINER,
      targetEntityId: "e-new",
      type: "parent_of",
    });
    expect(result.updates.map((u) => [u.op, u.targetId])).toEqual([
      ["update_entity", CONTAINER],
      ["update_skill", SKILL],
    ]);
  });

  it("a failed update never discards the new things beside it", async () => {
    const result = await materializeCompositeGraph(
      ops,
      { create: vi.fn(async () => ({ status: "created", id: "e-new" })) },
      { create: vi.fn(async () => ({ id: "r1" })) },
      undefined,
      {
        updateCaller: {
          apply: vi.fn(async (op) => {
            if (op.op === "update_skill") throw new Error("door said no");
            return { before: {}, after: {} };
          }),
        },
      }
    );
    expect(result.entities.map((e) => e.entityId)).toEqual(["e-new"]);
    expect(result.updates.map((u) => u.op)).toEqual(["update_entity"]);
  });
});

describe("update ops are governed and validated like their doors", () => {
  it("each update arm scores its object's update key — never a create", () => {
    const keys = captureGraphEventKeys([
      ...ops,
      {
        op: "update_rule",
        ref: "rule",
        ruleId: SKILL,
        patch: { intent: "x" },
      },
      {
        op: "update_view",
        ref: "list",
        viewId: SKILL,
        patch: { name: "x" },
      },
      {
        op: "update_playbook",
        ref: "template",
        playbookId: SKILL,
        patch: { name: "x" },
      },
      {
        op: "update_automation",
        ref: "rule_when",
        automationId: SKILL,
        patch: { name: "x" },
      },
    ] as CompositeProposalOperation[]).map(
      (k) => `${k.subjectType}.${k.action}`
    );
    for (const key of [
      "entity.update",
      "skill.update",
      "rule.update",
      "view.update",
      "playbook.update",
      "automation.update",
    ]) {
      expect(keys).toContain(key);
    }
  });

  it("refuses an update with a non-uuid target, an empty patch, or a rule with no intent", () => {
    const problems = validatePlanOperations([
      { op: "update_skill", ref: "a", skillId: "nope", patch: { body: "x" } },
      { op: "update_view", ref: "b", viewId: SKILL, patch: {} },
      { op: "update_rule", ref: "c", ruleId: SKILL, patch: { intent: " " } },
    ] as CompositeProposalOperation[]).map((p) => p.message);
    expect(problems).toEqual([
      'target id "nope" is not a UUID',
      "an update step needs at least one field in `patch`",
      "a rule update needs `patch.intent` (the rule in words)",
    ]);
  });
});
