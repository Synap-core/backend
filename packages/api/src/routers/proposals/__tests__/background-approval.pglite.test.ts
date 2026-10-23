/**
 * A LARGE APPROVAL RUNS IN THE BACKGROUND, THROUGH THE SAME DOOR, AND ITS
 * PROGRESS SURVIVES — on a real Postgres (PGlite).
 *
 * THE DEFECT (founder, 2026-10-23, proposal abc79426): approving a
 * 4,222-operation import ran inside the request for ~15 minutes behind an
 * endless spinner; a proxy timeout could cut it half-applied.
 *
 * The seam, driven end to end:
 *   approve door (`applyProposalApproval`, `background: true`, every gate)
 *     → a `proposal_apply_runs` row (the table built from migration 0352's
 *       own SQL, partial unique index included) + a `proposal-approve` send
 *     → the job (`runApprovalJob`) → the real `completeProposalApproval` →
 *       the materializer's `onProgress` → progress rows → `succeeded`, the
 *       proposal approved.
 *
 * Stubbed: the materializer itself (it reports progress as the real one does;
 * the real one's settles are pinned in `materialize-composite-progress.test.ts`)
 * and the create doors behind it, the IS/realtime fan-out. Every other table
 * is built from the Drizzle schema.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  sends: [] as Array<{ queue: string; data: unknown; options: unknown }>,
  materializeCalls: 0,
  /** What the stubbed materializer does with the ops + options it is given. */
  behaviour: undefined as
    | undefined
    | ((ops: unknown[], options: Record<string, unknown>) => Promise<void>),
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
  getBoss: () => ({
    send: async (queue: string, data: unknown, options: unknown) => {
      holder.sends.push({ queue, data, options });
      return randomUUID();
    },
  }),
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
  materializeCompositeGraph: async (
    ops: unknown[],
    _e: unknown,
    _r: unknown,
    _onErr: unknown,
    options: Record<string, unknown>
  ) => {
    holder.materializeCalls++;
    await holder.behaviour?.(ops, options);
    // Entities LINKED, so project-membership stamping is a no-op.
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
vi.mock(
  "../../../notifications/mark-proposal-notifications-actioned.js",
  () => ({ markProposalNotificationsActioned: () => {} })
);

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";

const { applyProposalApproval } = await import("../apply-approval.js");
const {
  BACKGROUND_APPROVAL_MIN_OPERATIONS,
  readLatestApprovalRun,
  runApprovalJob,
} = await import("../../../services/proposals/approval-runs.js");

type ApplyArgs = Parameters<typeof applyProposalApproval>[0];

const APPROVER = "human-approver";
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

const MIGRATION = readFileSync(
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
  // The run table comes from the migration itself — not from the schema.
  byName.delete("proposal_apply_runs");
  for (const t of byName.values()) await client.exec(ddlFor(t));
  await client.exec(MIGRATION);
  holder.db = drizzle(client, { schema });
}, 120_000);

beforeEach(() => {
  holder.sends.length = 0;
  holder.materializeCalls = 0;
  holder.behaviour = undefined;
});

/** A pod-wide composite proposal of `size` operations, pending. */
async function insertProposal(size: number): Promise<ApplyArgs["proposal"]> {
  const id = randomUUID();
  const operations = Array.from({ length: size }, (_, i) =>
    i % 2 === 0
      ? {
          op: "create_entity",
          ref: `e${i}`,
          profileSlug: "person",
          title: `P${i}`,
        }
      : {
          op: "create_relation",
          sourceRef: `e${i - 1}`,
          targetRef: "e0",
          type: "knows",
        }
  );
  await client.query(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status)
     values ($1, null, 'entity', 'import', 'import.graph', $2::jsonb, 'pending')`,
    [id, JSON.stringify({ operations })]
  );
  const row = await (
    holder.db as typeof import("@synap/database").db
  ).query.proposals.findFirst({ where: (p, { eq }) => eq(p.id, id) });
  return row!;
}

function approve(
  proposal: ApplyArgs["proposal"],
  opts: { userId?: string; background?: boolean } = {}
) {
  return applyProposalApproval({
    proposal,
    userId: opts.userId ?? APPROVER,
    input: { proposalId: proposal.id },
    ctx: {} as ApplyArgs["ctx"],
    background: opts.background ?? true,
  });
}

async function runRow(runId: string) {
  const { rows } = await client.query<Record<string, unknown>>(
    `select * from proposal_apply_runs where id = $1`,
    [runId]
  );
  return rows[0]!;
}

async function proposalStatus(id: string): Promise<string> {
  const { rows } = await client.query<{ status: string }>(
    `select status from proposals where id = $1`,
    [id]
  );
  return rows[0]!.status;
}

const LARGE = BACKGROUND_APPROVAL_MIN_OPERATIONS + 20;

describe("the approve door hands a LARGE graph to the background", () => {
  it("returns queued at once, records the run and sends ONE job — nothing applied yet", async () => {
    const proposal = await insertProposal(LARGE);
    const result = await approve(proposal);

    expect(result).toMatchObject({
      success: true,
      queued: true,
      joined: false,
    });
    expect(result.approvalRun).toMatchObject({
      state: "queued",
      total: LARGE,
      done: 0,
    });
    const jobs = holder.sends.filter((s) => s.queue === "proposal-approve");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toEqual({ runId: result.approvalRun!.runId });
    // A redelivery would apply the graph twice: never retried.
    expect(jobs[0]!.options).toMatchObject({ retryLimit: 0 });
    expect(holder.materializeCalls).toBe(0);
    expect(await proposalStatus(proposal.id)).toBe("pending");
  });

  it("a small graph keeps today's instant apply, in the request", async () => {
    const proposal = await insertProposal(5);
    const result = await approve(proposal);
    expect(result.queued).toBeUndefined();
    expect(holder.materializeCalls).toBe(1);
    expect(
      holder.sends.filter((s) => s.queue === "proposal-approve")
    ).toHaveLength(0);
    expect(await proposalStatus(proposal.id)).toBe("approved");
  });

  it("a caller that did not opt in (batch, import.apply) still applies in the request", async () => {
    const proposal = await insertProposal(LARGE);
    const result = await approve(proposal, { background: false });
    expect(result.queued).toBeUndefined();
    expect(holder.materializeCalls).toBe(1);
  });
});

describe("the job applies it through the same door, and its progress persists", () => {
  it("writes progress while it applies, then ends succeeded with the proposal approved", async () => {
    const proposal = await insertProposal(LARGE);
    const queued = await approve(proposal);
    const runId = queued.approvalRun!.runId;

    const seenMidRun: Array<Record<string, unknown>> = [];
    holder.behaviour = async (ops, options) => {
      const onProgress = options.onProgress as (p: unknown) => Promise<void>;
      expect(typeof onProgress).toBe("function");
      const total = ops.length;
      for (let done = 1; done <= total; done++) {
        await onProgress({
          phase: done <= total / 2 ? "entities" : "relations",
          done,
          total,
          created: done,
          linked: 0,
          failed: 0,
        });
        if (done === Math.floor(total / 2) + 1)
          seenMidRun.push(await runRow(runId));
      }
    };

    const outcome = await runApprovalJob({ runId });

    expect(outcome).toEqual({ status: "succeeded" });
    // Mid-run, the ROW carried the progress (a phase change forces a write).
    expect(seenMidRun[0]).toMatchObject({
      status: "running",
      phase: "relations",
      done: Math.floor(LARGE / 2) + 1,
      total: LARGE,
    });
    const view = await readLatestApprovalRun(proposal.id);
    expect(view).toMatchObject({
      state: "succeeded",
      done: LARGE,
      total: LARGE,
      created: LARGE,
      primaryId: "ent-0",
      error: null,
    });
    expect(await proposalStatus(proposal.id)).toBe("approved");
  });

  it("a redelivered job never applies twice", async () => {
    const proposal = await insertProposal(LARGE);
    const runId = (await approve(proposal)).approvalRun!.runId;
    await runApprovalJob({ runId });
    expect(await runApprovalJob({ runId })).toEqual({ status: "skipped" });
    expect(holder.materializeCalls).toBe(1);
  });

  it("a second approve while it applies JOINS it; a synchronous apply is refused", async () => {
    const proposal = await insertProposal(LARGE);
    const first = await approve(proposal);
    const second = await approve(proposal);
    expect(second).toMatchObject({ queued: true, joined: true });
    expect(second.approvalRun!.runId).toBe(first.approvalRun!.runId);
    await expect(approve(proposal, { background: false })).rejects.toThrow(
      /being applied right now/
    );
    expect(
      holder.sends.filter((s) => s.queue === "proposal-approve")
    ).toHaveLength(1);
  });

  it("a proposal revised after approval is not applied", async () => {
    const proposal = await insertProposal(LARGE);
    const runId = (await approve(proposal)).approvalRun!.runId;
    await client.query(
      `update proposals set revision_history = '[{"at":"x","by":null,"before":{},"patch":{}}]'::jsonb where id = $1`,
      [proposal.id]
    );
    expect(await runApprovalJob({ runId })).toEqual({ status: "failed" });
    expect(holder.materializeCalls).toBe(0);
    expect((await readLatestApprovalRun(proposal.id))!.error).toMatch(
      /revised/
    );
  });
});

describe("a failure is recorded, and resume is safe", () => {
  it("records what landed and a safe sentence; the proposal stays pending", async () => {
    const proposal = await insertProposal(LARGE);
    const runId = (await approve(proposal)).approvalRun!.runId;
    holder.behaviour = async (ops, options) => {
      const onProgress = options.onProgress as (p: unknown) => Promise<void>;
      await onProgress({
        phase: "entities",
        done: 40,
        total: ops.length,
        created: 38,
        linked: 2,
        failed: 0,
      });
      throw new Error("connection terminated unexpectedly");
    };
    expect(await runApprovalJob({ runId })).toEqual({ status: "failed" });

    const view = await readLatestApprovalRun(proposal.id);
    expect(view).toMatchObject({
      state: "failed",
      done: 40,
      created: 38,
      linked: 2,
    });
    expect(typeof view!.error).toBe("string");
    expect(view!.error).not.toBe("");
    expect(await proposalStatus(proposal.id)).toBe("pending");

    // Another reviewer would re-create what landed (idempotency is keyed by
    // approver): refused. The approver resumes: a new run starts.
    await expect(approve(proposal, { userId: "someone-else" })).rejects.toThrow(
      /Only they can finish it/
    );
    const resumed = await approve(proposal);
    expect(resumed).toMatchObject({ queued: true, joined: false });
    expect(resumed.approvalRun!.runId).not.toBe(runId);
  });

  it("a running attempt whose heartbeat stopped reads stalled, and the next approve retires it", async () => {
    const proposal = await insertProposal(LARGE);
    const runId = (await approve(proposal)).approvalRun!.runId;
    await client.query(
      `update proposal_apply_runs set status = 'running', heartbeat_at = now() - interval '1 hour' where id = $1`,
      [runId]
    );
    expect((await readLatestApprovalRun(proposal.id))!.state).toBe("stalled");

    const resumed = await approve(proposal);
    expect(resumed).toMatchObject({ queued: true, joined: false });
    expect((await runRow(runId)).status).toBe("failed");
  });
});
