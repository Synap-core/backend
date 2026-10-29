/**
 * The re-decision of an agent's own revised capture graph (structural plan S4).
 *
 * THE INVARIANT (founder Q-S4, research fbb1eef7 §2): a revision never turns a
 * FLOORED write into an automatic one. A graph the filing parked on a floor
 * (`ruleCanReachReason` false) stays pending even when its revised content,
 * filed fresh, would execute. The discriminating pair is the same revised
 * graph with the same verdict: stored on a floor ⇒ pending, stored on a
 * re-decidable reason (none, or a lifecycle close a rule can reach) ⇒ applied.
 *
 * Also pinned: the apply is a compare-and-set (pending, the agent's, this
 * revision) and a lost claim materializes nothing; a graph that still proposes
 * keeps waiting with the reason of its NEW content; a possible twin keeps it
 * pending (the proposal's own creates are not its twins); a person's or
 * another agent's revision, and a non-capture graph, are not re-decided.
 *
 * Collaborators are scripted at their module seams; the db is a recording
 * fake whose `where` clauses are compiled to SQL and read back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  claimReturns: true,
  verdict: { proposes: false, reasonCode: null as string | null },
  duplicateStatus: "clear" as string,
  pendingSeen: [] as unknown[],
  materialize: vi.fn(),
  stamp: vi.fn(),
}));

// PARTIAL mock (database-mock-total-ratchet): real tables and operators, a
// recording `db`.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => (h.row ? [h.row] : []) }),
        }),
      }),
      update: () => ({
        set: (set: Record<string, unknown>) => ({
          where: (where: unknown) => {
            h.updates.push({ set, where });
            const done = Promise.resolve(undefined);
            return Object.assign(done, {
              returning: async () =>
                h.claimReturns ? [{ id: "prop-1", data: h.row?.data }] : [],
            });
          },
        }),
      }),
    },
    getWorkspaceMembership: async () => ({ role: "owner" }),
  };
});
vi.mock("../capture-agent/capture-graph-governance.js", () => ({
  captureGraphMemberVerdict: async () => h.verdict,
}));
vi.mock("../capture-agent/submit-capture-graph.js", () => ({
  materializeAgentGraphUnderReceipt: h.materialize,
}));
vi.mock("../duplicates/find-duplicate-candidates.js", () => ({
  loadOwnPendingCreates: async () => ({
    creates: [
      { proposalId: "prop-1", title: "Jane Doe" },
      { proposalId: "other", title: "Someone" },
    ],
    truncated: false,
  }),
  findDuplicateCandidates: async (_db: unknown, q: { pending: unknown }) => {
    h.pendingSeen.push(q.pending);
    return { check: { status: h.duplicateStatus } };
  },
}));
vi.mock("./stamp-materialized.js", () => ({
  buildMaterializedRecord: () => ({ entityIds: ["ent-1"] }),
  stampMaterialized: h.stamp,
}));
vi.mock("../../notifications/mark-proposal-notifications-actioned.js", () => ({
  markProposalNotificationsActioned: () => undefined,
}));

const { redecideOwnGraphRevision } =
  await import("./redecide-graph-revision.js");

const AGENT = "agent-1";
const OWNER = "owner-1";
const dialect = new PgDialect();
const sqlOf = (where: unknown) => dialect.sqlToQuery(where as SQL);

const revisedGraph = {
  graphSource: "capture",
  source: "agent",
  idempotencyKey: "idem-1",
  operations: [
    {
      op: "create_entity",
      ref: "u1",
      profileSlug: "user_observation",
      title: "Prefers async",
      properties: { uo_validated: true },
    },
  ],
};

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "prop-1",
    status: "pending",
    proposalType: "import.graph",
    agentUserId: AGENT,
    subjectUserId: OWNER,
    workspaceId: null,
    sessionId: "sess-1",
    governanceReason: null,
    revisionHistory: [{}],
    data: revisedGraph,
    ...overrides,
  };
}

const redecide = () =>
  redecideOwnGraphRevision({
    proposalId: "prop-1",
    actingAgentUserId: AGENT,
    revisions: 1,
  });

beforeEach(() => {
  h.updates.length = 0;
  h.pendingSeen.length = 0;
  h.claimReturns = true;
  h.verdict = { proposes: false, reasonCode: null };
  h.duplicateStatus = "clear";
  h.materialize.mockReset();
  h.materialize.mockResolvedValue({ entities: [], relations: [] });
  h.stamp.mockReset();
  h.row = pendingRow();
});

describe("a floored write stays floored after the agent's revise", () => {
  // Each is a floor (`GOVERNANCE_REASON_RULE_REACH` "floor"), or a code the
  // ladder never classified (fails closed).
  const FLOORS = [
    "USER_OBSERVATION_INFERENCE",
    "DAILY_WRITE_CEILING",
    "POSSIBLE_DUPLICATE",
    "UNTRUSTED_ORIGIN",
    "HUMAN_ONLY_STATUS",
    "SCOPE_IDENTITY_CHANGE",
    "NOT_A_KNOWN_CODE",
  ];
  for (const floor of FLOORS) {
    it(`stored ${floor}: the revised graph would execute, and it still waits — nothing claimed, nothing created`, async () => {
      h.row = pendingRow({ governanceReason: floor });
      await expect(redecide()).resolves.toEqual({
        outcome: "pending",
        reason: floor,
      });
      expect(h.updates).toEqual([]);
      expect(h.materialize).not.toHaveBeenCalled();
    });
  }

  // The discriminating rows: SAME revised graph, SAME executing verdict.
  for (const reachable of [null, "LIFECYCLE_TERMINAL", "GOVERNANCE_RULE"]) {
    it(`stored ${String(reachable)} (a rule can reach it): the same revision is applied`, async () => {
      h.row = pendingRow({ governanceReason: reachable });
      await expect(redecide()).resolves.toEqual({
        outcome: "applied",
        proposalId: "prop-1",
      });
      expect(h.materialize).toHaveBeenCalledTimes(1);
    });
  }
});

describe("the apply is a compare-and-set, then the auto path's materializer", () => {
  it("claims pending → auto_approved only while pending, the agent's, at this revision", async () => {
    await redecide();
    expect(h.updates).toHaveLength(1);
    const { set, where } = h.updates[0]!;
    expect(set).toMatchObject({
      status: "auto_approved",
      reviewedBy: OWNER,
      governanceReason: null,
    });
    const { sql, params } = sqlOf(where);
    expect(sql).toContain('"status" = $');
    expect(params).toContain("pending");
    expect(sql).toContain('"agent_user_id" = $');
    expect(params).toContain(AGENT);
    expect(sql).toMatch(
      /jsonb_array_length\(COALESCE\("proposals"\."revision_history"/
    );
    expect(params).toContain(1);
  });

  it("materializes under the claimed row as its receipt, as the owner, then stamps what landed", async () => {
    await redecide();
    expect(h.materialize).toHaveBeenCalledTimes(1);
    const [ctx, input] = h.materialize.mock.calls[0]!;
    expect(ctx).toMatchObject({
      userId: OWNER,
      workspaceId: null,
      workspaceRole: "owner",
      sessionId: "sess-1",
      governanceProposalId: "prop-1",
    });
    expect(input).toMatchObject({
      receipt: { id: "prop-1" },
      operations: revisedGraph.operations,
      agentUserId: AGENT,
      source: "agent",
      idempotencyKey: "idem-1",
    });
    expect(h.stamp).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: "prop-1" })
    );
  });

  it("a lost claim (a person decided or revised first) materializes nothing", async () => {
    h.claimReturns = false;
    await expect(redecide()).resolves.toEqual({ outcome: "superseded" });
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it("a failed materialization reports failed and never throws", async () => {
    h.materialize.mockRejectedValue(new Error("boom"));
    await expect(redecide()).resolves.toEqual({
      outcome: "failed",
      proposalId: "prop-1",
    });
  });
});

describe("a graph that still waits keeps the reason of its new content", () => {
  it("a member still proposes: the new reason is stored, the status is not touched", async () => {
    h.verdict = { proposes: true, reasonCode: "LIFECYCLE_TERMINAL" };
    await expect(redecide()).resolves.toEqual({
      outcome: "pending",
      reason: "LIFECYCLE_TERMINAL",
    });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.set).not.toHaveProperty("status");
    expect(h.updates[0]!.set).toMatchObject({
      governanceReason: "LIFECYCLE_TERMINAL",
    });
    expect(sqlOf(h.updates[0]!.where).params).toContain("pending");
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it("a possible twin keeps it pending as POSSIBLE_DUPLICATE; its own creates are not its twins", async () => {
    h.duplicateStatus = "possible";
    await expect(redecide()).resolves.toEqual({
      outcome: "pending",
      reason: "POSSIBLE_DUPLICATE",
    });
    expect(h.materialize).not.toHaveBeenCalled();
    const seen = h.pendingSeen[0] as { creates: Array<{ proposalId: string }> };
    expect(seen.creates.map((c) => c.proposalId)).toEqual(["other"]);
  });

  it("channel bindings keep it pending, as at filing", async () => {
    h.row = pendingRow({
      data: { ...revisedGraph, bindings: [{ channelId: "c1" }] },
    });
    await expect(redecide()).resolves.toMatchObject({ outcome: "pending" });
    expect(h.updates).toEqual([]);
    expect(h.materialize).not.toHaveBeenCalled();
  });
});

describe("only the agent's own revision of a capture graph is re-decided", () => {
  it("another agent's proposal: not re-decided", async () => {
    h.row = pendingRow({ agentUserId: "agent-2" });
    await expect(redecide()).resolves.toBeNull();
    expect(h.updates).toEqual([]);
  });

  it("not a capture graph: not re-decided", async () => {
    h.row = pendingRow({ data: { ...revisedGraph, graphSource: "import" } });
    await expect(redecide()).resolves.toBeNull();
    h.row = pendingRow({ proposalType: "create" });
    await expect(redecide()).resolves.toBeNull();
    expect(h.updates).toEqual([]);
  });

  it("revised again since (the count moved): not re-decided", async () => {
    h.row = pendingRow({ revisionHistory: [{}, {}] });
    await expect(redecide()).resolves.toBeNull();
    expect(h.updates).toEqual([]);
  });

  it("already decided: not re-decided", async () => {
    h.row = pendingRow({ status: "approved" });
    await expect(redecide()).resolves.toBeNull();
    expect(h.updates).toEqual([]);
  });
});
