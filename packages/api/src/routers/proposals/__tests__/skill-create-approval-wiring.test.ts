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
 * They also pin the APPROVAL VERDICT (`skillBornApproved`):
 *   - ONE APPROVAL (founder decision 2): a PERSON approving the proposal turns
 *     the skill on through `setSkillApproved`, the one enable door — a code
 *     skill no longer needs a second "enable" after its create was approved.
 *   - the DOWNGRADE (security): re-running the governed door as the APPROVER
 *     launders agent authorship into operator authorship, which would land an
 *     AGENT-authored instruction skill in the agent's own system prompt with
 *     no owner approval. Every agent path (agent behind a human, agent key,
 *     agent principal) restores `approved: false` and never enables.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const PROPOSALS = { __table: "proposals" } as const;
const TOOLS = { id: "tools.id", __table: "tools" } as const;
const SKILLS = { id: "skills.id", __table: "skills" } as const;

/** Rows the mocked `select().from(T)` should yield, per table. */
let proposalRows: { status: string }[] = [];
let toolRows: { id: string }[] = [];
/** The request's acting agent (ALS) and the user ids that are agent principals. */
let actingAgent: string | undefined;
let agentPrincipals = new Set<string>();
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
  getActingAgentUserId: () => actingAgent,
}));

vi.mock("../review-authority.js", () => ({
  isAgentPrincipal: async (userId: string) => agentPrincipals.has(userId),
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
/** What the executor handed `insertSkillGoverned` / the requires-edge door. */
let insertInputs: Record<string, unknown>[] = [];
let requiresWrites: { skill: { id: string }; toolIds: readonly string[] }[] =
  [];
/** Tool ids the APPROVER can see at approval time — and only the approver:
 *  re-resolving as anyone else (the author, say) sees nothing. */
let visibleToolIds = new Set<string>(["tool-apify"]);
/** Whom the executor re-resolved the declared tools AS. */
let visibilityReadAs: string[] = [];
/** Set to make the visibility read fail (a DB error, not an empty answer). */
let visibilityReadFails = false;
vi.mock("../../skills.js", () => ({
  insertSkillGoverned: async (input: Record<string, unknown>) => {
    insertInputs.push(input);
    return insertResult;
  },
  visibleRequiredTools: async (userId: string, ids: readonly string[]) => {
    visibilityReadAs.push(userId);
    if (visibilityReadFails) throw new Error("connection reset");
    return userId === APPROVER
      ? ids
          .filter((id) => visibleToolIds.has(id))
          .map((id) => ({ id, name: id }))
      : [];
  },
  replaceSkillRequiredTools: async (p: {
    skill: { id: string };
    toolIds: readonly string[];
  }) => {
    requiresWrites.push(p);
  },
}));

/** Every call to the one enable door; `enableRefusal` makes it refuse. */
let enables: Record<string, unknown>[] = [];
let enableRefusal: Error | null = null;
/** How many times the verb had been wired when the enable door was called. */
let wiresAtEnable: number | null = null;
vi.mock("../../../services/capabilities/set-skill-approved.js", () => ({
  setSkillApproved: async (input: Record<string, unknown>) => {
    if (enableRefusal) throw enableRefusal;
    wiresAtEnable = wireCreatedVerb.mock.calls.length;
    enables.push(input);
    return { id: input.skillId, approved: input.approved };
  },
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
  approver?: string;
  ctx?: Record<string, unknown>;
  data?: Record<string, unknown>;
}) => {
  if (!executor) throw new Error("skill/create executor not registered");
  insertResult = {
    status: "created",
    id: "skill-1",
    skill: opts.skill ?? declarativeSkill(),
  };
  return executor.execute({
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
      data: {
        data: opts.data ?? { name: "fetch_invoice", kind: "declarative" },
      },
    },
    payload: null,
    userId: opts.approver ?? APPROVER,
    input: { proposalId: "p1" },
    ctx: (opts.ctx ?? {}) as never,
    deps: { db: {}, emitProposalReviewed: () => undefined } as never,
  });
};

beforeEach(() => {
  enables = [];
  enableRefusal = null;
  wiresAtEnable = null;
  visibilityReadAs = [];
  visibilityReadFails = false;
  insertInputs = [];
  requiresWrites = [];
  visibleToolIds = new Set(["tool-apify"]);
  wireCreatedVerb.mockClear();
  proposalRows = [];
  toolRows = [{ id: "tool-1" }];
  updates = [];
  actingAgent = undefined;
  agentPrincipals = new Set();
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
  const instruction = () =>
    declarativeSkill({ kind: "instruction", approved: true });
  const downgraded = () =>
    updates.find((u) => u.table === SKILLS)?.values.approved === false;

  it("KEEPS approved:true when a PERSON approved the agent's skill (no second toggle)", async () => {
    await run({ agentUserId: AGENT, skill: instruction() });
    expect(updates.find((u) => u.table === SKILLS)).toBeUndefined();
  });

  it("forces approved:false when an agent travels behind the human approver (ctx.agentUserId)", async () => {
    await run({
      agentUserId: AGENT,
      skill: instruction(),
      ctx: { agentUserId: "agent-2" },
    });
    expect(downgraded()).toBe(true);
  });

  it("forces approved:false when the request's acting agent is set (agent key)", async () => {
    actingAgent = "agent-2";
    await run({ agentUserId: AGENT, skill: instruction() });
    expect(downgraded()).toBe(true);
  });

  it("forces approved:false when the approver is itself an agent principal", async () => {
    agentPrincipals = new Set(["agent-approver"]);
    await run({
      agentUserId: AGENT,
      skill: instruction(),
      approver: "agent-approver",
    });
    expect(downgraded()).toBe(true);
  });

  it("does NOT downgrade a HUMAN-authored skill (no agentUserId on the proposal)", async () => {
    await run({
      agentUserId: null,
      skill: declarativeSkill({ kind: "instruction", approved: true }),
    });
    expect(updates.find((u) => u.table === SKILLS)).toBeUndefined();
  });
});

describe("ONE APPROVAL: a person approving the create turns the skill on (decision 2)", () => {
  const codeSkill = () =>
    declarativeSkill({ kind: "code", providerSpec: null, approved: false });
  const codeData = { name: "score_handle", kind: "code", code: "return 1;" };

  it("an AGENT's code skill a PERSON approved is enabled through the one enable door", async () => {
    const result = await run({
      agentUserId: AGENT,
      skill: codeSkill(),
      data: codeData,
    });
    expect(enables).toEqual([
      {
        userId: APPROVER,
        skillId: "skill-1",
        approved: true,
        agentUserId: null,
      },
    ]);
    // Through the door, never a raw `approved` write of its own.
    expect(updates.find((u) => u.table === SKILLS)).toBeUndefined();
    expect(result).not.toHaveProperty("refusals");
  });

  it("a member's code skill a PERSON approved is enabled too: the review showed the code", async () => {
    await run({ agentUserId: null, skill: codeSkill(), data: codeData });
    expect(enables).toHaveLength(1);
  });

  it("an agent travelling behind the approver (ctx.agentUserId) never enables it", async () => {
    await run({
      agentUserId: AGENT,
      skill: codeSkill(),
      data: codeData,
      ctx: { agentUserId: "agent-2" },
    });
    expect(enables).toEqual([]);
  });

  it("the request's acting agent (agent key) never enables it", async () => {
    actingAgent = "agent-2";
    await run({ agentUserId: AGENT, skill: codeSkill(), data: codeData });
    expect(enables).toEqual([]);
  });

  it("an agent-principal approver never enables it", async () => {
    agentPrincipals = new Set(["agent-approver"]);
    await run({
      agentUserId: AGENT,
      skill: codeSkill(),
      data: codeData,
      approver: "agent-approver",
    });
    expect(enables).toEqual([]);
  });

  it("an instruction skill already on is not enabled a second time", async () => {
    await run({
      agentUserId: AGENT,
      skill: declarativeSkill({ kind: "instruction", approved: true }),
    });
    expect(enables).toEqual([]);
  });

  it("enables AFTER the verb is wired, so the pack it joined re-syncs", async () => {
    await run({ agentUserId: AGENT }); // declarative, wired to tool-1
    expect(enables).toHaveLength(1);
    expect(wiresAtEnable).toBe(1);
  });

  it("a reviewer who may approve but not turn verbs on: created, left OFF, and the approval says so", async () => {
    const { TRPCError } = await import("@trpc/server");
    enableRefusal = new TRPCError({
      code: "FORBIDDEN",
      message: "Only workspace owners can turn this verb on or off.",
    });
    const result = await run({
      agentUserId: AGENT,
      skill: codeSkill(),
      data: codeData,
    });
    expect(result).toMatchObject({
      success: true,
      refusals: [
        "The skill was created but not turned on: Only workspace owners can turn this verb on or off.",
      ],
    });
    expect(
      updates.some(
        (u) => u.table === PROPOSALS && u.values.status === "approved"
      )
    ).toBe(true);
  });

  it("any other enable failure is not folded into a refusal", async () => {
    enableRefusal = new Error("db down");
    await expect(
      run({ agentUserId: AGENT, skill: codeSkill(), data: codeData })
    ).rejects.toThrow("db down");
  });
});

describe("skill/create approval writes the DECLARED requires edges (ticket c5058d24)", () => {
  it("replays `requiredToolIds` onto the materialized skill, never into its row", async () => {
    await run({
      agentUserId: AGENT,
      skill: declarativeSkill({ kind: "code", providerSpec: null }),
      data: {
        name: "score_handle",
        kind: "code",
        requiredToolIds: ["tool-apify"],
      },
    });
    expect(requiresWrites).toHaveLength(1);
    expect(requiresWrites[0]!.skill.id).toBe("skill-1");
    expect(requiresWrites[0]!.toolIds).toEqual(["tool-apify"]);
    // Re-resolved as the APPROVER, never as the author.
    expect(visibilityReadAs).toEqual([APPROVER]);
    // Not `skills` columns: they must not reach the governed insert.
    expect(insertInputs[0]).not.toHaveProperty("requiredToolIds");
    expect(insertInputs[0]).not.toHaveProperty("requiredToolNames");
  });

  it("re-resolves every id as the approver: one no longer visible is refused and never linked", async () => {
    if (!executor) throw new Error("skill/create executor not registered");
    insertResult = {
      status: "created",
      id: "skill-1",
      skill: declarativeSkill({ kind: "code", providerSpec: null }),
    };
    const result = await executor.execute({
      proposal: {
        id: "p1",
        targetType: "skill",
        targetId: "skill-1",
        proposalType: "create",
        workspaceId: "ws-1",
        sessionId: null,
        projectId: null,
        agentUserId: AGENT,
        sourceMessageId: null,
        data: {
          data: {
            name: "score_handle",
            kind: "code",
            requiredToolIds: ["tool-apify", "tool-gone"],
            requiredToolNames: ["apify_api", "gone_api"],
          },
        },
      },
      payload: null,
      userId: APPROVER,
      input: { proposalId: "p1" },
      ctx: {} as never,
      deps: { db: {}, emitProposalReviewed: () => undefined } as never,
    });
    expect(requiresWrites[0]!.toolIds).toEqual(["tool-apify"]);
    // Named, never an id.
    expect(result.refusals).toEqual([
      "Required tool `gone_api` was not linked: it is not an installed tool the approver can see.",
    ]);
  });

  it("a FAILED visibility read is a refusal the approver sees, not a quiet success", async () => {
    if (!executor) throw new Error("skill/create executor not registered");
    visibilityReadFails = true;
    insertResult = {
      status: "created",
      id: "skill-1",
      skill: declarativeSkill({ kind: "code", providerSpec: null }),
    };
    const result = await executor.execute({
      proposal: {
        id: "p1",
        targetType: "skill",
        targetId: "skill-1",
        proposalType: "create",
        workspaceId: "ws-1",
        sessionId: null,
        projectId: null,
        agentUserId: AGENT,
        sourceMessageId: null,
        data: {
          data: {
            name: "score_handle",
            kind: "code",
            requiredToolIds: ["tool-apify"],
            requiredToolNames: ["apify_api"],
          },
        },
      },
      payload: null,
      userId: APPROVER,
      input: { proposalId: "p1" },
      ctx: {} as never,
      deps: { db: {}, emitProposalReviewed: () => undefined } as never,
    });
    expect(requiresWrites).toEqual([]);
    expect(result.refusals).toEqual([
      expect.stringMatching(/^Required tools `apify_api` may not be linked/),
    ]);
    expect(JSON.stringify(result.refusals)).not.toContain("tool-apify");
  });

  it("writes no edges when the author declared none", async () => {
    await run({ agentUserId: AGENT });
    expect(requiresWrites).toEqual([]);
  });
});
