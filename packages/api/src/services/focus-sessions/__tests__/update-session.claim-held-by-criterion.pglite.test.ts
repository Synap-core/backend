/**
 * `completeOutput` on an output a REQUIRED criterion checks (W4), through the
 * real MCP door service (`updateFocusSession`) on PGlite:
 *
 *  - finding f301e997: the reply named no evidence although the call set the
 *    slot's `ref`; the output waits for its criterion, and the reply now says
 *    which (key and statement). "No evidence" stays for a claim with none.
 *  - finding f3c864cc, the update door's half: the claim makes the output, so
 *    the person's grade on it comes due in this write, and its `owedSince` is
 *    stamped now. This door owes its transitions BEFORE it writes, so it
 *    stamps its own list (the funnel's restamp covers the doors that write
 *    first: `declared-grade-outcomes-owed-since.pglite.test.ts`).
 *
 * Stubbed, and why (the `update-session-expected-status` harness): the
 * session's own permission ladder (granted, as for an attributed agent); side
 * effects with their own suites.
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
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
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

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  await h.init();
  const sql = Object.assign(
    () => {
      throw new Error("tagged sql is not available in this suite");
    },
    {
      unsafe: async (text: string, params: unknown[] = []) =>
        (await h.client!.query(text, params)).rows,
    }
  );
  const EventRepository = actual.EventRepository as new (s: unknown) => {
    append: (e: unknown) => Promise<unknown>;
  };
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    eventRepository: new EventRepository(sql),
    sql,
    registerIdentitySignals: async () => undefined,
  };
});
// The service lookup only: the judge client and its transport stay real.
vi.mock("@synap/intelligence-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIntelligenceService: async () => ({
    endpoint: "http://is.test",
    serviceApiKey: "k",
    agentUserId: null,
  }),
}));
vi.mock("../../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  dispatchLifecycleTransition: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<{
    checkPermissionOrPropose: (o: { subjectType?: string }) => unknown;
  }>();
  return {
    ...actual,
    checkPermissionOrPropose: async (o: { subjectType?: string }) =>
      o.subjectType === "focus_session"
        ? { granted: true }
        : actual.checkPermissionOrPropose(o),
  };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../../proposals/expire-lapsed-proposals.js", () => ({
  expireSessionEphemerals: async () => 0,
}));
vi.mock("../../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: vi.fn(async () => undefined),
}));
vi.mock("../ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../../messaging/post-message.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postChannelMessage: async () => ({ messageId: "m-1", ackState: "acked" }),
}));

import { pgliteAllTablesDdl } from "../../../__tests__/pglite-ddl.js";
import { updateFocusSession } from "../update-session.js";

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
const DECLARED_AT = "2026-01-01T00:00:00.000Z";

const CRITERION = {
  key: "checklist-ok",
  statement: "The checklist reads right",
  check: { kind: "human" },
  outputKey: "checklist",
};

/** The dogfood session: an output, and the person's grade declared on it. */
async function sessionWith(criteria: unknown[]): Promise<string> {
  const outputs = [
    { key: "checklist", kind: "document", label: "Checklist" },
    { key: "notes", kind: "document", label: "Notes" },
    ...(criteria.length > 0
      ? [
          {
            key: "check-checklist-reads-right",
            kind: "criterion",
            label: "Check: The checklist reads right",
            criterionKey: "checklist-ok",
            outputKey: "checklist",
            status: "pending",
            owner: "human",
            blockedReason: "decision",
            why: 'You grade this one: mark "The checklist reads right" pass or fail.',
            owedSince: DECLARED_AT,
          },
        ]
      : []),
  ];
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Checklist', 'Write the checklist', 'active',
             $3::jsonb, $4::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
    [id, USER, JSON.stringify(outputs), JSON.stringify(criteria)]
  );
  return id;
}

const outputsOf = async (id: string) =>
  (
    await q<{ expected_outputs: Array<Record<string, unknown>> }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.expected_outputs;

/** `completeOutput` with the slot's `ref` set in the same call. */
const claimWithRef = (id: string, key: string) =>
  updateFocusSession({
    sessionId: id,
    userId: USER,
    agentUserId: AGENT,
    expectedOutputs: [
      {
        key,
        kind: "document",
        label: key === "checklist" ? "Checklist" : "Notes",
        ref: { url: `https://example.com/${key}` },
      },
    ],
    completeOutput: key,
  } as Parameters<typeof updateFocusSession>[0]);

type Reply = {
  completeOutput?: { result: string; verified?: number; message?: string };
};

beforeAll(async () => {
  await h.init();
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `insert into users (id, name, email, user_type) values ($1, 'Founder', 'f@x', 'human')`,
    [USER]
  );
  await q(
    `insert into users (id, name, email, user_type, agent_type, agent_metadata, created_by_user_id)
     values ($1, 'Agent', 'a@x', 'agent', 'claude-code', '{}'::jsonb, $2)`,
    [AGENT, USER]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from governance_rules where target_pattern = '@reversible';"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
});

describe("completeOutput on an output its criterion holds (finding f301e997)", () => {
  it("names the criterion it waits for, never 'no evidence'", async () => {
    const id = await sessionWith([CRITERION]);
    const res = (await claimWithRef(id, "checklist")) as Reply;
    expect(res.completeOutput).toMatchObject({ result: "claimed" });
    const message = res.completeOutput!.message!;
    expect(message).toContain('"checklist-ok"');
    expect(message).toContain("The checklist reads right");
    expect(message).toContain("the person grades it");
    expect(message).not.toMatch(/No evidence/);
    // Held, not closed: the criterion decides.
    const slot = (await outputsOf(id)).find((o) => o.key === "checklist")!;
    expect(slot.status).not.toBe("done");
    expect(slot.claimedDone).toBe(true);
  });

  it("CONTROL: the same call on an output no criterion checks is verified", async () => {
    const id = await sessionWith([CRITERION]);
    const res = (await claimWithRef(id, "notes")) as Reply;
    expect(res.completeOutput).toMatchObject({
      result: "completed",
      verified: 1,
    });
  });

  it("CONTROL: a claim with no evidence still says so", async () => {
    const id = await sessionWith([CRITERION]);
    const res = (await updateFocusSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      completeOutput: "checklist",
    })) as Reply;
    expect(res.completeOutput).toMatchObject({ result: "claimed" });
    expect(res.completeOutput!.message).toMatch(/No evidence is attributed/);
  });
});

describe("the grade comes due in the update door's write (finding f3c864cc)", () => {
  it("the claim makes the output: the grade's owedSince is stamped now", async () => {
    const id = await sessionWith([CRITERION]);
    const t0 = new Date().toISOString();
    await claimWithRef(id, "checklist");
    const grade = (await outputsOf(id)).find((o) => o.kind === "criterion")!;
    expect(String(grade.owedSince) >= t0).toBe(true);
  });

  it("CONTROL: a claim on another output leaves the declared age", async () => {
    const id = await sessionWith([CRITERION]);
    await claimWithRef(id, "notes");
    const grade = (await outputsOf(id)).find((o) => o.kind === "criterion")!;
    expect(grade.owedSince).toBe(DECLARED_AT);
  });
});
