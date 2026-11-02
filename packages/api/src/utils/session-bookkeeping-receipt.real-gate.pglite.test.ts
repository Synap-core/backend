/**
 * A session's own bookkeeping, auto-approved, leaves NO proposals row and ONE
 * event on the session's spine (plan 527996fa, wave 0 item 0.7), through the
 * REAL gate: `checkPermissionOrPropose` → `resolveAgentGovernanceDecision` →
 * the receipt door, on PGlite with every @synap/database table. Only the event
 * append is a spy (the event log writes over its own connection).
 *
 * Rows, each ruling out a wrong outcome:
 *  - the agent's update of its OWN session, asked as `sessionReceipt:
 *    "activity"`: granted, 0 proposals rows, 1 `focus_session.update.completed`
 *    event on that session naming the fields and the verdict — rules out "the
 *    receipt is still a proposals row" and "the audit trail was dropped";
 *  - CONTROL, same write without the option (a door whose Undo reads the
 *    receipt): 1 AUTO_APPROVED row, as before — rules out "the gate stopped
 *    writing receipts for everyone";
 *  - an agent NOT on the session's roster, with the option: still a proposals
 *    row — rules out "the caller's word is the proof" (ownership is read from
 *    the session row);
 *  - the AI-sourced key with no agent row (the anonymous principal), with the
 *    option: 0 rows, 1 event marked AI-sourced — the 865-of-1,000 path of the
 *    usage review.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
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
        const db = drizzle(client, { schema });
        // PGlite is ONE connection: run a transaction body on the same handle
        // (as entity.delete.real-gate.pglite.test.ts does).
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
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

const { auditSpy } = vi.hoisted(() => ({
  auditSpy: vi.fn(async (_opts: Record<string, unknown>) => ({
    id: globalThis.crypto.randomUUID(),
  })),
}));

vi.mock("../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: globalThis.crypto.randomUUID() }) }
  );
  const db = await h.init();
  return { ...actual, db, getDb: async () => db, eventRepository };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("./audit-log.js", () => ({ auditLog: auditSpy }));
vi.mock("./domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));
vi.mock("./split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { checkPermissionOrPropose } from "./permission-check.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
const STRANGER = randomUUID();

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
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function seedSession(agentIds: string[]): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, agent_ids, expected_outputs)
     values ($1, $2, 'Ship the fix', 'active', $3, '[]'::jsonb)`,
    [id, OWNER, agentIds]
  );
  return id;
}

async function receiptRows(sessionId: string) {
  const { rows } = await q<{ status: string; proposal_type: string }>(
    `select status, proposal_type from proposals where target_id = $1`,
    [sessionId]
  );
  return rows;
}

function update(
  sessionId: string,
  agentUserId: string | undefined,
  receipt: boolean
) {
  return checkPermissionOrPropose({
    userId: OWNER,
    agentUserId,
    subjectType: "focus_session",
    action: "update",
    source: "intelligence",
    ...(receipt ? { sessionReceipt: "activity" as const } : {}),
    data: {
      id: sessionId,
      sessionName: "Ship the fix",
      progress: 40,
      currentStage: "build",
    },
  });
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    OWNER,
    "owner@x.test",
  ]);
  for (const [id, email] of [
    [AGENT, "agent@x.test"],
    [STRANGER, "stranger@x.test"],
  ] as const) {
    await q(
      `insert into users (id, email, user_type, created_by_user_id, agent_type)
       values ($1, $2, 'agent', $3, 'claude-code')`,
      [id, email, OWNER]
    );
  }
}, 120_000);

beforeEach(() => auditSpy.mockClear());

const receiptEvents = (sessionId: string) =>
  auditSpy.mock.calls
    .map(([opts]) => opts)
    .filter(
      (o) =>
        o.subjectType === "focus_session" &&
        o.action === "update" &&
        o.phase === "completed" &&
        o.subjectId === sessionId
    );

describe("a session's own bookkeeping receipt is an event, not a proposals row (0.7)", () => {
  it("the agent's update of its own session: granted, no proposals row, one event on the session", async () => {
    const sessionId = await seedSession([AGENT]);

    const perm = await update(sessionId, AGENT, true);

    expect(perm).toEqual({ granted: true });
    expect(await receiptRows(sessionId)).toEqual([]);
    const events = receiptEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: OWNER,
      agentUserId: AGENT,
      isAgent: true,
      sessionId,
      data: {
        fields: ["currentStage", "progress"],
        autoApproved: expect.objectContaining({
          approvedBy: "system:auto_approve",
        }),
      },
    });
  });

  it("CONTROL: without the option the receipt is still an AUTO_APPROVED proposals row", async () => {
    const sessionId = await seedSession([AGENT]);

    const perm = await update(sessionId, AGENT, false);

    expect(perm).toMatchObject({
      granted: true,
      autoApprovedProposalId: expect.any(String),
    });
    expect(await receiptRows(sessionId)).toEqual([
      { status: "auto_approved", proposal_type: "focus_session.update" },
    ]);
    expect(receiptEvents(sessionId)).toEqual([]);
  });

  it("an agent not on the session's roster keeps its proposals receipt, whatever the door asked", async () => {
    const sessionId = await seedSession([AGENT]);

    const perm = await update(sessionId, STRANGER, true);

    expect("granted" in perm && perm.granted).toBe(true);
    expect(await receiptRows(sessionId)).toHaveLength(1);
    expect(receiptEvents(sessionId)).toEqual([]);
  });

  it("the AI-sourced key with no agent row: no proposals row, one AI-sourced event", async () => {
    const sessionId = await seedSession([]);

    const perm = await update(sessionId, undefined, true);

    expect(perm).toEqual({ granted: true });
    expect(await receiptRows(sessionId)).toEqual([]);
    const events = receiptEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentUserId: null,
      isAgent: true,
      data: {
        autoApproved: expect.objectContaining({ principal: "anonymous" }),
      },
    });
  });
});
