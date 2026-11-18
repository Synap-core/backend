/**
 * An AGENT taking back its own proposal WITHDRAWS it, and nothing scores it
 * (plan 8032a127 D2, founder 17 Nov 2026).
 *
 * 44 failed proposals on the founder's pod could leave only through a person's
 * reject, and the MCP text told agents to "withdraw" a wrong write with
 * `synap_reject_proposal`, which counts as a rejection on the agent's
 * scorecard: an agent that did the right thing scored itself down.
 *
 * SEAM: the REAL MCP `synap_reject_proposal` handler → the REAL
 * `proposals.withdraw` door, on PGlite; the scorecard is the REAL pure fold
 * (`computeAgentScorecard`) over the rows the door left. Stubbed: the realtime
 * fan-out and the staged-blob discard (own suites), the split-brain guard.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
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
vi.mock(
  "../../../utils/store-entity-source-blob.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    discardProposalSourceBlob: vi.fn(async () => undefined),
  })
);
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../apply-approval.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitProposalReviewed: vi.fn(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { buildHandlers } from "../../mcp/handlers/build.js";
import type { McpToolContext } from "../../mcp/handlers/shared.js";
import { computeAgentScorecard } from "../../../services/diagnose/agent-scorecard.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary ? " primary key" : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();

/** An agent's proposal for OWNER, filed by `agent` (createdBy = the agent). */
async function file(agent: string, status: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data,
       created_by, agent_user_id, subject_user_id, rejection_reason, reviewed_by, reviewed_at)
     values ($1, $2, 'capture.graph', 'entity', $3, $4::jsonb, $5, $5, $6, $7, $8, $9)`,
    [
      id,
      status,
      randomUUID(),
      JSON.stringify(
        status === "approval_failed"
          ? { failure: { errorClass: "validation" } }
          : {}
      ),
      agent,
      OWNER,
      status === "approval_failed" ? "Couldn't apply." : null,
      status === "approval_failed" ? OWNER : null,
      status === "approval_failed" ? new Date() : null,
    ]
  );
  return id;
}

const rejectAs = (agentUserId: string, proposalId: string) =>
  buildHandlers.synap_reject_proposal!({
    toolName: "synap_reject_proposal",
    args: { proposalId, reason: "I filed the wrong thing" },
    userId: OWNER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId,
  } as unknown as McpToolContext);

async function rowOf(id: string) {
  const { rows } = await q<{
    status: string;
    rejection_reason: string | null;
    reason_code: string | null;
    reviewed_by: string | null;
    withdraw_reason: string | null;
  }>(
    `select status, rejection_reason, reason_code, reviewed_by,
            data->>'withdrawReason' as withdraw_reason
       from proposals where id = $1`,
    [id]
  );
  return rows[0]!;
}

/** The agent's scorecard over every row it filed, through the real fold. */
async function scorecardOf(agent: string) {
  const { rows } = await q<{
    proposal_type: string;
    target_type: string;
    target_id: string;
    data: unknown;
    status: string;
    rejection_reason: string | null;
    reason_code: string | null;
    created_at: Date;
    workspace_id: string | null;
  }>(`select * from proposals where agent_user_id = $1`, [agent]);
  return computeAgentScorecard(
    rows.map((r) => ({
      proposalType: r.proposal_type,
      targetType: r.target_type,
      targetId: r.target_id,
      data: r.data,
      status: r.status,
      rejectionReason: r.rejection_reason,
      reasonCode: r.reason_code,
      revisionHistory: null,
      createdAt: new Date(r.created_at),
      workspaceId: r.workspace_id,
    })),
    { agentId: agent, agentName: null, agentType: null, pendingCount: 0 }
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  // A pod user: the caller's own floor admits pod-wide proposals to them.
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from proposals;`);
});

describe("an agent takes back its own proposal: withdrawn, never scored", () => {
  it("its own FAILED proposal ends withdrawn, with no reviewer and no rejection", async () => {
    const failed = await file(AGENT, "approval_failed");
    const reply = await rejectAs(AGENT, failed);
    expect(
      JSON.parse((reply.content[0] as { text: string }).text)
    ).toMatchObject({
      success: true,
      proposalId: failed,
      status: "withdrawn",
    });
    const row = await rowOf(failed);
    expect(row.status).toBe("withdrawn");
    expect(row.withdraw_reason).toBe("I filed the wrong thing");
    // An agent is not a reviewer: no person is named as deciding it.
    expect(row.reviewed_by).toBeNull();
    expect(row.reason_code).toBeNull();
  });

  it("its own PENDING proposal ends withdrawn too", async () => {
    const pending = await file(AGENT, "pending");
    await rejectAs(AGENT, pending);
    expect((await rowOf(pending)).status).toBe("withdrawn");
  });

  it("nothing lands on the agent's scorecard: no rejection, no new rejection reason", async () => {
    const failed = await file(AGENT, "approval_failed");
    const pending = await file(AGENT, "pending");
    const before = await scorecardOf(AGENT);
    await rejectAs(AGENT, failed);
    await rejectAs(AGENT, pending);
    const card = await scorecardOf(AGENT);
    expect(card.counts.total).toBe(2);
    expect(card.counts.rejected).toBe(0);
    expect(card.rates).toEqual(before.rates);
    // The failure's own sentence is in the histogram BEFORE (the fold buckets
    // every row's `rejectionReason`, whatever its status: a pre-existing
    // trait, not this door's); the withdrawal adds no reason of its own.
    expect(card.rejectionReasons).toEqual(before.rejectionReasons);
  });

  it("another agent's failed proposal is not withdrawable by it", async () => {
    const theirs = await file(OTHER_AGENT, "approval_failed");
    const { proposalsRouter } = await import("../../proposals.js");
    const { db } = await import("@synap/database");
    const caller = proposalsRouter.createCaller({
      db,
      authenticated: true,
      userId: OWNER,
      agentUserId: AGENT,
    } as never);
    await expect(caller.withdraw({ proposalId: theirs })).rejects.toMatchObject(
      { code: "FORBIDDEN" }
    );
    expect((await rowOf(theirs)).status).toBe("approval_failed");
  });
});
