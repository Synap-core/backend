/**
 * Rule Loop config steps through the CAPTURE door (NS1 producer half).
 *
 * `CompositeCreateSkillOp` / `CompositeCreateAutomationOp` /
 * `CompositeCreateRuleOp` were declared in the op union, consumed by
 * `materializeCompositeGraph` and wired at all five of its call sites — and
 * emitted by NOBODY. Measured on the live pod: 166 composite proposals, 780
 * `create_entity`, 678 `create_relation`, ZERO of these three.
 *
 * These tests drive the REAL wire shape (`plan.skills[]` / `plan.automations[]`
 * / `plan.rules[]`) through the REAL builder and the REAL preflight, and assert
 * the VALUE arrives — the ops exist, carry their fields, and are named on the
 * receipt. Nothing is hand-built between the input and the assertion, so
 * deleting a mapper arm fails exactly one of these.
 *
 * The last test covers the reason this wave exists: an automation whose flow
 * names a skill the SAME batch creates. The materializer applies pass 0a
 * (skills) to completion before pass 0b (automations), and the automation door
 * resolves its catalog references with a LIVE read — so the reference resolves.
 * The `automationCaller` here performs the same name lookup the real door's
 * `loadFlowValidationResolvers` performs (`routers/automations.ts:425` folds
 * capability `verbId`s into the skill-NAME set) and throws when it misses,
 * which is what makes the ordering assertion non-vacuous.
 */

import { describe, it, expect, vi } from "vitest";

const { resolveProfile, validateEntityCreateForProposal } = vi.hoisted(() => ({
  resolveProfile: vi.fn(async () => ({ id: "prof-note", defaultValues: {} })),
  validateEntityCreateForProposal: vi.fn(async () => ({
    valid: true,
    errors: [] as string[],
    unmodeled: [] as Array<{ key: string; didYouMean?: string }>,
  })),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  ProfileResolutionService: class {
    resolveProfile = resolveProfile;
    getEntityScope = async () => "workspace";
  },
  PropertyValidationService: class {
    validateEntityCreateForProposal = validateEntityCreateForProposal;
  },
}));

import { dryRunCaptureGraph } from "./submit-capture-graph.js";
import {
  materializeCompositeGraph,
  type AutomationCreateCaller,
  type SkillCreateCaller,
} from "../../utils/materialize-composite.js";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";

/** No plan op in these batches names a session/project/entity id, so the
 *  preflight's DB queries are all short-circuited by an empty id set. */
const fakeDb = {
  query: { relationDefs: { findMany: async () => [] } },
} as never;

const FACT = {
  ref: "fact1",
  name: "client_subfolder_convention",
  body: "Inside the Drive folder, one subfolder per client.",
  scope: "workspace" as const,
};
const BEHAVIOUR = {
  ref: "beh1",
  name: "Create client subfolder",
  triggerType: "event" as const,
  flowDefinition: {
    nodes: [
      {
        id: "n1",
        type: "capability",
        // Resolved against the SKILL catalog by name — the seam this wave fixes.
        data: { verbId: "client_subfolder_convention" },
      },
    ],
    edges: [],
    triggerConfig: { eventPattern: "entity.created" },
  },
};
const RULE = {
  ref: "rule1",
  intent: "One Drive subfolder per client.",
  scope: { kind: "workspace" as const, workspaceId: null as never },
  factRef: "fact1",
  behaviourRefs: ["beh1"],
};

describe("capture door produces the three Rule Loop ops", () => {
  it("files skill + automation + rule as steps, with their values, from plan[] input", async () => {
    const out = await dryRunCaptureGraph(fakeDb, {
      userId: "u1",
      workspaceId: null,
      entities: [],
      relations: [],
      plan: {
        skills: [FACT],
        automations: [BEHAVIOUR],
        rules: [{ ...RULE, scope: { kind: "pod" } }],
      },
    });

    expect(out.planProblems).toEqual([]);
    // REACHABILITY, not shape: the steps are named on the receipt, which only
    // happens if the ops were built AND `hasComposedSteps` routed the batch
    // through the plan preflight and the receipt builder.
    expect(out.planSteps).toBeDefined();
    expect(
      out.planSteps?.map((s) => ({ kind: s.kind, ref: s.ref, label: s.label }))
    ).toEqual([
      { kind: "skill", ref: "fact1", label: "client_subfolder_convention" },
      { kind: "automation", ref: "beh1", label: "Create client subfolder" },
      { kind: "rule", ref: "rule1", label: "One Drive subfolder per client." },
    ]);
  });

  it("REFUSES a rule whose factRef names the automation instead of the skill", async () => {
    // The discriminating input. `resolveCompositeRef` would resolve this ref
    // happily — it is a real in-batch handle — and the rule would be created
    // pointing its FACT half at an automation id. Only a kind-aware check
    // catches it, and only if the check is REACHED (the batch carries no plan
    // op, so a gate on `isPlanBatch` would skip it entirely).
    const out = await dryRunCaptureGraph(fakeDb, {
      userId: "u1",
      workspaceId: null,
      entities: [],
      relations: [],
      plan: {
        skills: [FACT],
        automations: [BEHAVIOUR],
        rules: [{ ...RULE, scope: { kind: "pod" }, factRef: "beh1" }],
      },
    });

    expect(out.planProblems).toEqual([
      expect.objectContaining({
        op: "create_rule",
        ref: "rule1",
        message: 'factRef "beh1" names a automation, but must name a skill',
      }),
    ]);
  });

  it("REFUSES a rule whose behaviourRefs name nothing in the batch", async () => {
    const out = await dryRunCaptureGraph(fakeDb, {
      userId: "u1",
      workspaceId: null,
      entities: [],
      relations: [],
      plan: {
        skills: [FACT],
        rules: [
          { ...RULE, scope: { kind: "pod" }, behaviourRefs: ["ghost-beh"] },
        ],
      },
    });

    expect(out.planProblems).toEqual([
      expect.objectContaining({
        op: "create_rule",
        message:
          'behaviourRefs "ghost-beh" names no automation in this batch and is not a automation id',
      }),
    ]);
  });
});

describe("an automation may reference a skill the SAME batch creates", () => {
  /**
   * A skills catalog the skill door writes into and the automation door reads
   * back by NAME — the live read `loadFlowValidationResolvers` performs,
   * reduced to its seam. The automation caller THROWS on a miss exactly as
   * `flowValidationErrorMessage` does, so ordering is what this test measures.
   */
  function catalogCallers(): {
    skillCaller: SkillCreateCaller;
    automationCaller: AutomationCreateCaller;
    catalog: Set<string>;
  } {
    const catalog = new Set<string>();
    return {
      catalog,
      skillCaller: {
        create: vi.fn(async (op: { name: string }) => {
          catalog.add(op.name);
          return { id: `skill-${op.name}` };
        }),
      },
      automationCaller: {
        create: vi.fn(async (op: { name: string; flowDefinition: unknown }) => {
          const flow = op.flowDefinition as {
            nodes: Array<{ type?: string; data?: { verbId?: string } }>;
          };
          for (const node of flow.nodes) {
            const verbId = node.data?.verbId;
            if (node.type === "capability" && verbId && !catalog.has(verbId)) {
              throw new Error(
                `Flow references a capability that does not exist: "${verbId}"`
              );
            }
          }
          return { id: `auto-${op.name}` };
        }),
      },
    };
  }

  it("materialises the automation — the skill is already in the catalog", async () => {
    const { skillCaller, automationCaller } = catalogCallers();
    const result = await materializeCompositeGraph(
      // Declared automation-FIRST, so passing cannot be an artefact of array
      // order: only the materializer's pass order can make this resolve.
      [
        { op: "create_automation", ...BEHAVIOUR },
        { op: "create_skill", ...FACT },
      ] as CompositeProposalOperation[],
      { create: vi.fn() },
      { create: vi.fn() },
      undefined,
      { skillCaller, automationCaller }
    );

    expect(result.skills).toEqual([
      expect.objectContaining({ skillId: "skill-client_subfolder_convention" }),
    ]);
    expect(result.automations).toEqual([
      expect.objectContaining({
        automationId: "auto-Create client subfolder",
        enabled: false,
      }),
    ]);
  });

  it("does NOT materialise it when no step creates that skill", async () => {
    // The non-vacuity control for the test above: same automation, same
    // caller, skill step removed. If this passed too, the first test would be
    // proving nothing about ordering.
    const { automationCaller } = catalogCallers();
    const result = await materializeCompositeGraph(
      [
        { op: "create_automation", ...BEHAVIOUR },
      ] as CompositeProposalOperation[],
      { create: vi.fn() },
      { create: vi.fn() },
      undefined,
      { automationCaller }
    );

    expect(result.automations).toEqual([]);
  });
});
