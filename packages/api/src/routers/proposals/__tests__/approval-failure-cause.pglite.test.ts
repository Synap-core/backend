/**
 * AN APPROVAL THAT FAILS KEEPS ITS EXACT CAUSE FOR THE OWNER, AND A FAILURE
 * NOBODY SAW REACHES THEIR BELL — on a real Postgres (PGlite).
 *
 * Plan 8032a127, D5 and D6 (finding 7ca4953f: rows said "an internal error
 * occurred" and the cause was readable only over ssh):
 *  - every writer of `approval_failed` records the error in `server_faults`
 *    (door `proposal`) and stores ONLY its id on the row (`data.failure.errorId`):
 *    the approve door's dispatch failure, its plan failure, and the receipt's
 *    materialization failure (`runMaterializationUnderReceipt`);
 *  - a person who clicked Approve read the failure in their answer: no bell row;
 *  - a failure with no person in the loop (the background job, an agent's
 *    receipt) notifies the proposal's human owner ONCE, and approving the
 *    proposal settles that row.
 *
 * Stubbed as in `background-approval.pglite.test.ts`: the materializer and the
 * doors behind it, the realtime and IS fan-out. Every table is built from the
 * Drizzle schema, `proposal_apply_runs` from its migration.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  /** What the stubbed materializer does. */
  behaviour: undefined as undefined | (() => Promise<void>),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: () => {},
  getBoss: () => ({ send: async () => randomUUID() }),
}));
vi.mock("../approve-executors.js", () => ({
  registerApproveExecutors: () => {},
}));
vi.mock("../graph-dispositions.js", () => ({
  applyGraphDispositions: (ops: unknown) => ops,
  survivingEntityDecisionSlices: () => [],
  survivingEntityFacetSlices: () => ({}),
  foldFacetsIntoOps: (ops: unknown) => ops,
}));
vi.mock("../../entities.js", () => ({
  entitiesRouter: { createCaller: () => ({}) },
}));
vi.mock("../../relations.js", () => ({
  relationsRouter: { createCaller: () => ({}) },
}));
vi.mock("../../../utils/materialize-composite.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  materializeCompositeGraph: async () => {
    await holder.behaviour?.();
    return {
      created: 0,
      linked: 0,
      primaryId: "ent-0",
      refToRealId: {},
      entities: [{ ref: "e0", entityId: "ent-0", linked: true }],
      relations: [],
      relationsFailed: [],
    };
  },
}));
vi.mock("../../../services/proposals/reconcile-proposal-properties.js", () => ({
  reconcileApprovedProperties: async (a: unknown) => a,
}));
vi.mock("../../../services/proposals/complete-knowledge-proposal.js", () => ({
  completeKnowledgeProposalProperties: () => undefined,
}));
vi.mock("../../../lib/ai-events.js", () => ({
  AI_KIND: { EXTRACT: "extract" },
}));
vi.mock("../../../utils/ai-feedback-events.js", () => ({
  emitAiCorrection: async () => {},
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => {},
}));
vi.mock("../../../realtime/socket-events.js", () => ({
  SERVER_CONVERSATION_EVENTS: {},
}));
vi.mock("../../../utils/intelligence-routing.js", () => ({
  getDefaultActiveService: async () => null,
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";

const { applyProposalApproval } = await import("../apply-approval.js");
const { proposalExecRegistry, registerProposalExecutor } =
  await import("../execution-registry.js");
const { BACKGROUND_APPROVAL_MIN_OPERATIONS, runApprovalJob } =
  await import("../../../services/proposals/approval-runs.js");
const { runMaterializationUnderReceipt } =
  await import("../../../services/proposals/stamp-materialized.js");
const { CompositePlanApplyError } =
  await import("../../../utils/materialize-composite.js");
const { resetServerFaultBudget } =
  await import("../../../services/server-faults/record.js");

type ApplyArgs = Parameters<typeof applyProposalApproval>[0];

// Synthetic ids: this repository is public.
const OWNER = "0b5e2c4f-0000-4000-8000-0000000000aa";
const AGENT = "0b5e2c4f-0000-4000-8000-0000000000bb";
const TOKEN = "sk-live-AbCdEf0123456789XYZ";
const FAILED_TYPE = "proposal.approval_failed";

let client: PGlite;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

const RUNS_MIGRATION = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../database/migrations/0352_proposal_apply_runs.sql"
  ),
  "utf8"
);

beforeAll(async () => {
  client = new PGlite();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  byName.delete("proposal_apply_runs");
  for (const t of byName.values()) await client.exec(ddlFor(t));
  await client.exec(RUNS_MIGRATION);
  holder.db = drizzle(client, { schema });
  // The agent's human owner: who an agent's proposal notifies.
  await client.query(
    `insert into users (id, email, created_by_user_id) values ($1, 'agent@example.test', $2)`,
    [AGENT, OWNER]
  );

  // An executor that fails the way a provider does: its body echoes the key.
  proposalExecRegistry._reset();
  registerProposalExecutor({
    key: "messaging.external.send" as never,
    execute: async () => {
      throw new Error(`Upstream 500: {"api_key":"${TOKEN}"} connection reset`);
    },
  });
}, 120_000);

async function insertProposal(opts: {
  type: "send" | "graph";
  size?: number;
  status?: string;
  agent?: boolean;
  source?: string;
}): Promise<ApplyArgs["proposal"]> {
  const id = randomUUID();
  const data =
    opts.type === "graph"
      ? {
          source: opts.source ?? "agent",
          operations: Array.from({ length: opts.size ?? 3 }, (_, i) => ({
            op: "create_entity",
            ref: `e${i}`,
            profileSlug: "person",
            title: `P${i}`,
          })),
        }
      : { summary: "Send a message", text: "hello" };
  await client.query(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, proposed_by_user_id, created_by, agent_user_id)
     values ($1, null, $2, 'x', $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      id,
      opts.type === "graph" ? "entity" : "message",
      opts.type === "graph" ? "capture.graph" : "messaging.external.send",
      JSON.stringify(data),
      opts.status ?? "pending",
      opts.agent ? null : OWNER,
      opts.agent ? AGENT : OWNER,
      opts.agent ? AGENT : null,
    ]
  );
  const row = await (
    holder.db as typeof import("@synap/database").db
  ).query.proposals.findFirst({ where: (p, { eq }) => eq(p.id, id) });
  return row!;
}

function approve(proposal: ApplyArgs["proposal"], background = false) {
  return applyProposalApproval({
    proposal,
    userId: OWNER,
    input: { proposalId: proposal.id },
    ctx: {} as ApplyArgs["ctx"],
    background,
  });
}

async function proposalRow(id: string) {
  const { rows } = await client.query<{
    status: string;
    data: { failure?: Record<string, unknown> };
  }>(`select status, data from proposals where id = $1`, [id]);
  return rows[0]!;
}

async function fault(errorId: unknown) {
  const { rows } = await client.query<Record<string, unknown>>(
    `select * from server_faults where error_id = $1`,
    [errorId]
  );
  return rows[0];
}

async function failureNotices(proposalId: string) {
  const { rows } = await client.query<{
    user_id: string;
    title: string;
    body: string;
    status: string;
  }>(
    `select user_id, title, body, status from notifications where type = $1 and source_id = $2`,
    [FAILED_TYPE, proposalId]
  );
  return rows;
}

/** The cause the row names exists, is the approval's, and leaks no key. */
async function expectCauseKept(proposalId: string, needle: string) {
  const row = await proposalRow(proposalId);
  expect(row.status).toBe("approval_failed");
  const errorId = row.data.failure?.errorId;
  expect(typeof errorId).toBe("string");
  const stored = await fault(errorId);
  expect(stored).toMatchObject({
    door: "proposal",
    path: `/proposal/${proposalId}`,
  });
  expect(JSON.stringify(stored)).toContain(needle);
  expect(stored!.stack).toBeTruthy();
  expect(JSON.stringify(stored)).not.toContain(TOKEN);
  // The row itself carries the id, never the raw text.
  expect(JSON.stringify(row.data)).not.toContain(TOKEN);
}

const proposalsDb = () => holder.db as typeof import("@synap/database").db;

async function reread(id: string): Promise<ApplyArgs["proposal"]> {
  return (await proposalsDb().query.proposals.findFirst({
    where: (p, { eq }) => eq(p.id, id),
  }))!;
}

/** A person clicks Approve on a send whose executor fails. */
async function failedClick() {
  resetServerFaultBudget();
  const proposal = await insertProposal({ type: "send" });
  await expect(approve(proposal)).rejects.toThrow();
  return proposal;
}

/** An agent's large graph: approved, the job's plan fails. */
async function failedJob() {
  resetServerFaultBudget();
  const proposal = await insertProposal({
    type: "graph",
    size: BACKGROUND_APPROVAL_MIN_OPERATIONS + 5,
    agent: true,
  });
  holder.behaviour = async () => {
    throw new CompositePlanApplyError(
      [{ op: "create_entity", ref: "e0", opIndex: 0, reason: "db exploded" }],
      { undone: {}, notCompensated: [] }
    );
  };
  const queued = await approve(proposal, true);
  expect(queued.queued).toBe(true);
  expect(await runApprovalJob({ runId: queued.approvalRun!.runId })).toEqual({
    status: "failed",
  });
  return proposal;
}

/** A receipt (an agent's, or the person's own) whose materialization throws. */
async function failedReceipt(by: "agent" | "person", message: string) {
  resetServerFaultBudget();
  const receipt = await insertProposal({
    type: "graph",
    status: "auto_approved",
    ...(by === "agent" ? { agent: true } : { source: "capture" }),
  });
  await expect(
    runMaterializationUnderReceipt(
      {
        id: receipt.id,
        data: receipt.data as Record<string, unknown>,
        createdBy: receipt.createdBy,
        agentUserId: receipt.agentUserId,
      },
      async () => {
        throw new Error(`${message}: Bearer ${TOKEN}`);
      },
      holder.db as never
    )
  ).rejects.toThrow();
  return receipt;
}

/** Give a fire-and-forget notifier its turn before asserting nothing came. */
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("the approve door's failure, after a person's click", () => {
  it("keeps the cause in server_faults and only its id on the row", async () => {
    const proposal = await failedClick();
    await expectCauseKept(proposal.id, "connection reset");
  });

  it("sends no bell row: they read the failure in their answer", async () => {
    const proposal = await failedClick();
    await settle();
    expect(await failureNotices(proposal.id)).toHaveLength(0);
  });
});

describe("the background job's failure, after the request returned", () => {
  it("keeps the cause in server_faults and only its id on the row", async () => {
    const proposal = await failedJob();
    await expectCauseKept(proposal.id, "db exploded");
  });

  it("notifies the owner ONCE, and the approval settles it", async () => {
    const proposal = await failedJob();
    let notices = await failureNotices(proposal.id);
    expect(notices).toHaveLength(1);
    // To the agent's human owner, never the agent.
    expect(notices[0]!.user_id).toBe(OWNER);
    expect(notices[0]!.body).toContain("The plan did not apply");

    // The job runs it again and fails again: still one open row.
    const again = await approve(await reread(proposal.id), true);
    await runApprovalJob({ runId: again.approvalRun!.runId });
    notices = await failureNotices(proposal.id);
    expect(notices).toHaveLength(1);

    // Approved at last: the row is settled with the proposal.
    holder.behaviour = undefined;
    const last = await approve(await reread(proposal.id), true);
    await runApprovalJob({ runId: last.approvalRun!.runId });
    expect((await proposalRow(proposal.id)).status).toBe("approved");
    await vi.waitFor(async () => {
      expect((await failureNotices(proposal.id))[0]!.status).toBe("actioned");
    });
  });
});

describe("a receipt whose materialization failed", () => {
  it("an agent's: keeps the cause, naming the agent", async () => {
    const receipt = await failedReceipt("agent", "materialize failed");
    await expectCauseKept(receipt.id, "materialize failed");
    const errorId = (await proposalRow(receipt.id)).data.failure?.errorId;
    expect((await fault(errorId))!.agent_user_id).toBe(AGENT);
  });

  it("an agent's: notifies the owner", async () => {
    const receipt = await failedReceipt("agent", "materialize failed");
    await vi.waitFor(async () => {
      const notices = await failureNotices(receipt.id);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.user_id).toBe(OWNER);
    });
  });

  it("the person's own: keeps the cause", async () => {
    const receipt = await failedReceipt("person", "failed in front of them");
    await expectCauseKept(receipt.id, "failed in front of them");
  });

  it("the person's own: no bell row, it failed in front of them", async () => {
    const receipt = await failedReceipt("person", "failed in front of them");
    await settle();
    expect(await failureNotices(receipt.id)).toHaveLength(0);
  });
});
