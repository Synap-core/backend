/**
 * Build UPDATE MODE (a Library rebuild), from the bundle through the real
 * op mapping (`buildCaptureGraphOperations`), the real preflight
 * (`validatePlanOperations`) and the real materializer — callers stubbed.
 *
 * Pins: with what the group made before, a rebuild files `update_*` ops for
 * the Tool / behaviour / Rule / Template / List and REUSES the container —
 * zero creates of any of them — and the new members' `parent_of` edges land on
 * the EXISTING container. Without a prior, the first build still creates
 * everything (the regression half).
 */

import { describe, it, expect, vi } from "vitest";
import type { ImportGroup, ImportItemView } from "@synap-core/types/imports";
import {
  assembleImportBuildBundle,
  GROUP_CONTAINER_REF,
  type ItemExtraction,
} from "../build.js";
import { buildCaptureGraphOperations } from "../../capture-agent/submit-capture-graph.js";
import { validatePlanOperations } from "../../capture-agent/capture-plan.js";
import { materializeCompositeGraph } from "../../../utils/materialize-composite.js";
import { buildProposalGraph } from "../../../routers/proposals/display.js";

const CONTAINER = "10000000-0000-4000-8000-000000000001";
const SKILL = "10000000-0000-4000-8000-000000000002";
const AUTOMATION = "10000000-0000-4000-8000-000000000003";
const RULE = "10000000-0000-4000-8000-000000000004";
const PLAYBOOK = "10000000-0000-4000-8000-000000000005";
const VIEW = "10000000-0000-4000-8000-000000000006";
const WS = "20000000-0000-4000-8000-000000000001";

const group: ImportGroup = {
  key: "recipes",
  name: "Recipes",
  note: "weeknight dinners, rate each",
  origin: "user",
  outputs: ["tool", "template", "rule", "list"],
};

function extraction(id: string, title: string): ItemExtraction {
  return {
    item: { id, title, groupKeys: ["recipes"] } as unknown as ImportItemView,
    contentRead: true,
    entities: [{ ref: `e_${id}`, profileSlug: "note", title }],
    relations: [],
    primaryRef: `e_${id}`,
    unreadable: false,
  };
}

const infra = {
  tool: { name: "Recipe helper", body: "Suggest a dinner." },
  template: { name: "Cook it", goal: "Cook {title}" },
  rule: { name: "New recipe", intent: "When a recipe lands, tell me." },
  degraded: false,
};

function bundle(
  prior?: Parameters<typeof assembleImportBuildBundle>[0]["prior"]
) {
  return assembleImportBuildBundle({
    sessionId: "run-1",
    group,
    extractions: [extraction("i1", "Pasta"), extraction("i2", "Curry")],
    infra,
    workspaceId: WS,
    dominantKind: "note",
    ...(prior ? { prior } : { toolSkillSlug: "library/run-1/recipes" }),
  });
}

const PRIOR = {
  containerEntityId: CONTAINER,
  skillId: SKILL,
  automationId: AUTOMATION,
  ruleId: RULE,
  playbookId: PLAYBOOK,
  viewId: VIEW,
};

async function operationsOf(b: ReturnType<typeof bundle>) {
  return buildCaptureGraphOperations(null as never, {
    entities: b.entities,
    relations: b.relations,
    projectId: null,
    // No workspace: the scope-aware home stamping (a DB read) is skipped.
    workspaceId: null,
    plan: b.plan,
  });
}

describe("Build update mode", () => {
  it("a rebuild UPDATES what the group made and reuses its container — no twin", async () => {
    const ops = await operationsOf(bundle(PRIOR));
    const kinds = ops.map((o) => o.op);
    for (const created of [
      "create_skill",
      "create_automation",
      "create_rule",
      "create_playbook",
      "create_view",
    ]) {
      expect(kinds).not.toContain(created);
    }
    expect(
      ops
        .filter((o) => o.op.startsWith("update_"))
        .map((o) => [o.op, (o as { ref: string }).ref])
        .sort()
    ).toEqual([
      ["update_automation", "rule_when"],
      ["update_entity", GROUP_CONTAINER_REF],
      ["update_playbook", "template"],
      ["update_rule", "rule"],
      ["update_skill", "tool"],
      ["update_view", "list"],
    ]);
    // The container is never created again; only the new things are.
    expect(
      ops
        .filter((o) => o.op === "create_entity")
        .map((o) => (o as { ref: string }).ref)
    ).toEqual(["e_i1", "e_i2"]);
    // The List stays live on the reused container.
    expect(ops.find((o) => o.op === "update_view")).toMatchObject({
      viewId: VIEW,
      patch: { name: "Recipes", config: { membersOf: CONTAINER } },
    });
    expect(validatePlanOperations(ops, { workspaceId: WS })).toEqual([]);

    // Through the real materializer: the new members hang off the EXISTING
    // container, and every update reaches its door.
    const relationCreate = vi.fn(async (_input: unknown) => ({ id: "rel" }));
    const applied: string[] = [];
    let n = 0;
    await materializeCompositeGraph(
      ops,
      { create: vi.fn(async () => ({ status: "created", id: `new-${++n}` })) },
      { create: relationCreate },
      undefined,
      {
        updateCaller: {
          apply: vi.fn(async (op) => {
            applied.push(op.op);
            return { before: {}, after: {} };
          }),
        },
      }
    );
    expect(relationCreate.mock.calls.map(([c]) => c)).toEqual([
      { sourceEntityId: CONTAINER, targetEntityId: "new-1", type: "parent_of" },
      { sourceEntityId: CONTAINER, targetEntityId: "new-2", type: "parent_of" },
    ]);
    expect(applied.sort()).toEqual([
      "update_automation",
      "update_entity",
      "update_playbook",
      "update_rule",
      "update_skill",
      "update_view",
    ]);
  });

  it("the review draws every change (Updates) and hangs the new members off the group", async () => {
    const ops = await operationsOf(bundle(PRIOR));
    // An unrendered op would make the review refuse the WHOLE proposal.
    const graph = buildProposalGraph({ operations: ops });
    expect(graph.updates?.map((u) => [u.kind, u.targetId]).sort()).toEqual(
      [
        ["automation", AUTOMATION],
        ["entity", CONTAINER],
        ["playbook", PLAYBOOK],
        ["rule", RULE],
        ["skill", SKILL],
        ["view", VIEW],
      ].sort()
    );
    expect(graph.updates?.find((u) => u.kind === "rule")?.fields).toEqual([
      {
        key: "intent",
        value: "When a recipe lands, tell me.",
        truncated: false,
      },
    ]);
    // New things only — the reused container is not a new node.
    expect(graph.entities.map((e) => e.ref)).toEqual(["e_i1", "e_i2"]);
    expect(graph.relations.map((r) => r.sourceLabel)).toEqual([
      "Recipes",
      "Recipes",
    ]);
  });

  it("only what still exists is updated — a missing piece is created", async () => {
    const ops = await operationsOf(
      bundle({ containerEntityId: CONTAINER, skillId: SKILL })
    );
    const kinds = ops.map((o) => o.op);
    expect(kinds).toContain("update_skill");
    expect(kinds).toContain("update_entity");
    expect(kinds).toContain("create_playbook");
    expect(kinds).toContain("create_view");
    // A new Rule binds the UPDATED Tool as its fact, by ref.
    expect(ops.find((o) => o.op === "create_rule")).toMatchObject({
      factRef: "tool",
    });
    expect(validatePlanOperations(ops, { workspaceId: WS })).toEqual([]);

    // …and at apply time that ref IS the existing Tool, although the update
    // pass runs after the rule pass.
    const ruleCreate = vi.fn(async () => ({ id: "rule-new" }));
    let n = 0;
    const id = async () => ({ id: `row-${++n}` });
    await materializeCompositeGraph(
      ops,
      { create: vi.fn(async () => ({ status: "created", id: `new-${++n}` })) },
      { create: vi.fn(async () => ({ id: "rel" })) },
      undefined,
      {
        updateCaller: { apply: vi.fn(async () => ({ before: {}, after: {} })) },
        skillCaller: { create: id },
        automationCaller: { create: id },
        ruleCaller: { create: ruleCreate },
        playbookCaller: { create: id },
        viewCaller: { create: id },
      }
    );
    expect(ruleCreate).toHaveBeenCalledWith(
      expect.objectContaining({ factSkillId: SKILL })
    );
  });

  it("a first build (no prior) still creates the container and every piece", async () => {
    const ops = await operationsOf(bundle());
    const kinds = ops.map((o) => o.op);
    expect(kinds.filter((k) => k.startsWith("update_"))).toEqual([]);
    expect(
      ops.some(
        (o) =>
          o.op === "create_entity" &&
          (o as { ref: string }).ref === GROUP_CONTAINER_REF
      )
    ).toBe(true);
    for (const created of [
      "create_skill",
      "create_automation",
      "create_rule",
      "create_playbook",
      "create_view",
    ]) {
      expect(kinds).toContain(created);
    }
  });
});
