/**
 * `allAgentsScorecard` on a REAL Postgres (PGlite).
 *
 * The aggregate SELECTs and GROUPs BY the same computed expressions. When one
 * of them carried a bind parameter (the 7-day `writes7d` window), Postgres saw
 * `$1` in the SELECT and `$5` in the GROUP BY as different expressions and
 * refused the query — "created_at must appear in the GROUP BY clause". The pure
 * `foldAgentStatusRows` tests could not see it, and the live Agents page
 * answered 500 (2026-09-28). This test runs the real query.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return { ...actual, db: d, getDb: async () => d };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { allAgentsScorecard } from "../agent-scorecard.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.hasDefault && type === "jsonb"
          ? ` default '{}'::jsonb`
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.init();
  for (const table of Object.values(schema)) {
    try {
      getTableConfig(table as PgTable);
    } catch {
      continue;
    }
    await h.client!.exec(ddlFor(table as PgTable)).catch(() => undefined);
  }
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'o@x.test', 'Owner', 'human')`,
    [OWNER]
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id) values ($1, 'a@x.test', 'Probe agent', 'agent', 'probe', $2)`,
    [AGENT, OWNER]
  );
  await q(`insert into workspaces (id, name, owner_id) values ($1, 'W', $2)`, [
    WS,
    OWNER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, OWNER]
  );
  const add = (status: string, ageDays: number) =>
    q(
      `insert into proposals (id, workspace_id, target_type, proposal_type, status, data, created_by, agent_user_id, created_at)
       values ($1, $2, 'entity', 'create', $3, '{}'::jsonb, $4, $5, now() - make_interval(days => $6::int))`,
      [randomUUID(), WS, status, AGENT, AGENT, ageDays]
    );
  await add("approved", 1);
  await add("approved", 30);
  await add("rejected", 2);
  await add("auto_approved", 1);
});

describe("allAgentsScorecard on real Postgres", () => {
  it("runs the aggregate and folds the owner's agent", async () => {
    const standings = await allAgentsScorecard({ userId: OWNER });
    const mine = standings.find((s) => s.agentUserId === AGENT);
    expect(mine).toBeDefined();
    // auto_approved rows also count as approved (see foldAgentStatusRows).
    expect(mine!.approved).toBe(3);
    expect(mine!.rejected).toBe(1);
    expect(mine!.autoApproved).toBe(1);
    // Applied writes in the last 7 days: the 1-day approved + the auto one.
    expect(mine!.writes7d).toBe(2);
  });
});
