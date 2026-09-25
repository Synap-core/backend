/**
 * `proposals.list({ status: "auto_approved" })` — the NOTICE tier, driven
 * through the REAL `list` procedure on PGlite: the real zod input, the real
 * scope + status predicates, the real enrichment and review/revert decoration.
 *
 * Why the bucket exists: `validated` folds approved ∪ auto_approved, so a
 * "what agents did on your behalf" feed reading it mixed the person's OWN
 * verdicts with writes nobody saw. `auto_approved` returns only the latter.
 * `validated` keeps its fold for its existing readers — pinned here too.
 *
 * What this CANNOT see: the production Postgres (tables are generated from the
 * Drizzle definitions with no FKs, NOT NULL or enums), and the MCP door, which
 * has its own status filter.
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
import { db, ProposalStatus } from "@synap/database";
import { proposalsRouter } from "../proposals.js";

const VIEWER = "viewer-1";
const AGENT = "agent-1";
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

/** One row per stored status, all agent-authored in the viewer's workspace. */
const ALL_STATUSES = Object.values(ProposalStatus) as string[];

const list = (status: string) =>
  proposalsRouter
    .createCaller({ db, authenticated: true, userId: VIEWER } as never)
    .list({ workspaceId: WS, status, limit: 50 } as never) as Promise<{
    items: Array<{ id: string; status: string; revertable: boolean }>;
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
  for (const status of ALL_STATUSES) {
    minute += 1;
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, agent_user_id, created_by, created_at, updated_at)
       values ($1, $2, 'entity', $3, 'entity.create', $4, '{}'::jsonb, $5, $5, now() - ($6 || ' minutes')::interval, now())`,
      [randomUUID(), WS, randomUUID(), status, AGENT, String(minute)]
    );
  }
}, 120_000);

describe("proposals.list — the auto_approved (notice) bucket", () => {
  it("NON-VACUITY: every stored status was seeded and `all` sees them", async () => {
    expect(ALL_STATUSES.length).toBeGreaterThanOrEqual(8);
    const all = await list("all");
    expect(new Set(all.items.map((r) => r.status))).toEqual(
      new Set(ALL_STATUSES)
    );
  });

  it("returns ONLY auto-approved rows", async () => {
    const { items } = await list("auto_approved");
    expect(items.length).toBe(1);
    expect(items.map((r) => r.status)).toEqual(["auto_approved"]);
    // The row carries the server's revertable decoration, like every list row.
    expect(typeof items[0]!.revertable).toBe("boolean");
  });

  it("`validated` keeps its fold (approved ∪ auto_approved) for existing readers", async () => {
    const { items } = await list("validated");
    expect(items.map((r) => r.status).sort()).toEqual([
      "approved",
      "auto_approved",
    ]);
  });
});
