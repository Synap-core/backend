/**
 * diagnose's duplicate numbers on a REAL Postgres (PGlite): the review queue's
 * duplicate clusters (`diagnose({type: "proposal"})`) and an agent's
 * `duplicateRate` (`diagnose({agentId})`) count the SAME thing, a twin: the
 * same change proposed twice (finding 9ae52db7).
 *
 * Live before the fix: 7 "duplicate clusters", the largest 7 deletes of 7
 * different notes (every run of one capability shares the capability as its
 * target, and the review fingerprint grouped on that), and 44% duplicates for
 * an agent whose sampled writes were all different.
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
import { diagnoseRouter } from "../index.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const CAPABILITY = randomUUID();
const SESSION = randomUUID();
const NOTE = randomUUID();

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

/** One proposal row in WS, filed `minutesAgo` minutes ago. */
function add(row: {
  proposalType: string;
  targetType: string;
  targetId: string;
  status: string;
  data: unknown;
  agent?: boolean;
  dedupHash?: string;
  minutesAgo: number;
}) {
  return q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, created_by, agent_user_id, dedup_hash, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, now() - make_interval(mins => $11::int))`,
    [
      randomUUID(),
      WS,
      row.targetType,
      row.targetId,
      row.proposalType,
      row.status,
      JSON.stringify(row.data),
      OWNER,
      row.agent ? AGENT : null,
      row.dedupHash ?? null,
      row.minutesAgo,
    ]
  );
}

const deleteRun = (noteId: string) => ({
  proposalType: "capability.run",
  targetType: "capability",
  targetId: CAPABILITY,
  data: { verbId: "entities.delete", params: { entityId: noteId } },
});

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
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id) values ($1, 'a@x.test', 'Agent', 'agent', 'claude-code', $2)`,
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

  // THE REVIEW QUEUE (pending, the owner's): seven deletes of seven different
  // notes, and one delete of one note filed twice.
  for (let i = 0; i < 7; i++)
    await add({
      ...deleteRun(randomUUID()),
      status: "pending",
      minutesAgo: 10 + i,
    });
  for (let i = 0; i < 2; i++)
    await add({
      proposalType: "delete",
      targetType: "entity",
      targetId: NOTE,
      status: "pending",
      data: { data: { id: NOTE } },
      minutesAgo: 20 + i,
    });

  // THE AGENT'S WEEK: seven deletes of seven different notes (no stored hash,
  // as a row filed before the column), and one session update it withdrew and
  // filed again. The withdraw stamped `withdrawReason` into the old row's
  // payload; both rows keep the hash the change had when filed.
  for (let i = 0; i < 7; i++)
    await add({
      ...deleteRun(randomUUID()),
      status: "approved",
      agent: true,
      minutesAgo: 30 + i,
    });
  const update = {
    proposalType: "update",
    targetType: "focus_session",
    targetId: SESSION,
    data: { data: { status: "paused" } },
    agent: true,
    dedupHash: "filed-change-hash",
  };
  await add({
    ...update,
    status: "withdrawn",
    data: { ...update.data, withdrawReason: "filing it again" },
    minutesAgo: 41,
  });
  await add({ ...update, status: "pending", minutesAgo: 40 });
});

describe("diagnose counts real twins, the same way in both numbers", () => {
  it("the review queue: seven deletes of seven notes are no cluster; one delete filed twice is one", async () => {
    const report = await diagnoseRouter({ userId: OWNER, type: "proposal" });
    if (!("mode" in report) || report.mode !== "class")
      throw new Error(JSON.stringify(report));
    // 7 + 2 of the owner's, + the agent's refile.
    expect(report.detail.pending).toBe(10);
    expect(report.detail.duplicateClusters).toEqual([
      { targetLabel: expect.any(String), count: 2 },
    ]);
    expect(report.summary).toContain("1 duplicate cluster(s)");
  });

  it("the agent card: the withdraw-and-refile is its only twin pair", async () => {
    const report = await diagnoseRouter({ userId: OWNER, agentId: AGENT });
    if (!("mode" in report) || report.mode !== "agent")
      throw new Error(JSON.stringify(report));
    expect(report.duplicateSample.size).toBe(9);
    expect(report.rates.duplicateRate).toBeCloseTo(2 / 9, 4);
  });
});
