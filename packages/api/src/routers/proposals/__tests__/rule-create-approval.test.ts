/**
 * `rule/create` — the APPROVAL half of the Rule Loop's governed write door.
 *
 * A governed write door with no approval half is this repo's most repeated
 * silent-success defect: the `*​/*` catch-all does NOT throw for a gate-made
 * proposal — it emits `.validated`, flips the row APPROVED and returns success
 * while nothing is written. These tests DRIVE the executor (not a source-text
 * scan) so they measure that approval actually applies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const PROPOSALS = { __table: "proposals" } as const;

let proposalRows: { status: string }[] = [];
let updates: { values: Record<string, unknown> }[] = [];

const whereResult = (rows: unknown[]) =>
  Object.assign(Promise.resolve(rows), { limit: async () => rows });

vi.mock("@synap/database", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => whereResult(proposalRows) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ values });
        return { where: async () => undefined };
      },
    }),
  },
  proposals: PROPOSALS,
  eq: () => ({}),
}));

vi.mock("@synap/database/schema", () => ({
  ProposalStatus: { APPROVED: "approved" },
}));

/** What `createRuleGoverned` returns — set per test. */
let ruleResult: Record<string, unknown>;
const createRuleGoverned = vi.fn(
  async (_input: Record<string, unknown>) => ruleResult
);
vi.mock("../../../services/rules/create.js", () => ({
  createRuleGoverned: (input: Record<string, unknown>) =>
    createRuleGoverned(input),
}));

const { registerRuleExecutors } = await import("../executors/rule.js");
const { proposalExecRegistry } = await import("../execution-registry.js");

registerRuleExecutors();
const executor = proposalExecRegistry.resolveExact("rule/create");

const AGENT = "agent-user-1";
const APPROVER = "human-approver";

const run = async (data: Record<string, unknown>) => {
  if (!executor) throw new Error("rule/create executor not registered");
  return executor.execute({
    proposal: {
      id: "p1",
      targetType: "rule",
      targetId: "rule-1",
      proposalType: "create",
      workspaceId: "ws-1",
      sessionId: null,
      projectId: null,
      agentUserId: AGENT,
      sourceMessageId: null,
      data: { data },
    },
    payload: null,
    userId: APPROVER,
    input: { proposalId: "p1" },
    ctx: {} as never,
    deps: {
      db: {},
      emitProposalReviewed: () => undefined,
      reportProposalOutcome: () => undefined,
    } as never,
  });
};

// Deliberately carries EVERY field the propose gate stores, so the replay
// tripwire below fails the day the payload grows a field the executor drops.
// `trust` is gone on purpose — it granted nothing (governance_rules is the real
// authorization store), so it is no longer stored or replayed.
const FULL_PAYLOAD = {
  id: "rule-1",
  intent: "Inside that Drive folder, one subfolder per client.",
  scope: { kind: "workspace", workspaceId: "ws-1", projectId: "prj-9" },
  expiresAt: "2027-01-01T00:00:00.000Z",
  factSkillId: "skill-77",
  automationIds: ["auto-88"],
};

beforeEach(() => {
  createRuleGoverned.mockClear();
  proposalRows = [];
  updates = [];
  ruleResult = { status: "created", ruleId: "rule-1" };
});

describe("rule/create approval APPLIES (never re-proposes)", () => {
  it("the executor is registered under the exact door key", () => {
    // The governed-writes tripwire reads `resolveExact` — a wildcard match
    // would make its coverage verdict vacuous.
    expect(proposalExecRegistry.resolveExact("rule/create")).toBeDefined();
  });

  it("re-runs the canonical rule door as the APPROVER, not as the agent", async () => {
    await run(FULL_PAYLOAD);
    expect(createRuleGoverned).toHaveBeenCalledTimes(1);
    const args = createRuleGoverned.mock.calls[0]?.[0];
    expect(args?.userId).toBe(APPROVER);
    // No agentUserId ⇒ the re-entrant gate auto-grants for the operator
    // authority instead of filing a second proposal.
    expect(args?.agentUserId).toBeUndefined();
  });

  it("replays the FULL stored payload — not just an id", async () => {
    await run(FULL_PAYLOAD);
    const args = createRuleGoverned.mock.calls[0]?.[0];
    expect(args?.intent).toBe(FULL_PAYLOAD.intent);
    // Scope must survive WHOLE — a dropped projectId silently rescopes the rule.
    expect(args?.scope).toEqual({
      kind: "workspace",
      workspaceId: "ws-1",
      projectId: "prj-9",
    });
    expect(args?.expiresAt).toBe("2027-01-01T00:00:00.000Z");
    expect(args?.factSkillId).toBe("skill-77");
    expect(args?.automationIds).toEqual(["auto-88"]);
  });

  it("stores what the replay produced, so the record is replayable", async () => {
    await run(FULL_PAYLOAD);
    const materialized = updates.at(-1)?.values.data as {
      materialized?: Record<string, unknown>;
    };
    expect(materialized?.materialized).toMatchObject({
      ruleId: "rule-1",
      factSkillId: "skill-77",
      automationIds: ["auto-88"],
    });
  });

  it("THROWS when the replay re-proposed instead of applying", async () => {
    ruleResult = { status: "proposed", proposalId: "p2" };
    await expect(run(FULL_PAYLOAD)).rejects.toThrow(/role/i);
    // The original proposal must stay PENDING — no status flip on this path.
    expect(updates).toHaveLength(0);
  });

  it("is idempotent — an already-approved proposal does not double-create", async () => {
    proposalRows = [{ status: "approved" }];
    const result = await run(FULL_PAYLOAD);
    expect(result).toMatchObject({ alreadyApproved: true });
    expect(createRuleGoverned).not.toHaveBeenCalled();
  });

  it("rejects a payload with no intent rather than approving an empty shell", async () => {
    await expect(run({ id: "rule-1" })).rejects.toThrow(/intent/i);
  });
});
