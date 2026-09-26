/**
 * `proposals.list({ excludeBookkeeping: true })` — session bookkeeping receipts
 * are left out IN SQL, driven through the REAL `list` procedure on PGlite.
 *
 * Why: a notice surface reading one page of `auto_approved` rows used to drop
 * bookkeeping client-side, so a page made only of bookkeeping read as
 * "Nothing handled" while real notices sat on the next page.
 *
 * The expected set is DERIVED from the types leaf's own rule
 * (`isSessionBookkeeping` + `resolveProposalAttention`), so the SQL filter is
 * checked against the definition it claims to mirror, not a hand list. The
 * seeded rows include every discriminating pair: bookkeeping vs a session
 * GATE, both `proposal_type` spellings, and a PENDING session create (a
 * decision, never dropped).
 *
 * What this CANNOT see: production Postgres constraints (tables are generated
 * from the Drizzle definitions with no FKs, NOT NULL or enums).
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
import {
  isSessionBookkeeping,
  resolveProposalAttention,
} from "@synap-core/types/proposals/attention";
import { proposalsRouter } from "../proposals.js";

const VIEWER = "viewer-bk";
const AGENT = "agent-bk";
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
    targetType: "focus_session",
    proposalType: "focus_session.update",
  },
  {
    status: "auto_approved",
    targetType: "focus_session",
    proposalType: "focus_session.create",
  },
  {
    status: "auto_approved",
    targetType: "focus_session",
    proposalType: "update",
  },
  {
    status: "auto_approved",
    targetType: "focus_session",
    proposalType: "focus_session.stage_gate",
  },
  {
    status: "auto_approved",
    targetType: "entity",
    proposalType: "entity.update",
  },
  { status: "pending", targetType: "focus_session", proposalType: "create" },
  {
    status: "approved",
    targetType: "focus_session",
    proposalType: "focus_session.create",
  },
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

/** The types leaf's definition: bookkeeping, and not a decision. */
const isDroppable = (row: (typeof ROWS)[number]) =>
  isSessionBookkeeping(row) && resolveProposalAttention(row) !== "decide";

describe("proposals.list — excludeBookkeeping", () => {
  it("NON-VACUITY: without the flag every seeded row comes back, and both classes are seeded", async () => {
    const { items } = await list({});
    expect(new Set(items.map((r) => r.id))).toEqual(
      new Set(ROWS.map((r) => r.id))
    );
    expect(ROWS.filter(isDroppable).length).toBeGreaterThanOrEqual(3);
    expect(ROWS.filter((r) => !isDroppable(r)).length).toBeGreaterThanOrEqual(
      3
    );
  });

  it("drops exactly the rows the types leaf calls bookkeeping, in SQL", async () => {
    const { items } = await list({ excludeBookkeeping: true });
    expect(new Set(items.map((r) => r.id))).toEqual(
      new Set(ROWS.filter((r) => !isDroppable(r)).map((r) => r.id))
    );
  });

  it("keeps a session GATE and a PENDING session create — they are decisions, not bookkeeping", async () => {
    const kept = new Set(
      (await list({ excludeBookkeeping: true })).items.map((r) => r.id)
    );
    const gate = ROWS.find(
      (r) => r.proposalType === "focus_session.stage_gate"
    )!;
    const pendingStart = ROWS.find((r) => r.status === "pending")!;
    expect(kept.has(gate.id)).toBe(true);
    expect(kept.has(pendingStart.id)).toBe(true);
  });

  it("composes with the notice bucket: auto_approved + excludeBookkeeping = the real notices", async () => {
    const { items } = await list({
      status: "auto_approved",
      excludeBookkeeping: true,
    });
    expect(new Set(items.map((r) => r.id))).toEqual(
      new Set(
        ROWS.filter((r) => r.status === "auto_approved" && !isDroppable(r)).map(
          (r) => r.id
        )
      )
    );
  });
});
