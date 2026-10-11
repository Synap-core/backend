/**
 * A REFUSED approval stamps nothing on the session.
 *
 * `applyProposalApproval` stamps the session's declared slot `done`
 * (`satisfyExpectedOutputs`) and records the target as a session output
 * (`recordSessionArtifact`) after the executor runs. It did so whatever the
 * executor answered — so an executor returning `success: false` (it refused,
 * nothing was applied) still marked the deliverable delivered and listed an
 * object that does not exist.
 *
 * Real: PGlite, `applyProposalApproval`, the registry dispatch, both stamp
 * doors. The executor for `document/create` is replaced by a stand-in whose
 * answer the test sets — the same proposal, the same session, only the
 * executor's verdict differs, so the APPLIED case is the positive control that
 * keeps the refused assertion from passing vacuously.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  succeed: false,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: schema as never });
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { applyProposalApproval } from "../apply-approval.js";
import { proposalExecRegistry } from "../execution-registry.js";

const REVIEWER = "user-1";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.hasDefault && c.name === "id" ? " default gen_random_uuid()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
  // Registered AFTER `apply-approval` registered the real executors, so this
  // exact key wins for the test's proposals.
  proposalExecRegistry.register({
    key: "document/create",
    execute: async () =>
      h.succeed
        ? { success: true }
        : { success: false, message: "refused by the executor" },
  } as never);
});

/** A session owing a "Deck" document, and a pending proposal claiming it. */
async function approveDeckProposal() {
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, title, status, expected_outputs, created_at, updated_at)
     values ($1, $2, 'Make the deck', 'active', $3::jsonb, now(), now())`,
    [
      sessionId,
      REVIEWER,
      JSON.stringify([{ label: "Deck", kind: "document", status: "pending" }]),
    ]
  );
  const proposalId = randomUUID();
  const docId = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, session_id, data, comments, revision_history, created_at, updated_at)
     values ($1, 'pending', 'create', 'document', $2, $3, $4::jsonb, '[]'::jsonb, '[]'::jsonb, now(), now())`,
    [
      proposalId,
      docId,
      sessionId,
      JSON.stringify({
        requestId: proposalId,
        targetType: "document",
        targetId: docId,
        changeType: "create",
        expectedLabel: "Deck",
        data: { title: "Deck" },
      }),
    ]
  );
  const { db } = await import("@synap/database");
  const { eq } = await import("drizzle-orm");
  const proposal = await (
    db as unknown as {
      query: { proposals: { findFirst: (a: unknown) => Promise<unknown> } };
    }
  ).query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
  const result = await applyProposalApproval({
    proposal: proposal as never,
    userId: REVIEWER,
    input: { proposalId },
    ctx: { authenticated: true, userId: REVIEWER } as never,
  });
  const slots = (
    await q<{ expected_outputs: Array<{ status: string }> }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.expected_outputs;
  const artifacts = (
    await q(`select id from artifacts where session_id = $1`, [sessionId])
  ).rows;
  return { result, slots, artifacts };
}

describe("a refused approval stamps nothing on the session", () => {
  it("APPLIED (positive control): the slot is done and the output is listed", async () => {
    h.succeed = true;
    const { result, slots, artifacts } = await approveDeckProposal();
    expect(result.success).toBe(true);
    expect(slots[0]!.status).toBe("done");
    expect(artifacts).toHaveLength(1);
  });

  it("REFUSED: no slot stamped done, no session artifact row", async () => {
    h.succeed = false;
    const { result, slots, artifacts } = await approveDeckProposal();
    expect(result.success).toBe(false);
    expect(slots[0]!.status).toBe("pending");
    expect(artifacts).toHaveLength(0);
  });
});
