/**
 * F2 (founder, 2026-10-27) — the write-time half: `auditLog` (the ONE event
 * append door) stamps `events.ceiling_exempt` when an agent's write is its
 * bookkeeping of its OWN focus session, proven from the session row. Driven
 * through the REAL `EventRepository.append` and `SynapEventSchema` against
 * PGlite, so a field the schema strips or the INSERT forgets reads NULL here.
 * The count half lives in @synap/database
 * (`resolve-agent-governance-decision.own-session-ceiling.pglite.test.ts`).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  sql: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  // EventRepository talks to raw sql via `sql.unsafe(text, params)`; PGlite's
  // `query` returns `{ rows }`, so the shim unwraps to the rows array append()
  // expects.
  h.sql = {
    unsafe: async (text: string, params: unknown[]) =>
      (await client.query(text, params)).rows,
  };
  return { ...actual, db: h.db, getDb: async () => h.db, sql: h.sql };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { SynapEventSchema } from "@synap-core/core";
import { auditLog } from "./audit-log.js";

const HUMAN = "human-1";
const AGENT = "agent-1";
const OTHER_AGENT = "agent-2";
const OWN = randomUUID();
const NOT_ON_ROSTER = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await h.client!.query(
    `INSERT INTO focus_sessions (id, user_id, agent_ids, goal, status) VALUES
       ($1, $3, ARRAY[$4], 'own', 'active'),
       ($2, $3, ARRAY[$5], 'not mine', 'active')`,
    [OWN, NOT_ON_ROSTER, HUMAN, AGENT, OTHER_AGENT]
  );
});

beforeEach(async () => {
  await h.client!.exec("DELETE FROM events");
});

/** Append one agent event through auditLog; read back its stamp. */
async function emit(
  subjectType: string,
  subjectId: string,
  agentUserId: string | null = AGENT
) {
  await auditLog({
    subjectType,
    action: "update",
    phase: "completed",
    subjectId,
    userId: HUMAN,
    agentUserId,
    workspaceId: null,
  });
  const { rows } = await h.client!.query<{ ceiling_exempt: boolean | null }>(
    "SELECT ceiling_exempt FROM events WHERE subject_id = $1",
    [subjectId]
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.ceiling_exempt;
}

describe("F2 — auditLog stamps an agent's own-session bookkeeping (0365)", () => {
  it("an update of its OWN session is stamped ceiling_exempt", async () => {
    expect(await emit("focus_session", OWN)).toBe(true);
  });

  it("a session the agent is not on is NOT stamped (counted)", async () => {
    expect(await emit("focus_session", NOT_ON_ROSTER)).toBeNull();
  });

  it("an ordinary write is NOT stamped (counted)", async () => {
    expect(await emit("entity", randomUUID())).toBeNull();
  });

  it("a person's own write is never stamped", async () => {
    expect(await emit("focus_session", OWN, null)).toBeNull();
  });

  it("SynapEventSchema does NOT strip ceilingExempt (the silent-drop trap)", () => {
    const parsed = SynapEventSchema.parse({
      id: randomUUID(),
      version: "v1",
      type: "focus_session.update.completed",
      userId: HUMAN,
      data: {},
      source: "api",
      timestamp: new Date(),
      ceilingExempt: true,
    });
    expect(parsed.ceilingExempt).toBe(true);
  });
});
