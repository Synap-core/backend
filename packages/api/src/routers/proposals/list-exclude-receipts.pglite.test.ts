/**
 * `proposals.list({ excludeReceipts: true })` — receipts (writes that executed
 * with nobody deciding them) leave a list that asks the person to look, and
 * stay in the history and "on your behalf" reads. Driven through the REAL
 * `list` procedure on PGlite; the expected set is DERIVED from the types
 * leaf's own attention rule, not a hand list.
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
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});
vi.mock("@synap/storage", () => ({ storage: {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import { resolveProposalAttention } from "@synap-core/types/proposals/attention";
import { proposalsRouter } from "../proposals.js";

const VIEWER = "viewer-rc";
const AGENT = "agent-rc";
const WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const ROWS = [
  {
    status: "auto_approved",
    targetType: "entity",
    proposalType: "entity.update",
  },
  {
    status: "auto_approved",
    targetType: "document",
    proposalType: "document.create",
  },
  { status: "pending", targetType: "entity", proposalType: "update" },
  { status: "approval_failed", targetType: "entity", proposalType: "update" },
  { status: "approved", targetType: "entity", proposalType: "entity.update" },
  { status: "rejected", targetType: "entity", proposalType: "entity.update" },
  { status: "reverted", targetType: "entity", proposalType: "entity.update" },
].map((r) => ({ ...r, id: randomUUID() }));

const list = (input: Record<string, unknown>) =>
  proposalsRouter
    .createCaller({ db, authenticated: true, userId: VIEWER } as never)
    .list({
      workspaceId: WS,
      status: "all",
      limit: 50,
      ...input,
    } as never) as Promise<{
    items: Array<{ id: string }>;
  }>;

const isReceipt = (row: (typeof ROWS)[number]) =>
  resolveProposalAttention(row) === "notice";

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, user_type) values ($1, 'v@test', 'human'), ($2, 'a@test', 'agent')`,
    [VIEWER, AGENT]
  );
  await q(`insert into workspaces (id, name, owner_id) values ($1, 'WS', $2)`, [
    WS,
    VIEWER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, VIEWER]
  );
  let minute = 0;
  for (const row of ROWS) {
    minute += 1;
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, agent_user_id, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $7, now() - ($8 || ' minutes')::interval, now())`,
      [
        row.id,
        WS,
        row.targetType,
        randomUUID(),
        row.proposalType,
        row.status,
        AGENT,
        String(minute),
      ]
    );
  }
}, 120_000);

describe("proposals.list — excludeReceipts", () => {
  it("NON-VACUITY: without the flag every row comes back, receipts and non-receipts both seeded", async () => {
    const { items } = await list({});
    expect(new Set(items.map((r) => r.id))).toEqual(
      new Set(ROWS.map((r) => r.id))
    );
    expect(ROWS.filter(isReceipt).length).toBeGreaterThanOrEqual(2);
    expect(ROWS.filter((r) => !isReceipt(r)).length).toBeGreaterThanOrEqual(4);
  });

  it("the person's list (status all + excludeReceipts) drops every receipt and keeps the rest", async () => {
    const { items } = await list({ excludeReceipts: true });
    expect(new Set(items.map((r) => r.id))).toEqual(
      new Set(ROWS.filter((r) => !isReceipt(r)).map((r) => r.id))
    );
  });

  it("the validated list keeps the person's own approvals when receipts leave", async () => {
    const { items } = await list({
      status: "validated",
      excludeReceipts: true,
    });
    expect(items.map((r) => r.id)).toEqual(
      ROWS.filter((r) => r.status === "approved").map((r) => r.id)
    );
  });

  it("the on-your-behalf door (status auto_approved) still returns the receipts", async () => {
    const { items } = await list({ status: "auto_approved" });
    expect(new Set(items.map((r) => r.id))).toEqual(
      new Set(ROWS.filter(isReceipt).map((r) => r.id))
    );
  });

  it("the default review list (pending) never held a receipt", async () => {
    const { items } = await list({ status: "pending" });
    const ids = new Set(items.map((r) => r.id));
    for (const r of ROWS.filter(isReceipt)) expect(ids.has(r.id)).toBe(false);
  });
});
