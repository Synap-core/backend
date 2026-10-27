/**
 * The per-agent card (`agentScorecard`) on a REAL Postgres (PGlite), for an
 * agent busier than one page of proposals.
 *
 * The card used to read the agent's newest 500 proposals and count them in JS.
 * Claude Code files 500 in about 3 hours, so the card covered under a day: it
 * showed 0 rejections while 6 existed that day (2026-10-27). It now counts the
 * last 7 days in SQL. This seeds 600 approvals in the last 10 hours, and OLDER
 * than all of them (still inside the 7 days) 6 rejections, a partial apply and
 * a human revision; plus 3 rejections 10 days ago, outside the window.
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
import { agentScorecard, DUPLICATE_SAMPLE_LIMIT } from "../agent-scorecard.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const NEWEST = 600;

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
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id) values ($1, 'a@x.test', 'Busy agent', 'agent', 'claude-code', $2)`,
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
  // 600 approvals, one a minute over the last 10 hours: the newest page.
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, created_by, agent_user_id, created_at)
     select gen_random_uuid(), $1, 'entity', 'e' || g, 'create', 'approved',
            jsonb_build_object('title', 'T' || g), $2, $2, now() - make_interval(mins => g)
       from generate_series(1, $3::int) g`,
    [WS, AGENT, NEWEST]
  );
  const add = (
    status: string,
    ageDays: number,
    extra: {
      data?: unknown;
      reasonCode?: string;
      revisionHistory?: unknown;
    } = {}
  ) =>
    q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, created_by, agent_user_id, created_at, reason_code, revision_history)
       values ($1, $2, 'entity', $9, 'create', $3, $4::jsonb, $5, $5, now() - make_interval(days => $6::int), $7, $8::jsonb)`,
      [
        randomUUID(),
        WS,
        status,
        JSON.stringify(extra.data ?? {}),
        AGENT,
        ageDays,
        extra.reasonCode ?? null,
        extra.revisionHistory === undefined
          ? null
          : JSON.stringify(extra.revisionHistory),
        // target_id is text, id is uuid: one parameter cannot be both.
        randomUUID(),
      ]
    );
  // Older than every one of the 600, still inside the 7 days.
  for (let i = 0; i < 6; i++)
    await add("rejected", 2, { reasonCode: "duplicate" });
  await add("approved", 3, {
    data: {
      dispositions: { a: { status: "approve" }, b: { status: "reject" } },
    },
  });
  await add("approved", 3, {
    revisionHistory: [{ at: "2026-10-24T00:00:00Z", by: OWNER, patch: {} }],
  });
  // Outside the window.
  for (let i = 0; i < 3; i++) await add("rejected", 10);
});

describe("agentScorecard counts the whole 7-day window, not the newest page", () => {
  it("counts the rejections, partial apply and revision older than the newest 500", async () => {
    const card = await agentScorecard({ userId: OWNER, agentId: AGENT });
    if ("error" in card) throw new Error(card.error);

    expect(card.counts.rejected).toBe(6);
    expect(card.counts.partiallyApproved).toBe(1);
    expect(card.counts.revised).toBe(1);
    // 600 + the revised approval; the partial one is its own bucket.
    expect(card.counts.approved).toBe(NEWEST + 1);
    expect(card.counts.total).toBe(NEWEST + 8);
    expect(card.sampled).toBe(card.counts.total);
    expect(card.rejectionReasons).toEqual([{ reason: "duplicate", count: 6 }]);
  });

  it("says which period it covers and that the duplicate rate is a sample", async () => {
    const card = await agentScorecard({ userId: OWNER, agentId: AGENT });
    if ("error" in card) throw new Error(card.error);

    expect(card.window.days).toBe(7);
    const span = Date.parse(card.window.to) - Date.parse(card.window.from);
    expect(span).toBe(7 * 24 * 60 * 60 * 1000);
    expect(card.duplicateSample).toEqual({
      size: DUPLICATE_SAMPLE_LIMIT,
      limit: DUPLICATE_SAMPLE_LIMIT,
    });
    // 600 distinct titles on distinct targets: no duplicates in the sample.
    expect(card.rates.duplicateRate).toBe(0);
  });
});
