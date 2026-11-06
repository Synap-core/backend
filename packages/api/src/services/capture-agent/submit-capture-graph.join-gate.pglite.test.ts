/**
 * A capture graph into a space the agent has not joined lands WHOLE or not at
 * all (finding 590ca76a).
 *
 * THE DEFECT: an agent with no membership in a space sent a 10-entity graph
 * pinned to it. The graph auto-applied, so its entities reached the entity
 * door one at a time; the first one's gate filed a workspace JOIN and kept
 * that ONE write on it, the materializer then stopped with "was routed to
 * review … so this graph could not be applied", and approving the join
 * replayed only that first entity. The receipt read `approval_failed`, the
 * other nine were lost, and the resend was flagged a duplicate of the orphan.
 *
 * Driven through the REAL `submitCaptureGraph` (duplicate door, preflight,
 * the join park), the REAL join gate (`checkPermissionOrPropose` →
 * `maybeCreateWorkspaceJoinProposal` → the deferred write), the REAL
 * `workspace/join` executor and replay engine, and the REAL
 * `materializeCompositeGraph`, on PGlite with every table.
 *
 * Stubbed, and why:
 *   - the agent-governance verdict → `execute`, so the graph takes the
 *     auto-apply terminal, the one the incident took;
 *   - the two proposal writers → plain inserts of the same row (the event
 *     spine has its own suites);
 *   - the entity DOOR → a recorder that keeps the door's membership rule: a
 *     write by an agent that is not a member goes through the REAL gate
 *     (which files the join and keeps the write, exactly as `entities.create`
 *     answers then); a member's write is recorded as created. NOT covered
 *     here: the door's full ladder on replay (the existing deferred-writes
 *     suite stubs it the same way);
 *   - the op idempotency link store → an in-memory one.
 *
 * Rows, each ruling out a wrong outcome:
 *  - before approval NOTHING is created and no capture proposal is filed
 *    (rules out the half-land: one entity kept, the rest dropped);
 *  - the join holds ONE kept write, the whole graph (rules out keeping each
 *    entity as its own write, which could replay half);
 *  - a resend is kept once (rules out a twin graph on the join);
 *  - approving the join creates all 3, as the agent, after the membership
 *    row exists (rules out a replay of one entity, or a replay before access).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  created: [] as Array<{
    title: unknown;
    actingAgent: string | undefined;
    isMember: boolean;
  }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-identity-service.js")>()),
  getAgentFocusProjectId: vi.fn(async () => null),
}));
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: vi.fn(async () => ({ decision: "execute" })),
}));
vi.mock("../../utils/audit-log.js", () => ({
  auditLog: async () => ({ id: randomUUID() }),
}));

/** A proposals row of the same fields the real writers store. */
async function insertProposal(
  status: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const id = (input.id as string | undefined) ?? randomUUID();
  await h.client!.query(
    `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, agent_user_id, created_by, session_id, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now(), now())`,
    [
      id,
      status,
      input.proposalType,
      input.targetType,
      input.targetId,
      input.workspaceId ?? null,
      input.agentUserId ?? null,
      input.createdBy ?? input.userId,
      input.sessionId ?? null,
      JSON.stringify(input.data ?? {}),
    ]
  );
  return {
    id,
    data: input.data,
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? null,
  };
}
vi.mock("../../utils/event-backed-proposal.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/event-backed-proposal.js")
  >()),
  createEventBackedProposal: async (input: Record<string, unknown>) => ({
    proposal: await insertProposal("pending", input),
    requestedEvent: null,
    correlationId: "c",
  }),
  createAutoApprovedProposal: async (input: Record<string, unknown>) => ({
    proposal: await insertProposal("auto_approved", input),
    requestedEvent: null,
    completedEvent: null,
    correlationId: "c",
  }),
}));
vi.mock("../../utils/entity-link-idempotency.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/entity-link-idempotency.js")
  >()),
  makeExternalLinkIdempotency: (
    _db: unknown,
    o: { namespace: string; provider: string }
  ) => ({
    namespace: o.namespace,
    provider: o.provider,
    lookup: async () => null,
    register: async () => undefined,
    relationExists: async () => false,
  }),
}));

async function isMember(workspaceId: string, userId: string) {
  const { rows } = await h.client!.query<{ n: number }>(
    `select count(*)::int as n from workspace_members where workspace_id = $1 and user_id = $2`,
    [workspaceId, userId]
  );
  return rows[0]!.n > 0;
}

/**
 * The entity door, keeping its membership rule: an agent that is not a member
 * reaches the real gate, which files the join and keeps the write; the door
 * then answers `proposed`, as `entities.create` does on a join gate.
 */
vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: {
    createCaller: (ctx: Record<string, unknown>) => ({
      create: async (input: Record<string, unknown>) => {
        const { getActingAgentUserId } = await import("@synap/database");
        const agent = getActingAgentUserId();
        const workspaceId = String(
          input.targetWorkspaceId ?? ctx.workspaceId ?? ""
        );
        const member = agent ? await isMember(workspaceId, agent) : true;
        if (!member) {
          const { checkPermissionOrPropose } =
            await import("../../utils/permission-check.js");
          const perm = await checkPermissionOrPropose({
            userId: String(ctx.userId),
            agentUserId: agent,
            workspaceId,
            subjectType: "entity",
            action: "create",
            data: {
              id: randomUUID(),
              profileSlug: input.profileSlug,
              title: input.title,
            },
          } as Parameters<typeof checkPermissionOrPropose>[0]);
          if ("proposalId" in perm) {
            return {
              status: "proposed",
              proposalId: perm.proposalId,
              proposalType: perm.proposalType,
              ...(perm.deferred
                ? { deferred: true, ref: perm.deferredRef }
                : {}),
            };
          }
        }
        h.created.push({
          title: input.title,
          actingAgent: agent,
          isMember: member,
        });
        return { status: "created", id: randomUUID() };
      },
    }),
  },
}));
vi.mock("../../routers/relations.js", () => ({
  relationsRouter: {
    createCaller: () => ({ create: async () => ({ id: randomUUID() }) }),
  },
}));

import { ProfileResolutionService, runWithActingAgent } from "@synap/database";
import {
  allSchemaTables,
  pgliteSchemaDdl,
} from "../../__tests__/pglite-ddl.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";
import { registerWorkspaceExecutors } from "../../routers/proposals/executors/workspace.js";

const { submitCaptureGraph } = await import("./submit-capture-graph.js");

const HUMAN = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const TITLES = [
  "Churn signal: seat count dropped",
  "Renewal call with Acme",
  "Pricing objection from Acme",
];

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl(allSchemaTables()));
  await h.client!.exec(
    `create unique index on workspace_members (workspace_id, user_id);`
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'h@x', 'Human', 'human'), ($2, 'a@x', 'Scout', 'agent')`,
    [HUMAN, AGENT]
  );
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings, archived_at) values ($1, 'Sales', $2, 'team', '{}'::jsonb, null)`,
    [WS, HUMAN]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, HUMAN]
  );
  registerWorkspaceExecutors();
}, 120_000);

beforeEach(async () => {
  vi.spyOn(
    ProfileResolutionService.prototype,
    "resolveProfile"
  ).mockResolvedValue(null as never);
  await q(`delete from proposals`);
  await q(`delete from workspace_members where user_id = $1`, [AGENT]);
  h.created.length = 0;
});

/** The agent's graph, sent as the MCP door sends it (inside its key scope). */
function captureAsAgent() {
  return runWithActingAgent(AGENT, () =>
    submitCaptureGraph({
      userId: HUMAN,
      agentUserId: AGENT,
      workspaceId: WS,
      source: "agent",
      summary: "Acme renewal notes",
      entities: TITLES.map((title, i) => ({
        ref: `n${i}`,
        profileSlug: "note",
        title,
        properties: {},
      })),
    } as Parameters<typeof submitCaptureGraph>[0])
  );
}

async function proposalRows() {
  const { rows } = await q<{
    id: string;
    status: string;
    proposal_type: string;
    data: Record<string, unknown>;
  }>(`select id, status, proposal_type, data from proposals`);
  return rows;
}

async function approveJoin(proposalId: string) {
  const [row] = (
    await q<{ data: unknown }>(`select data from proposals where id = $1`, [
      proposalId,
    ])
  ).rows;
  return proposalExecRegistry.resolveExact("workspace/join")!.execute({
    proposal: {
      id: proposalId,
      targetType: "workspace",
      targetId: WS,
      proposalType: "join",
      workspaceId: WS,
      sessionId: null,
      projectId: null,
      agentUserId: AGENT,
      sourceMessageId: null,
      data: row!.data,
    },
    payload: null,
    userId: HUMAN,
    input: { proposalId },
    ctx: {} as never,
    deps: {
      emitProposalReviewed: () => undefined,
      reportProposalOutcome: () => undefined,
    } as never,
  });
}

describe("a capture graph into a space the agent has not joined (590ca76a)", () => {
  it("writes nothing, keeps the WHOLE graph on the join, and says so", async () => {
    const result = await captureAsAgent();

    expect(h.created).toEqual([]);
    const rows = await proposalRows();
    expect(rows.map((r) => r.proposal_type)).toEqual(["join"]);
    const join = rows[0]!;

    expect(result.applied).toBe(false);
    expect(result.proposalId).toBe(join.id);
    expect(result.writeReceipt).toMatchObject({
      state: "pending",
      proposalId: join.id,
    });
    expect(result.joinGate).toMatchObject({
      proposalId: join.id,
      deferred: true,
    });
    expect(result.joinGate?.message).toMatch(/do not resend/);

    const kept = join.data.deferredWrites as Array<{
      ref: string;
      subjectType: string;
      action: string;
      data: { entities: Array<{ title: string }>; workspaceId: string };
    }>;
    expect(kept).toHaveLength(1);
    expect(`${kept[0]!.subjectType}/${kept[0]!.action}`).toBe(
      "entity/capture.graph"
    );
    expect(kept[0]!.ref).toBe(result.joinGate?.ref);
    expect(kept[0]!.data.entities.map((e) => e.title)).toEqual(TITLES);
    expect(kept[0]!.data.workspaceId).toBe(WS);
  });

  it("a resend before approval is kept once, on the same join", async () => {
    const first = await captureAsAgent();
    const again = await captureAsAgent();
    expect(again.proposalId).toBe(first.proposalId);
    expect(again.joinGate?.ref).toBe(first.joinGate?.ref);
    const [join] = await proposalRows();
    expect((join!.data.deferredWrites as unknown[]).length).toBe(1);
    expect(h.created).toEqual([]);
  });

  it("approving the join applies all 3 entities, as the agent, once it is a member", async () => {
    const result = await captureAsAgent();
    const joinId = result.proposalId!;

    await approveJoin(joinId);

    expect(h.created.map((c) => c.title)).toEqual(TITLES);
    for (const c of h.created) {
      expect(c).toMatchObject({ actingAgent: AGENT, isMember: true });
    }
    const rows = await proposalRows();
    const join = rows.find((r) => r.id === joinId)!;
    const outcomes = join.data.deferredOutcomes as Record<
      string,
      { outcome: string; id?: string }
    >;
    const outcome = outcomes[result.joinGate!.ref!]!;
    expect(outcome.outcome).toBe("applied");
    // The replay's own receipt: one auto-applied capture graph.
    const receipt = rows.find((r) => r.id === outcome.id)!;
    expect(receipt).toMatchObject({
      status: "auto_approved",
      proposal_type: "capture.graph",
    });
  });
});
