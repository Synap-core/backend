/**
 * An AGENT's rejection is recorded as the agent's, never the person's
 * (ticket 006ce859). An agent key is remapped to its person (`userId`), and
 * `proposals.reject` / `batchReject` stamped `reviewedBy = userId`: an agent
 * withdrawing its own proposal through the CLI was recorded, and announced by
 * the bridge, as "decided by the person". The representation is #1089's: an
 * agent's act names no reviewer (`reviewedBy` null, `reviewedAt` kept), and the
 * status transition names the agent.
 *
 * Real: PGlite, the tRPC proposals router, `transitionProposal` and its
 * transition outbox. Stubbed: the review ladder (`assertCanReviewProposal`,
 * tested in proposal-review-session-gate.pglite.test.ts) and the executor
 * dispatch; `db.transaction` runs on the one PGlite connection.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
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
  const db = drizzle(client, { schema: schema as never });
  (db as unknown as { transaction: unknown }).transaction = async (
    fn: (tx: unknown) => Promise<unknown>
  ) => fn(db);
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

vi.mock("../review-authority.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertCanReviewProposal: async () => undefined };
});

vi.mock("../apply-approval.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    applyProposalApproval: async () => ({ success: true }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { proposalsRouter } from "../../proposals.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();

const person = () =>
  proposalsRouter.createCaller({ authenticated: true, userId: OWNER } as never);
/** An agent key: remapped to its person, the agent travelling beside it. */
const agent = () =>
  proposalsRouter.createCaller({
    authenticated: true,
    userId: OWNER,
    agentUserId: AGENT,
  } as never);

/** A pending update the AGENT filed. */
async function agentProposal(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, agent_user_id, created_by, data, revision_history, created_at, updated_at)
     values ($1, 'pending', 'update', 'document', $2, $3, $4, $5, '{}'::jsonb, '[]'::jsonb, now(), now())`,
    [id, randomUUID(), WS, AGENT, OWNER]
  );
  return id;
}

async function decided(id: string) {
  const { rows } = await q<{
    status: string;
    reviewed_by: string | null;
    reviewed_at: Date | null;
  }>(`select status, reviewed_by, reviewed_at from proposals where id = $1`, [
    id,
  ]);
  const t = await q<{ t: Record<string, unknown> }>(
    `select transition as t from lifecycle_transition_outbox where transition->>'proposalId' = $1`,
    [id]
  );
  return { row: rows[0]!, transitions: t.rows.map((r) => r.t) };
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, user_type) values ($1, 'human')`, [OWNER]);
  await q(`insert into users (id, user_type) values ($1, 'agent')`, [AGENT]);
  await q(
    `insert into workspaces (id, owner_id, name, settings) values ($1, $2, 'W', '{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, OWNER]
  );
}, 120_000);

describe("an agent's rejection names no person", () => {
  it("reject by the agent's key → no reviewer, the transition names the agent", async () => {
    const id = await agentProposal();
    await agent().reject({ proposalId: id, reason: "Superseded: refiled" });
    const { row, transitions } = await decided(id);
    expect(row.status).toBe("rejected");
    expect(row.reviewed_by).toBeNull();
    expect(row.reviewed_at).not.toBeNull();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      to: "rejected",
      actorKind: "agent",
      agentUserId: AGENT,
    });
  });

  it("batchReject by the agent's key → the same", async () => {
    const id = await agentProposal();
    await agent().batchReject({ proposalIds: [id], reason: "Superseded" });
    const { row, transitions } = await decided(id);
    expect(row.status).toBe("rejected");
    expect(row.reviewed_by).toBeNull();
    expect(transitions[0]).toMatchObject({
      actorKind: "agent",
      agentUserId: AGENT,
    });
  });

  it("CONTROL — the person's rejection names the person", async () => {
    const id = await agentProposal();
    await person().reject({ proposalId: id, reason: "No" });
    const { row, transitions } = await decided(id);
    expect(row.status).toBe("rejected");
    expect(row.reviewed_by).toBe(OWNER);
    expect(transitions[0]).toMatchObject({
      actorKind: "human",
      userId: OWNER,
    });
  });
});
