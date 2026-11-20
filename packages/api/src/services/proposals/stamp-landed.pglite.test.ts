/**
 * WRITE time — the landed stamp. An approval's executor result (the real
 * `automation/create` executor) reaches `data.landed` through `stampLanded`,
 * joined with what the apply recorded on the row. Stamped once, and only on an
 * applied row. PGlite tables derived from the Drizzle schema.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: () => undefined,
}));

import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";
import { registerAutomationExecutors } from "../../routers/proposals/executors/automation.js";
import { stampLanded } from "./stamp-landed.js";

const PERSON = "person-1";
const WS = randomUUID();
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const FLOW = {
  nodes: [
    {
      id: "n1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { triggerType: "manual", label: "Manual", config: {} },
    },
  ],
  edges: [],
};
const DATA_CONTRACT = {
  version: 1,
  mode: "react",
  gets: [
    {
      id: "manual-input",
      label: "Manual request",
      origin: "manual",
      event: "The person starts it",
      nodeIds: ["n1"],
    },
  ],
  stores: [],
  reacts: [
    { id: "run", label: "Run the process", kind: "process", nodeIds: ["n1"] },
  ],
};

async function insertProposal(p: {
  status: string;
  proposalType: string;
  targetType: string;
  data: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, created_by, subject_user_id, data)
     values ($1, $2, $3, $4, $5, $6, $7, $7, $8::jsonb)`,
    [
      id,
      WS,
      p.targetType,
      randomUUID(),
      p.proposalType,
      p.status,
      PERSON,
      JSON.stringify(p.data),
    ]
  );
  return id;
}

async function landedOf(id: string): Promise<unknown> {
  const { rows } = await q<{ data: Record<string, unknown> }>(
    `select data from proposals where id = $1`,
    [id]
  );
  return rows[0]!.data.landed;
}

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  registerAutomationExecutors();
}, 120_000);

beforeEach(async () => {
  await h.client!.exec("delete from automations; delete from proposals;");
});

describe("stampLanded — what an approval made, written once", () => {
  it("stamps the object the executor created", async () => {
    const automationId = randomUUID();
    const data = {
      targetType: "automation",
      changeType: "create",
      data: {
        name: "Weekly digest",
        triggerType: "manual",
        triggerConfig: {},
        flowDefinition: FLOW,
        metadata: { dataContract: DATA_CONTRACT },
      },
    };
    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, created_by, subject_user_id, data)
       values ($1, $2, 'automation', $3, 'create', 'pending', $4, $4, $5::jsonb)`,
      [proposalId, WS, automationId, PERSON, JSON.stringify(data)]
    );
    const result = await proposalExecRegistry.resolve("automation/create")!
      .execute({
        proposal: {
          id: proposalId,
          targetType: "automation",
          targetId: automationId,
          proposalType: "create",
          workspaceId: WS,
          sessionId: null,
          projectId: null,
          agentUserId: null,
          createdBy: PERSON,
          subjectUserId: PERSON,
          sourceMessageId: null,
          data,
        },
        payload: data.data,
        userId: PERSON,
        input: { proposalId },
        ctx: {} as never,
        deps: {
          reportProposalOutcome: () => undefined,
          emitProposalReviewed: () => undefined,
        },
      } as never);
    expect(result.primaryId).toBeTruthy();

    await stampLanded(proposalId, result);
    expect(await landedOf(proposalId)).toEqual([
      { kind: "automation", id: result.primaryId, role: "created" },
    ]);

    // Once: a later stamp (a re-approve joining it) changes nothing.
    await stampLanded(proposalId, { primaryId: randomUUID() });
    expect(await landedOf(proposalId)).toEqual([
      { kind: "automation", id: result.primaryId, role: "created" },
    ]);
  });

  it("joins the apply's records; a run's primary is its session, a key is nothing", async () => {
    const s1 = randomUUID();
    const s2 = randomUUID();
    const run = await insertProposal({
      status: "approved",
      proposalType: "run",
      targetType: "playbook",
      data: { runResult: { started: [{ sessionId: s1 }, { sessionId: s2 }] } },
    });
    await stampLanded(run, { primaryId: s1, primaryKind: "session" });
    expect(await landedOf(run)).toEqual([
      { kind: "session", id: s1, role: "created" },
      { kind: "session", id: s2, role: "created" },
    ]);

    const key = await insertProposal({
      status: "approved",
      proposalType: "connect",
      targetType: "agent",
      data: {},
    });
    await stampLanded(key, {
      primaryId: randomUUID(),
      primaryKind: null,
      effect: { applied: "verified", rows: 1, ids: [randomUUID()], subject: "api_keys" },
    });
    expect(await landedOf(key)).toEqual([]);
  });

  it("a verified effect's ids land under the kind of the table it wrote", async () => {
    const moved = randomUUID();
    const id = await insertProposal({
      status: "approved",
      proposalType: "update_pack",
      targetType: "entity",
      data: {},
    });
    await stampLanded(id, {
      effect: { applied: "verified", rows: 1, ids: [moved], subject: "entities" },
    });
    expect(await landedOf(id)).toEqual([
      { kind: "entity", id: moved, role: "updated" },
    ]);
  });

  it("an undecided row is not stamped", async () => {
    const id = await insertProposal({
      status: "pending",
      proposalType: "create",
      targetType: "automation",
      data: {},
    });
    await stampLanded(id, { primaryId: randomUUID() });
    expect(await landedOf(id)).toBeUndefined();
  });
});
