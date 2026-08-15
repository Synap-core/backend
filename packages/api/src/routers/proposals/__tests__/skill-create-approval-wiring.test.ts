/**
 * `skill/create` APPROVAL wires the declarative verb — EXECUTABLY.
 *
 * DEFECT CLASS (recurring): the create doors (`capabilities.createVerb`, MCP
 * `synap_create_verb` at `mcp/handlers/capability.ts`) call `wireCreatedVerb`
 * ONLY on their synchronous `result.status === "created"` branch. An
 * AGENT-authored verb is governed, so it returns `"proposed"` — the skill row
 * is materialized later, HERE, on approval. Without wiring on THIS path the
 * verb is born ORPHANED: no `requires` edge to its parent tool, not attached to
 * the tool's capability containers, absent from the verb catalogue — invisible
 * under its tool, on its card, and in the registry.
 *
 * WHY THIS FILE EXISTS ALONGSIDE `execute-executors.test.ts`: those assertions
 * are SOURCE-TEXT/AST checks (`executorCallsBareFn("skill/create",
 * "wireCreatedVerb")`, `SKILL_CREATE_BLOCK.indexOf("wireCreatedVerb(")`). They
 * pin that the call is textually PRESENT, so they catch an outright deletion —
 * but they stay GREEN if the call is left in place behind a dead guard (proven:
 * inserting `false &&` into the wiring condition kept all 25 of them passing).
 * The tests below DRIVE the executor, so they measure that wiring actually RUNS.
 *
 * They also pin the BORN-APPROVED DOWNGRADE (security): re-running the governed
 * door as the APPROVER launders agent authorship into operator authorship, which
 * would make `insertSkillGoverned`'s `approved = kind === "instruction" &&
 * !agentUserId` rule read TRUE — landing an AGENT-authored instruction skill in
 * the agent's own system prompt with no owner approval (prompt-injection
 * vector). The executor restores `approved: false`; this asserts it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const PROPOSALS = { __table: "proposals" } as const;
const TOOLS = { id: "tools.id", __table: "tools" } as const;
const SKILLS = { id: "skills.id", __table: "skills" } as const;

/** Rows the mocked `select().from(T)` should yield, per table. */
let proposalRows: { status: string }[] = [];
let toolRows: { id: string }[] = [];
/** Every `update(T).set(v)` the executor issues, in order. */
let updates: { table: unknown; values: Record<string, unknown> }[] = [];

/** `where()` is awaited directly in one place and `.limit(1)`-ed in another. */
const whereResult = (rows: unknown[]) =>
  Object.assign(Promise.resolve(rows), { limit: async () => rows });

vi.mock("@synap/database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => whereResult(table === TOOLS ? toolRows : proposalRows),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return { where: async () => undefined };
      },
    }),
  },
  proposals: PROPOSALS,
  tools: TOOLS,
  skills: SKILLS,
  eq: () => ({}),
}));

vi.mock("@synap/database/schema", () => ({
  ProposalStatus: { APPROVED: "approved" },
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    warn: () => undefined,
    error: () => undefined,
    info: () => undefined,
    debug: () => undefined,
  }),
}));

vi.mock("../executors/shared.js", () => ({ reportApproved: () => undefined }));

/** What `insertSkillGoverned` returns — set per test. */
let insertResult: Record<string, unknown>;
vi.mock("../../skills.js", () => ({
  insertSkillGoverned: async () => insertResult,
}));

/** Args typed so `.mock.calls[0][1]` is a real tuple index, not `never`. */
const wireCreatedVerb = vi.fn(
  async (
    _ctx: unknown,
    _args: { skillId: string; parentToolId: string; verbName: string }
  ) => ({ requires: true, catalogued: true, capabilityIds: [] as string[] })
);
vi.mock("../../../services/capabilities/create-declarative-verb.js", () => ({
  wireCreatedVerb: (
    ctx: unknown,
    args: { skillId: string; parentToolId: string; verbName: string }
  ) => wireCreatedVerb(ctx, args),
  parentToolWhere: () => ({}),
}));

const { registerSkillExecutors } = await import("../executors/skill.js");
const { proposalExecRegistry } = await import("../execution-registry.js");

registerSkillExecutors();
const executor = proposalExecRegistry.resolveExact("skill/create");

const AGENT = "agent-user-1";
const APPROVER = "human-approver";

const declarativeSkill = (over: Record<string, unknown> = {}) => ({
  id: "skill-1",
  name: "fetch_invoice",
  kind: "declarative",
  description: "Fetch an invoice",
  workspaceId: "ws-1",
  parameters: { type: "object" },
  providerSpec: { tool: "billing-api" },
  approved: false,
  ...over,
});

const run = async (opts: {
  agentUserId?: string | null;
  skill?: Record<string, unknown>;
}) => {
  if (!executor) throw new Error("skill/create executor not registered");
  insertResult = {
    status: "created",
    id: "skill-1",
    skill: opts.skill ?? declarativeSkill(),
  };
  await executor.execute({
    proposal: {
      id: "p1",
      targetType: "skill",
      targetId: "skill-1",
      proposalType: "create",
      workspaceId: "ws-1",
      sessionId: null,
      projectId: null,
      agentUserId: opts.agentUserId ?? null,
      sourceMessageId: null,
      data: { data: { name: "fetch_invoice", kind: "declarative" } },
    },
    payload: null,
    userId: APPROVER,
    input: { proposalId: "p1" },
    ctx: {} as never,
    deps: { db: {}, emitProposalReviewed: () => undefined } as never,
  });
};

beforeEach(() => {
  wireCreatedVerb.mockClear();
  proposalRows = [];
  toolRows = [{ id: "tool-1" }];
  updates = [];
});

describe("skill/create approval WIRES the verb (executable, not source-text)", () => {
  it("CALLS wireCreatedVerb when the approved skill is a declarative verb", async () => {
    await run({ agentUserId: AGENT });
    expect(wireCreatedVerb).toHaveBeenCalledTimes(1);
  });

  it("wires the materialized skill to the RESOLVED parent tool", async () => {
    await run({ agentUserId: AGENT });
    const args = wireCreatedVerb.mock.calls[0]?.[1];
    expect(args?.skillId).toBe("skill-1");
    expect(args?.parentToolId).toBe("tool-1");
    expect(args?.verbName).toBe("fetch_invoice");
  });

  it("leaves the verb unwired (non-fatally) when no parent tool resolves", async () => {
    toolRows = [];
    await run({ agentUserId: AGENT });
    expect(wireCreatedVerb).not.toHaveBeenCalled();
    // The approval still completes — the skill row is already committed.
    expect(
      updates.some(
        (u) => u.table === PROPOSALS && u.values.status === "approved"
      )
    ).toBe(true);
  });

  it("does NOT wire a non-declarative skill (nothing to hang off a tool)", async () => {
    await run({
      agentUserId: AGENT,
      skill: declarativeSkill({ kind: "instruction", providerSpec: null }),
    });
    expect(wireCreatedVerb).not.toHaveBeenCalled();
  });

  it("flips the proposal APPROVED after wiring", async () => {
    await run({ agentUserId: AGENT });
    const approved = updates.find(
      (u) => u.table === PROPOSALS && u.values.status === "approved"
    );
    expect(approved?.values.reviewedBy).toBe(APPROVER);
  });
});

describe("BORN-APPROVED DOWNGRADE stays intact (security)", () => {
  it("forces approved:false for an AGENT-authored skill the door born approved", async () => {
    await run({
      agentUserId: AGENT,
      skill: declarativeSkill({ kind: "instruction", approved: true }),
    });
    const downgrade = updates.find((u) => u.table === SKILLS);
    expect(downgrade).toBeDefined();
    expect(downgrade?.values.approved).toBe(false);
  });

  it("does NOT downgrade a HUMAN-authored skill (no agentUserId on the proposal)", async () => {
    await run({
      agentUserId: null,
      skill: declarativeSkill({ kind: "instruction", approved: true }),
    });
    expect(updates.find((u) => u.table === SKILLS)).toBeUndefined();
  });
});
