/**
 * A skill created through capture must be LOADABLE, and its receipt must say
 * how — feedback d23a3888 (body: document 7a14865a).
 *
 * THE DEFECT: `synap_capture` with `skills[]` reported the skill applied with
 * `id: null`; `synap_load_skill` found nothing, because the `skills[]` shape
 * carried no `slug` and a teaching skill is resolved BY SLUG ONLY. Nothing could
 * load it, and the receipt gave no id to update it by.
 *
 * Driven through the real doors and builders:
 *   1. MCP `synap_capture` — a teaching skill without a slug is refused before
 *      any dry run or submit, with the SAME words `synap_create_skill` uses;
 *   2. the real plan builder + preflight (`dryRunCaptureGraph`) — the slug's
 *      shape is checked for every producer, and the step names its slug;
 *   3. the real `buildRuleLoopCallers` — the slug reaches the skill insert;
 *   4. the real `submitCaptureGraph` auto-apply — the applied receipt carries
 *      the created skill's id and the call that loads it.
 *
 * NOT covered: Hub REST `POST /capture/graph` calls the same
 * `captureSkillStepProblems`; only its call site is new, not exercised here.
 * Pod-wide slug uniqueness is the `idx_skills_slug` index, not tested here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  dryRuns: 0,
  inserted: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { query: { relationDefs: { findMany: async () => [] } } },
    resolveProjectPlacement: async () => ({ projectId: null, rung: null }),
    resolveIdentity: async () => ({ crossKindCandidates: [] }),
    ProfileResolutionService: class {
      resolveProfile = async () => ({ id: "prof-note", defaultValues: {} });
      getEntityScope = async () => "workspace";
    },
    PropertyValidationService: class {
      validateEntityCreateForProposal = async () => ({
        valid: true,
        errors: [],
        unmodeled: [],
      });
    },
  };
});
vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: async () => ({ decision: "execute" }),
}));
vi.mock("../../routers/skills.js", () => ({
  insertSkillGoverned: async (values: Record<string, unknown>) => {
    h.inserted.push(values);
    return { status: "installed", skill: { id: "skill-created" } };
  },
}));
vi.mock("../../utils/pending-capture-dedup.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findPriorCaptureGraphProposal: async () => null,
}));
vi.mock("../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("../../utils/event-backed-proposal.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createAutoApprovedProposal: async (row: { id: string }) => ({
    proposal: {
      id: row.id,
      data: {},
      workspaceId: null,
      projectId: null,
      sessionId: null,
    },
  }),
  createEventBackedProposal: async () => {
    throw new Error("an auto-approved plan must not file a pending proposal");
  },
}));
vi.mock("../proposals/stamp-materialized.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stampMaterialized: async () => undefined,
}));
// The materializer's own skill pass is exercised through the real
// `buildRuleLoopCallers` below; here it answers what that pass produces, so the
// assertion is about the RECEIPT the submit core builds from it.
vi.mock("../../utils/materialize-composite.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  materializeCompositeGraph: async () => ({
    created: 0,
    linked: 0,
    primaryId: "",
    refToRealId: { fact: "skill-created" },
    entities: [],
    relations: [],
    relationsFailed: [],
    facets: [],
    skills: [{ ref: "fact", opIndex: 0, skillId: "skill-created" }],
    automations: [],
    rules: [],
    playbooks: [],
    views: [],
    updates: [],
    projects: [],
    sessions: [],
    links: [],
    documents: [],
  }),
}));

import { captureHandlers } from "../../routers/mcp/handlers/capture.js";
import type { McpToolContext } from "../../routers/mcp/handlers/shared.js";
import {
  dryRunCaptureGraph,
  submitCaptureGraph,
} from "./submit-capture-graph.js";
import { buildRuleLoopCallers } from "../../utils/rule-loop-callers.js";

const SKILL = {
  ref: "fact",
  name: "Where the work is",
  body: "Look in the Builder space first.",
  scope: "pod" as const,
};

type Result = { content: Array<{ text?: string }> };
const capture = async (args: Record<string, unknown>) => {
  const r = (await captureHandlers.synap_capture!({
    toolName: "synap_capture",
    args,
    userId: "user-owner",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    workspaceAccessible: true,
  } as unknown as McpToolContext)) as Result;
  return JSON.parse(r.content[0]!.text!);
};

beforeEach(() => {
  h.dryRuns = 0;
  h.inserted = [];
});

describe("MCP synap_capture skills[] — the synap_create_skill authoring rule", () => {
  it("refuses a teaching skill without a slug, before anything is filed", async () => {
    const out = await capture({ validate: true, skills: [SKILL] });
    expect(out.problems).toEqual([
      expect.stringContaining(
        'skills[0] "Where the work is": slug is required'
      ),
    ]);
    expect(out.error).toContain("authored but unreachable");
  });

  it("refuses a slug in the reserved system/ namespace", async () => {
    const out = await capture({
      validate: true,
      skills: [{ ...SKILL, slug: "system/where" }],
    });
    expect(out.problems?.[0]).toContain("reserved for seeded skills");
  });
});

/** No plan op here names an existing id, so the preflight's reads short-circuit. */
const fakeDb = {
  query: { relationDefs: { findMany: async () => [] } },
} as never;

describe("the plan builder + preflight (every producer)", () => {
  it("checks a slug's shape and names the slug on the step", async () => {
    const bad = await dryRunCaptureGraph(fakeDb, {
      userId: "u",
      workspaceId: null,
      entities: [],
      relations: [],
      plan: { skills: [{ ...SKILL, slug: "Where The Work" }] },
    });
    expect(bad.planProblems.map((p) => p.message)).toContain(
      "slug must be lowercase path segments, e.g. 'biz/business-plan'"
    );

    const good = await dryRunCaptureGraph(fakeDb, {
      userId: "u",
      workspaceId: null,
      entities: [],
      relations: [],
      plan: { skills: [{ ...SKILL, slug: "team/where-the-work-is" }] },
    });
    expect(good.planProblems).toEqual([]);
    expect(good.planSteps?.[0]).toMatchObject({
      kind: "skill",
      slug: "team/where-the-work-is",
    });
  });
});

describe("the slug reaches the skill row", () => {
  it("buildRuleLoopCallers passes it to the governed insert", async () => {
    const { skillCaller } = buildRuleLoopCallers({
      database: {} as never,
      userId: "u",
      workspaceId: null,
      auditSource: "rule_loop_capture",
    });
    await skillCaller.create({
      name: SKILL.name,
      slug: "team/where-the-work-is",
      body: SKILL.body,
      scope: "pod",
    });
    expect(h.inserted[0]).toMatchObject({ slug: "team/where-the-work-is" });
  });
});

describe("the applied receipt says what landed", () => {
  it("carries the created skill's id and how to load it", async () => {
    const out = await submitCaptureGraph({
      userId: "user-owner",
      agentUserId: "agent-1",
      workspaceId: null,
      source: "agent",
      entities: [],
      plan: { skills: [{ ...SKILL, slug: "team/where-the-work-is" }] },
    });
    expect(out.applied).toBe(true);
    expect(out.plan?.steps).toEqual([
      expect.objectContaining({
        kind: "skill",
        state: "applied",
        id: "skill-created",
        loadWith: 'synap_load_skill({ ref: "team/where-the-work-is" })',
      }),
    ]);
  });
});
