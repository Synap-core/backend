/**
 * A GRANTED filing is WRITTEN, whatever the rest of the patch decides
 * (FB1020 w2 review M1) — driven through the REAL `updateFocusSession`, the
 * REAL `checkPermissionOrPropose` and the REAL governance resolver + engine on
 * PGlite, with the REAL seeded `@reversible` (0282) and `@own-organise`
 * (0346b) rows and the REAL calling-key context. The gate is NOT mocked: the
 * earlier B3 suites mocked it, which is exactly how this defect passed.
 *
 * The scenario: an agent files its OWN FRESH session into its declared focus
 * project AND changes the session's criteria in the same call. The filing is
 * an organise write the class row applies (an applied receipt, R1); the
 * criteria change is a contract change floored to a proposal (rung 2.1). The
 * defect: the door returned at the criteria proposal, so R1 said "applied"
 * while the session stayed unfiled, with no Undo.
 *
 * Stubbed, and why:
 *  - `getAgentFocusProjectId` reads the agent's declared focus from a value
 *    the test sets. PGlite runs ONE connection, and the real read runs on the
 *    module `db` INSIDE the proposal transaction (`createPendingProposalRow`),
 *    which deadlocks there (never on Postgres). Same value the real reader
 *    would return from `users.agent_metadata.focusProjectId`.
 *  - post-commit delivery only: realtime broadcast, side-effect fan-out, the
 *    AI-decision feed, the session room mint, block guidance.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    focus: null as string | null,
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
  // The event log appends over its own connection (no PGlite): a no-op here.
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: globalThis.crypto.randomUUID() }) }
  );
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    eventRepository,
  };
});
vi.mock("../../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => h.focus,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: vi.fn(async () => undefined),
}));
vi.mock("../ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: vi.fn(async () => undefined),
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithCallingKey } from "@synap/database";
import { updateFocusSession } from "../update-session.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const migration = (f: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../../database/migrations/${f}`, import.meta.url)
    ),
    "utf-8"
  );

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const AGENT = randomUUID();
const KEY = randomUUID();

const C1 = {
  key: "report",
  statement: "A report exists",
  check: { kind: "human" },
};

async function seedOwnFreshSession(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, project_id, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Shell work', 'Ship the work shell', 'active', 'agent', null,
             '[]'::jsonb, '[]'::jsonb, $3::jsonb, '{}', now(), now(), now())`,
    [id, USER, JSON.stringify({ clientKey: `key:${KEY}|conv:c1` })]
  );
  return id;
}

async function seedProject(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, 'Synap', 'active', now(), now())`,
    [id, USER]
  );
  return id;
}

const sessionRow = async (id: string) =>
  (
    await q<{ project_id: string | null; criteria: unknown }>(
      `select project_id, criteria from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;

const proposalsFor = async (sessionId: string) =>
  (
    await q<{
      id: string;
      status: string;
      data: Record<string, unknown> & {
        materialized?: { rowPatches?: unknown[] };
        data?: Record<string, unknown>;
      };
    }>(
      `select id, status, data from proposals where target_id = $1 order by created_at`,
      [sessionId]
    )
  ).rows;

/** The payload a proposal row carries (the gate nests it under `data`). */
const payloadOf = (row: { data: Record<string, unknown> }) =>
  ((row.data.data as Record<string, unknown> | undefined) ??
    row.data) as Record<string, unknown>;

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one these doors read.
      }
    }
  }
  await q(
    `insert into users (id, name, email, user_type) values ($1, 'Founder', 'f@x', 'human')`,
    [USER]
  );
  await q(
    `insert into users (id, name, email, user_type, agent_metadata) values ($1, 'Claude Code', 'a@x', 'agent', $2::jsonb)`,
    [AGENT, JSON.stringify({ agentType: "claude-code" })]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from projects; delete from proposals; delete from governance_rules;"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
  await h.client!.exec(migration("0346b_governance_own_organise_default.sql"));
  h.focus = null;
});

describe("M1: a granted filing is written whatever the rest of the patch decides", () => {
  it("filing + a criteria change: the filing lands on its applied receipt with Undo; only the criteria wait", async () => {
    const projectId = await seedProject();
    h.focus = projectId;
    const sessionId = await seedOwnFreshSession();

    const res = await runWithCallingKey(KEY, () =>
      updateFocusSession({
        sessionId,
        userId: USER,
        agentUserId: AGENT,
        projectId,
        criteria: [C1] as never,
      })
    );

    // The rest proposes (criteria = a contract change, rung 2.1)…
    expect(res.status).toBe("proposed");
    // …and the reply says the filing was granted, on its receipt.
    const filing = (res as { filing?: { status: string; receiptId?: string } })
      .filing;
    expect(filing?.status).toBe("granted");
    expect(filing?.receiptId).toBeTruthy();

    // The filing the receipt claims IS written; the criteria are not.
    const row = await sessionRow(sessionId);
    expect(row.project_id).toBe(projectId);
    expect(row.criteria).toEqual([]);

    const rows = await proposalsFor(sessionId);
    const receipt = rows.find((r) => r.id === filing!.receiptId)!;
    expect(receipt.status).toBe("auto_approved");
    // Its Undo restores the project only.
    expect(receipt.data.materialized?.rowPatches).toEqual([
      {
        kind: "focus_session",
        id: sessionId,
        before: { projectId: null },
        after: { projectId },
      },
    ]);

    // The criteria proposal carries the criteria and NOT the filing: approving
    // or rejecting it can neither re-file nor un-file the session.
    const pending = rows.filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    const payload = payloadOf(pending[0]!);
    expect(payload.criteria).toEqual([C1]);
    expect(payload.projectId).toBeUndefined();
  });

  it("CONTROL: a session bound to another key — the filing is NOT granted and nothing is written", async () => {
    const projectId = await seedProject();
    h.focus = projectId;
    const sessionId = await seedOwnFreshSession();

    const res = await runWithCallingKey(randomUUID(), () =>
      updateFocusSession({
        sessionId,
        userId: USER,
        agentUserId: AGENT,
        projectId,
        criteria: [C1] as never,
      })
    );

    expect(res.status).toBe("proposed");
    expect((res as { filing?: { status: string } }).filing?.status).toBe(
      "proposed"
    );
    expect((await sessionRow(sessionId)).project_id).toBeNull();
    const rows = await proposalsFor(sessionId);
    expect(rows.some((r) => r.status === "auto_approved")).toBe(false);
  });
});
