/**
 * A plan builds a DOMAIN in one approval: its space (`create_workspace`), a
 * kind (`define_kind`) and its lifecycle (`declare_lifecycle`), the playbook
 * that runs on the kind, an automation that runs the playbook, a pipeline and
 * a cell on the playbook's page, every step naming the others by ref. Through
 * every seam except the database:
 *
 *   validate (capture-plan) → govern (capture-graph-policy) → materialize
 *   (domain first, playbooks before automations, refs resolved) → receipt
 *   (`byOp`, `workspaceIds`, `profileIds`, landed) → review render → the
 *   capture door's step arrays.
 *
 * Rows chosen where naive implementations DISAGREE: steps sent in REVERSE
 * dependency order (the pod applies them in its own order); a flow naming the
 * playbook by `$ref:` (must reach the automation door as the real id); a
 * binding whose target is a playbook of the same plan; a space that fails
 * (the kind in it is skipped and named, the step beside it still lands).
 */

import { describe, it, expect, vi } from "vitest";
import {
  COMPOSITE_OPERATION_KINDS,
  isCompositeProposalData,
  landedFromRecord,
  type CompositeProposalOperation,
} from "@synap-core/types/proposals";
import {
  materializeCompositeGraph,
  type AutomationCreateCaller,
  type CellDefineCaller,
  type KindDefineCaller,
  type LifecycleDeclareCaller,
  type PlaybookCreateCaller,
  type RendererBindCaller,
  type ViewCreateCaller,
  type WorkspaceCreateCaller,
} from "./materialize-composite.js";
import { captureGraphEventKeys } from "../services/capture-agent/capture-graph-policy.js";
import {
  CAPTURE_PLAN_KEYS,
  validatePlanOperations,
} from "../services/capture-agent/capture-plan.js";
import { buildCaptureGraphOperations } from "../services/capture-agent/submit-capture-graph.js";
import { buildMaterializedRecord } from "../services/proposals/stamp-materialized.js";
import { buildProposalGraph } from "../routers/proposals/display.js";

const WS = "11111111-1111-4111-8111-111111111111";
const KIND = "22222222-2222-4222-8222-222222222222";
const DEF = "33333333-3333-4333-8333-333333333333";
const PB = "44444444-4444-4444-8444-444444444444";
const AUTO = "55555555-5555-4555-8555-555555555555";
const VIEW = "66666666-6666-4666-8666-666666666666";

/** The whole domain, sent in REVERSE dependency order. */
const DOMAIN: CompositeProposalOperation[] = [
  {
    op: "bind_renderer",
    ref: "page-on-playbook",
    target: { kind: "playbook", ref: "qualify" },
    slot: "detail",
    scope: "pod",
    cellRef: "page",
  },
  {
    op: "create_cell",
    ref: "page",
    name: "Target page",
    rendererSource: "export default function Page() { return null; }",
    workspaceRef: "ws",
  },
  {
    op: "create_view",
    ref: "board",
    name: "Targets",
    viewType: "pipeline",
    scopeProfileSlugs: ["acquisition-target"],
    config: { profileSlug: "acquisition-target" },
    workspaceRef: "ws",
  },
  {
    op: "create_automation",
    ref: "on-new",
    name: "Qualify each new target",
    triggerType: "event",
    workspaceRef: "ws",
    flowDefinition: {
      triggerConfig: { eventPattern: "entity.create.completed" },
      nodes: [
        { id: "start", type: "trigger", data: {} },
        {
          id: "run",
          type: "playbook_run",
          data: { playbookId: "$ref:qualify" },
        },
      ],
      edges: [{ id: "e1", source: "start", target: "run" }],
    },
  },
  {
    op: "create_playbook",
    ref: "qualify",
    name: "Qualify a target",
    goalTemplate: "Decide whether to pursue it",
    subjectProfile: {},
    subjectProfileRef: "target",
    workspaceRef: "ws",
  },
  {
    op: "declare_lifecycle",
    ref: "target-flow",
    kindRef: "target",
    options: [
      { key: "spotted", category: "open" },
      { key: "signed", category: "done" },
    ],
    initialStatus: "spotted",
  },
  {
    op: "define_kind",
    ref: "target",
    slug: "acquisition-target",
    displayName: "Acquisition target",
    workspaceRef: "ws",
    fields: [{ slug: "revenue", valueType: "number" }],
  },
  { op: "create_workspace", ref: "ws", name: "Acquisitions" },
];

function callers(order: string[], failSpace = false) {
  const workspaceCaller: WorkspaceCreateCaller = {
    create: vi.fn(async () => {
      order.push("workspace");
      if (failSpace) throw new Error("a space of this domain already exists");
      return { id: WS, linked: false };
    }),
  };
  const kindCaller: KindDefineCaller = {
    define: vi.fn(async () => {
      order.push("kind");
      return { id: KIND, slug: "acquisition-target", linked: false };
    }),
  };
  const lifecycleCaller: LifecycleDeclareCaller = {
    declare: vi.fn(async () => {
      order.push("lifecycle");
      return { propertyDefId: DEF };
    }),
  };
  const playbookCaller: PlaybookCreateCaller = {
    create: vi.fn(async () => {
      order.push("playbook");
      return { id: PB, status: "active" as const };
    }),
  };
  const automationCaller: AutomationCreateCaller = {
    create: vi.fn(async () => {
      order.push("automation");
      return { id: AUTO };
    }),
  };
  const viewCaller: ViewCreateCaller = {
    create: vi.fn(async () => {
      order.push("view");
      return { id: VIEW };
    }),
  };
  const cellCaller: CellDefineCaller = {
    define: vi.fn(async (input) => {
      order.push("cell");
      return {
        id: "cell-1",
        typeKey: "generated:target-page",
        workspaceId: input.workspaceId,
        created: true,
      };
    }),
  };
  const rendererCaller: RendererBindCaller = {
    bind: vi.fn(async () => {
      order.push("renderer");
      return { bindingId: "binding-1" };
    }),
  };
  return {
    workspaceCaller,
    kindCaller,
    lifecycleCaller,
    playbookCaller,
    automationCaller,
    viewCaller,
    cellCaller,
    rendererCaller,
  };
}

const noEntities = { create: vi.fn() };
const noRelations = { create: vi.fn() };

describe("a domain plan — the ops", () => {
  it("is a composite, validates whole, and every domain op is governed", () => {
    expect(isCompositeProposalData({ operations: DOMAIN })).toBe(true);
    for (const op of ["create_workspace", "define_kind", "declare_lifecycle"])
      expect(COMPOSITE_OPERATION_KINDS).toContain(op);
    expect(validatePlanOperations(DOMAIN, { workspaceId: null })).toEqual([]);
    expect(captureGraphEventKeys(DOMAIN)).toEqual(
      expect.arrayContaining([
        { subjectType: "workspace", action: "create" },
        { subjectType: "profile", action: "create" },
        { subjectType: "profile", action: "declare_lifecycle" },
      ])
    );
  });

  it("refuses refs that name nothing, or the wrong kind of step", () => {
    const bad: CompositeProposalOperation[] = [
      { op: "create_workspace", ref: "ws", name: "Acquisitions" },
      // A lifecycle names a kind, not a space.
      {
        op: "declare_lifecycle",
        ref: "lc",
        kindRef: "ws",
        options: [{ key: "a", category: "open" }],
      },
      // A playbook on a kind the plan does not define.
      {
        op: "create_playbook",
        ref: "pb",
        name: "P",
        goalTemplate: "G",
        subjectProfile: {},
        subjectProfileRef: "nope",
        workspaceRef: "ws",
      },
      // A flow naming a step that is not in the plan.
      {
        op: "create_automation",
        ref: "a",
        name: "A",
        triggerType: "manual",
        flowDefinition: {
          nodes: [
            {
              id: "n",
              type: "playbook_run",
              data: { playbookId: "$ref:ghost" },
            },
          ],
          edges: [],
        },
      },
      // A binding naming its target twice.
      {
        op: "bind_renderer",
        ref: "b",
        target: { kind: "playbook", ref: "pb", id: PB },
        slot: "detail",
        scope: "pod",
        cellKey: "generated:x",
      },
    ];
    const problems = validatePlanOperations(bad, { workspaceId: null });
    expect(problems.map((p) => p.opIndex).sort()).toEqual([1, 2, 3, 4]);
    expect(problems.find((p) => p.opIndex === 1)!.message).toMatch(
      /names a workspace, but must name a kind/
    );
    expect(problems.find((p) => p.opIndex === 3)!.message).toMatch(
      /\$ref:ghost/
    );
  });
});

describe("a domain plan — the materializer", () => {
  it("applies the domain first and playbooks before automations, every ref resolved", async () => {
    const order: string[] = [];
    const c = callers(order);
    const result = await materializeCompositeGraph(
      DOMAIN,
      noEntities,
      noRelations,
      undefined,
      c
    );
    expect(order).toEqual([
      "workspace",
      "kind",
      "lifecycle",
      "playbook",
      "automation",
      "view",
      "cell",
      "renderer",
    ]);
    expect(c.kindCaller.define).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, slug: "acquisition-target" })
    );
    expect(c.lifecycleCaller.declare).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: KIND, initialStatus: "spotted" })
    );
    expect(c.playbookCaller.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        subjectProfile: { profileSlug: "acquisition-target" },
      })
    );
    const automation = vi.mocked(c.automationCaller.create).mock.calls[0]![0];
    expect(automation.workspaceId).toBe(WS);
    expect(JSON.stringify(automation.flowDefinition)).toContain(
      `"playbookId":"${PB}"`
    );
    expect(JSON.stringify(automation.flowDefinition)).not.toContain("$ref:");
    expect(c.viewCaller.create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS })
    );
    expect(c.cellCaller.define).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS })
    );
    expect(c.rendererCaller.bind).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: "playbook", targetId: PB })
    );

    const record = buildMaterializedRecord(result);
    expect(record.workspaceIds).toEqual([WS]);
    expect(record.profileIds).toEqual([KIND]);
    expect(record.byOp?.ws).toEqual({
      op: "create_workspace",
      workspaceId: WS,
      linked: false,
    });
    expect(record.byOp?.["target-flow"]).toEqual({
      op: "declare_lifecycle",
      profileId: KIND,
      propertyDefId: DEF,
    });
    expect(landedFromRecord({ materialized: record })).toEqual(
      expect.arrayContaining([
        { kind: "workspace", id: WS, role: "created" },
        { kind: "playbook", id: PB, role: "created" },
        { kind: "automation", id: AUTO, role: "created" },
      ])
    );
  });

  it("a space that fails skips what lives in it, named; the rest still lands", async () => {
    const order: string[] = [];
    const c = callers(order, true);
    const result = await materializeCompositeGraph(
      DOMAIN,
      noEntities,
      noRelations,
      undefined,
      c
    );
    // Every step placed in the space (`workspaceRef`) is skipped: none of
    // them reached its door with a space that does not exist.
    expect(c.kindCaller.define).not.toHaveBeenCalled();
    expect(c.playbookCaller.create).not.toHaveBeenCalled();
    expect(c.automationCaller.create).not.toHaveBeenCalled();
    expect(result.workspaces ?? []).toEqual([]);
    expect(result.kinds ?? []).toEqual([]);
  });

  it("refuses before any write when a domain op has no caller wired", async () => {
    const order: string[] = [];
    const { workspaceCaller: _omitted, ...rest } = callers(order);
    await expect(
      materializeCompositeGraph(
        DOMAIN,
        noEntities,
        noRelations,
        undefined,
        rest
      )
    ).rejects.toThrow(/create_workspace/);
    expect(order).toEqual([]);
  });
});

describe("a domain plan — review and the capture door", () => {
  it("the review draws the space, the kind, its lifecycle, and the playbook on that kind", () => {
    const graph = buildProposalGraph({ operations: DOMAIN } as never);
    expect(graph.workspaces).toEqual([{ ref: "ws", name: "Acquisitions" }]);
    expect(graph.kinds).toEqual([
      expect.objectContaining({
        ref: "target",
        slug: "acquisition-target",
        fieldCount: 1,
        workspaceRef: "ws",
      }),
    ]);
    expect(graph.lifecycles?.[0]?.options).toEqual([
      { key: "spotted", category: "open" },
      { key: "signed", category: "done" },
    ]);
    expect(graph.playbooks?.[0]).toMatchObject({
      subjectProfileSlug: "acquisition-target",
      bornStatus: "active",
    });
    expect(graph.automations?.[0]?.bornEnabled).toBe(true);
  });

  it("the capture door files every step array as its op", async () => {
    expect(CAPTURE_PLAN_KEYS).toEqual(
      expect.arrayContaining([
        "workspaces",
        "kinds",
        "lifecycles",
        "playbooks",
        "views",
        "cells",
        "renderers",
      ])
    );
    const ops = await buildCaptureGraphOperations({} as never, {
      entities: [],
      relations: [],
      projectId: null,
      workspaceId: null,
      plan: {
        workspaces: [{ ref: "ws", name: "Acquisitions" }],
        kinds: [
          { ref: "target", slug: "t", displayName: "T", workspaceRef: "ws" },
        ],
        lifecycles: [
          {
            ref: "lc",
            kindRef: "target",
            options: [{ key: "a", category: "open" }],
          },
        ],
        cells: [{ ref: "page", name: "Page", rendererSource: "x" }],
        renderers: [
          {
            ref: "r",
            target: { kind: "view", id: VIEW },
            slot: "detail",
            scope: "pod",
            cellRef: "page",
          },
        ],
      },
    });
    expect(ops.map((o) => o.op).sort()).toEqual([
      "bind_renderer",
      "create_cell",
      "create_workspace",
      "declare_lifecycle",
      "define_kind",
    ]);
  });
});
