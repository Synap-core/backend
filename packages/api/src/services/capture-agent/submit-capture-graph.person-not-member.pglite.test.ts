/**
 * A capture graph lands WHOLE or not at all, and an agent writes only where
 * the person it acts for is a member.
 *
 * An agent whose person is not a member of a space the graph lands in is
 * refused BEFORE anything is written, though the agent itself holds a seat
 * there; once the person is a member the same graph applies whole.
 *
 * Driven through the REAL `submitCaptureGraph` (duplicate door, preflight,
 * the membership check) and the REAL `materializeCompositeGraph`, on PGlite
 * with every table. Stubbed, and why:
 *   - the agent-governance verdict → `execute`, so an admitted graph takes the
 *     auto-apply terminal;
 *   - the two proposal writers → plain inserts of the same row (the event
 *     spine has its own suites);
 *   - the entity DOOR → a recorder (its own gate has its own suites);
 *   - the op idempotency link store → an in-memory one.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  created: [] as Array<{ title: unknown; actingAgent: string | undefined }>,
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

vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: {
    createCaller: () => ({
      create: async (input: Record<string, unknown>) => {
        const { getActingAgentUserId } = await import("@synap/database");
        h.created.push({
          title: input.title,
          actingAgent: getActingAgentUserId(),
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
  // The agent's own seat: it grants nothing.
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, AGENT]
  );
}, 120_000);

beforeEach(async () => {
  vi.spyOn(
    ProfileResolutionService.prototype,
    "resolveProfile"
  ).mockResolvedValue(null as never);
  await q(`delete from proposals`);
  await q(`delete from workspace_members where user_id = $1`, [HUMAN]);
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

describe("a capture graph into a space its person is not a member of", () => {
  it("is refused before anything is written, though the agent holds a seat", async () => {
    await expect(captureAsAgent()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/person you act for is not a member/),
    });

    expect(h.created).toEqual([]);
    expect(await proposalRows()).toEqual([]);
  });

  it("control: once the person is a member, the whole graph applies as the agent", async () => {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
      [randomUUID(), WS, HUMAN]
    );

    const result = await captureAsAgent();

    expect(result.applied).toBe(true);
    expect(h.created.map((c) => c.title)).toEqual(TITLES);
    for (const c of h.created) expect(c.actingAgent).toBe(AGENT);
  });
});
