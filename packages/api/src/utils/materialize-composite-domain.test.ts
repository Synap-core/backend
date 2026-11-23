/**
 * A plan builds a DOMAIN in one approval: its space (`create_workspace`), a
 * kind (`define_kind`) and its lifecycle (`declare_lifecycle`), the playbook
 * that runs on the kind, an automation that runs the playbook by its name, a
 * pipeline and a cell on the playbook's page, every step naming the others by
 * ref. Through the validator, the governance keys, the materializer, the
 * receipt, the review and the capture door's step arrays. The callers are
 * recorders here; their doors are driven for real in
 * `materialize-composite-domain.pglite.test.ts`.
 *
 * One test per rule, so reverting ONE rule turns ONE test red: the apply
 * order, each ref kind (workspaceRef, kindRef, subjectProfileRef,
 * target.ref), the domain gate pairs. Steps are sent in REVERSE dependency
 * order, where a naive materializer that follows the array disagrees.
 */

import { describe, it, expect, vi } from "vitest";
import {
  COMPOSITE_OPERATION_KINDS,
  isCompositeProposalData,
  landedFromRecord,
  type CompositeProposalOperation,
} from "@synap-core/types/proposals";
import { deriveGatePairFromOperations } from "@synap/governance-policy";
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

const FLOW = {
  triggerConfig: { eventPattern: "entity.create.completed" },
  nodes: [
    { id: "start", type: "trigger", data: {} },
    {
      id: "run",
      type: "playbook_run",
      data: { playbookName: "Qualify a target" },
    },
  ],
  edges: [{ id: "e1", source: "start", target: "run" }],
};

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
    flowDefinition: FLOW,
  },
  {
    op: "create_playbook",
    ref: "qualify",
    name: "Qualify a target",
    goalTemplate: "Decide whether to pursue this target",
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
      if (failSpace) throw new Error("a space of this name is not yours");
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

async function run(failSpace = false) {
  const order: string[] = [];
  const c = callers(order, failSpace);
  const result = await materializeCompositeGraph(
    DOMAIN,
    noEntities,
    noRelations,
    undefined,
    c
  );
  return { order, c, result };
}

describe("a domain plan — the ops", () => {
  it("is a composite and validates whole", () => {
    expect(isCompositeProposalData({ operations: DOMAIN })).toBe(true);
    for (const op of ["create_workspace", "define_kind", "declare_lifecycle"])
      expect(COMPOSITE_OPERATION_KINDS).toContain(op);
    expect(validatePlanOperations(DOMAIN, { workspaceId: null })).toEqual([]);
  });

  it("each domain op is judged on its door's own key, never a softer one", () => {
    for (const [op, pair] of [
      ["create_workspace", { subjectType: "workspace", action: "create" }],
      ["define_kind", { subjectType: "profile", action: "create" }],
      ["declare_lifecycle", { subjectType: "profile", action: "create" }],
    ] as const) {
      const one = DOMAIN.filter((o) => o.op === op);
      expect(captureGraphEventKeys(one), op).toEqual([pair]);
      // Beside a view (an auto-approvable key), the batch is gated as the
      // domain op: never the softer member.
      expect(
        deriveGatePairFromOperations([...one, { op: "create_view" }]),
        op
      ).toEqual(pair);
    }
  });

  it("refuses a ref that names the wrong kind of step or no step", () => {
    const bad: CompositeProposalOperation[] = [
      { op: "create_workspace", ref: "ws", name: "Acquisitions" },
      {
        op: "declare_lifecycle",
        ref: "lc",
        kindRef: "ws",
        options: [{ key: "a", category: "open" }],
      },
      {
        op: "create_playbook",
        ref: "pb",
        name: "P",
        goalTemplate: "G",
        subjectProfile: {},
        subjectProfileRef: "nope",
        workspaceRef: "ws",
      },
      {
        op: "bind_renderer",
        ref: "b",
        target: { kind: "view", ref: "pb" },
        slot: "detail",
        scope: "pod",
        cellKey: "generated:x",
      },
      {
        op: "bind_renderer",
        ref: "b2",
        target: { kind: "playbook", ref: "pb", id: PB },
        slot: "detail",
        scope: "pod",
        cellKey: "generated:x",
      },
      {
        op: "create_view",
        ref: "v",
        name: "V",
        viewType: "table",
        scopeProfileSlugs: ["x"],
        workspaceRef: "lc",
      },
    ];
    const problems = validatePlanOperations(bad, { workspaceId: null });
    const fieldsAt = (i: number) =>
      problems
        .filter((p) => p.opIndex === i)
        .map((p) => p.message.split(" ")[0]);
    expect(fieldsAt(0)).toEqual([]);
    expect(fieldsAt(1)).toEqual(["kindRef"]);
    expect(fieldsAt(2)).toEqual(["subjectProfileRef"]);
    expect(fieldsAt(3)).toEqual(["target.ref"]);
    expect(problems.filter((p) => p.opIndex === 4)).toHaveLength(1);
    expect(fieldsAt(5)).toEqual(["workspaceRef"]);
  });
});

describe("a domain plan — the materializer, one rule each", () => {
  it("apply order: the domain first, playbooks before automations", async () => {
    const { order } = await run();
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
  });

  it("workspaceRef: every step placed in the space lands in the space made", async () => {
    const { c } = await run();
    for (const call of [
      vi.mocked(c.kindCaller.define).mock.calls[0]![0],
      vi.mocked(c.playbookCaller.create).mock.calls[0]![0],
      vi.mocked(c.automationCaller.create).mock.calls[0]![0],
      vi.mocked(c.viewCaller.create).mock.calls[0]![0],
      vi.mocked(c.cellCaller.define).mock.calls[0]![0],
    ]) {
      expect(call.workspaceId).toBe(WS);
    }
  });

  it("kindRef: the lifecycle is declared on the kind the plan defined", async () => {
    const { c } = await run();
    expect(c.lifecycleCaller.declare).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: KIND, initialStatus: "spotted" })
    );
  });

  it("subjectProfileRef: the playbook runs on the kind's stored slug", async () => {
    const { c } = await run();
    expect(c.playbookCaller.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectProfile: { profileSlug: "acquisition-target" },
      })
    );
  });

  it("target.ref: the cell binds to the playbook the plan made", async () => {
    const { c } = await run();
    expect(c.rendererCaller.bind).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: "playbook", targetId: PB })
    );
  });

  it("a flow names the playbook by name; the automation door stamps its id", async () => {
    const { c } = await run();
    const automation = vi.mocked(c.automationCaller.create).mock.calls[0]![0];
    expect(automation.flowDefinition).toEqual(FLOW);
  });

  it("the receipt names the space, kind and lifecycle; landed opens the space", async () => {
    const { result } = await run();
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

  it("a space that fails skips every step placed in it", async () => {
    const { c, result } = await run(true);
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
  it("the review draws the domain, each step's space, and what approval turns on", () => {
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
      workspaceRef: "ws",
    });
    expect(graph.automations?.[0]).toMatchObject({
      bornEnabled: true,
      workspaceRef: "ws",
    });
    expect(graph.views?.[0]?.workspaceRef).toBe("ws");
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
