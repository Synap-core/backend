/**
 * `proposals.approve` / `batchApprove` take a `comment`. Until U5 it reached
 * two executors' event payloads and nothing else — the proposal RECORD never
 * held it, so the page and the agent (`synap_get_proposal` reads this row)
 * could not see what the reviewer said. The ONE approve door
 * (`applyProposalApproval`, shared by both routes) now appends it to
 * `proposals.comments`; read back through the ONE reader.
 *
 * Real: PGlite, `applyProposalApproval` and its acknowledgement-only
 * `automation.health_advisory` branch (no executor side effects).
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
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { readProposalReviewComments } from "@synap-core/types/proposals";
import { applyProposalApproval } from "../apply-approval.js";

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

const REVIEWER = randomUUID();

async function fileAdvisory(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, comments, revision_history, created_at, updated_at)
     values ($1, 'pending', 'automation.health_advisory', 'automation', $2, $3::jsonb, '[]'::jsonb, '[]'::jsonb, now(), now())`,
    [id, randomUUID(), JSON.stringify({ ownerUserId: REVIEWER, findings: [] })]
  );
  return id;
}

async function approve(id: string, comment?: string) {
  const { db } = await import("@synap/database");
  const { eq } = await import("drizzle-orm");
  const proposal = await (
    db as unknown as {
      query: { proposals: { findFirst: (a: unknown) => Promise<unknown> } };
    }
  ).query.proposals.findFirst({ where: eq(schema.proposals.id, id) });
  expect(proposal).toBeTruthy();
  return applyProposalApproval({
    proposal: proposal as never,
    userId: REVIEWER,
    input: { proposalId: id, ...(comment !== undefined ? { comment } : {}) },
    ctx: { authenticated: true, userId: REVIEWER } as never,
  });
}

const commentsOf = async (id: string) =>
  readProposalReviewComments(
    (
      await q<{ comments: unknown }>(
        `select comments from proposals where id = $1`,
        [id]
      )
    ).rows[0]!.comments
  );

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
});

describe("approve comment reaches the proposal record", () => {
  it("an approval's note lands on proposals.comments, attributed", async () => {
    const id = await fileAdvisory();
    const result = await approve(id, "  Fine — but check the cron next week ");
    expect(result.success).toBe(true);
    const comments = await commentsOf(id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      kind: "approval",
      text: "Fine — but check the cron next week",
      by: REVIEWER,
    });
  });

  it("no comment (or only blanks) writes nothing", async () => {
    const a = await fileAdvisory();
    await approve(a);
    expect(await commentsOf(a)).toEqual([]);
    const b = await fileAdvisory();
    await approve(b, "   ");
    expect(await commentsOf(b)).toEqual([]);
  });
});
