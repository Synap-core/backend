/**
 * The update reply's nudges read the check gate AS STORED (finding 2c63fc36)
 * — on PGlite through the REAL MCP door service (`updateFocusSession`), THE
 * advance door and its check gate, the REAL judge client against a fake IS
 * at `fetch`, and the REAL nudge loader the MCP door answers with
 * (`loadSessionNudges` over the reply's session).
 *
 * What happened (session 6f5410fa, 21 Nov 2026, the founder's pod): an
 * earlier check had held on the judge criterion AND the owed pull-request
 * output, and its record stayed on the row. The output was delivered, the
 * agent advanced into the check again, and the gate held on the criterion
 * alone (the judge could not run), writing that to `metadata.checkGate`.
 * The reply's `heldByCheck.failing` still listed the delivered output: it
 * was built from the row written BEFORE the gate ran.
 *
 *  - the reply's `heldByCheck.failing` and its session's gate record equal
 *    the stored `metadata.checkGate.failing`.
 *
 * Stubbed, and why: the IS endpoint (`fetch`) and the service lookup; the
 * session's own permission ladder (granted, as for an attributed agent);
 * side effects with their own suites.
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
    /** What the IS judge endpoint answers next: status + JSON body. */
    judge: { status: 200, body: {} as unknown },
    judgeCalls: 0,
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
import { loadSessionNudges } from "../session-nudges.js";

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
const KEY = "pr-names-session";

/** The shape of "Ship a change": Checks green checks PR opened, else back to Build. */
const STAGES = [
  { key: "build", name: "Building" },
  { key: "pr-opened", name: "PR opened" },
  {
    key: "checks",
    name: "Checks green",
    gate: { kind: "check" },
    onFail: { toStage: "build" },
  },
];

const CRITERIA = [
  {
    key: KEY,
    statement:
      "The pull request body carries the line naming this Pod session.",
    check: { kind: "judge" },
    stageKey: "pr-opened",
  },
];

/** What the IS answered on 20 Nov 2026, verbatim in substance. */
const QUOTA_429 = {
  status: 429,
  body: {
    error: "Token quota exceeded",
    code: "account_quota_exceeded",
    retryable: false,
  },
};

/** A live session standing at `stage`, its run frozen on {@link STAGES}. */
async function runAt(input: {
  stage: string;
  status?: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const playbookId = randomUUID();
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, version, status, created_at, updated_at)
     values ($1, null, $2, 'Ship a change', 'Ship', 'is-agent',
             $3::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, 'active', now(), now())`,
    [playbookId, USER, JSON.stringify(STAGES)]
  );
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, playbook_id, current_stage, expected_outputs, criteria, metadata, stages, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'W1', 'Ship W1', $3, 'playbook', $4, $5,
             '[]'::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, '{}', now(), now(), now())`,
    [
      id,
      USER,
      input.status ?? "active",
      playbookId,
      input.stage,
      JSON.stringify(CRITERIA),
      JSON.stringify(input.metadata ?? {}),
      JSON.stringify(STAGES),
    ]
  );
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, created_by, definition_snapshot, started_at)
     values ($1, $2, $3, 'is-agent', 'running', $4, $5::jsonb, now())`,
    [
      randomUUID(),
      playbookId,
      id,
      USER,
      JSON.stringify({ version: 1, stages: STAGES }),
    ]
  );
  return id;
}

const sessionOf = async (id: string) =>
  (
    await q<{
      current_stage: string | null;
      status: string;
      stage_history: Array<{ stageKey: string; fromStage: string | null }>;
      metadata: Record<string, unknown>;
    }>(
      `select current_stage, status, stage_history, metadata from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;

/** The agent moves the step, as `synap_update_session currentStage` does. */
const agentMoves = (sessionId: string, from: string, to: string) =>
  updateFocusSession({
    sessionId,
    userId: USER,
    agentUserId: AGENT,
    currentStage: to,
    expectedStage: from,
  });

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
  vi.stubGlobal("fetch", async (url: unknown) => {
    if (!String(url).endsWith("/api/judge-criteria")) {
      throw new Error(`unexpected fetch ${String(url)}`);
    }
    h.judgeCalls += 1;
    return new Response(JSON.stringify(h.judge.body), {
      status: h.judge.status,
      headers: { "Content-Type": "application/json" },
    });
  });
}, 120_000);

beforeEach(async () => {
  h.judge = QUOTA_429;
  h.judgeCalls = 0;
  await h.client!.exec(
    "delete from governance_rules where target_pattern = '@reversible';"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
});

describe("the update reply's nudges after a check gate holds", () => {
  it("heldByCheck reads the gate as stored, never the previous gate's record", async () => {
    // The previous check's record, left on the row: it held on the
    // criterion AND the pull-request output (delivered since).
    const id = await runAt({
      stage: "pr-opened",
      metadata: {
        checkGate: {
          stageKey: "checks",
          fromStage: "pr-opened",
          failing: [KEY, "Pull request"],
        },
      },
    });
    h.judge = QUOTA_429;

    const res = await agentMoves(id, "pr-opened", "checks");
    expect(res.status).toBe("updated");
    if (res.status !== "updated") return;

    const stored = (await sessionOf(id)).metadata.checkGate as {
      failing: string[];
    };
    expect(stored.failing).toEqual([KEY]);
    expect(
      (res.session.metadata as { checkGate?: { failing?: string[] } }).checkGate
        ?.failing
    ).toEqual([KEY]);

    const nudges = await loadSessionNudges({
      session: res.session,
      phase: "update",
      userId: USER,
      agentUserId: AGENT,
    });
    expect(nudges).toMatchObject({
      heldByCheck: {
        stageKey: "checks",
        fromStage: "pr-opened",
        failing: [KEY],
        held: true,
      },
    });
  });
});
