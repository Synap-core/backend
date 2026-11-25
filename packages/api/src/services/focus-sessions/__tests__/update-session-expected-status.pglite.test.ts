/**
 * A session move with `expectedStatus` that finds the session moved ANSWERS a
 * conflict; it never throws (finding 4940db62) — on PGlite through the REAL
 * MCP door service (`updateFocusSession`) and its write (`writeSessionPatch`).
 *
 * What happened (session 6f5410fa, 20 Nov 2026): its check gate had sent the
 * run back to Build, active. The agent, still believing it paused, sent
 * `update_session {status: "paused", expectedStatus: "paused", hold}` and got
 * the server exception "Cannot read properties of null (reading 'status')":
 * the door built a `LifecycleConflictError` and asked `lifecycleConflictOf`
 * for its result, which read only an error CARRYING one as its cause, so it
 * answered null and the MCP door read `null.status`.
 *
 *  - stale `expectedStatus` → `status: "conflict"` naming the current status;
 *    nothing written (the session stays active, no hold);
 *  - CONTROL: the right `expectedStatus` → the pause applies, with its hold;
 *  - the two error shapes a door meets both read as the conflict.
 *
 * Stubbed, and why: the session's own permission ladder (granted, as for an
 * attributed agent); side effects with their own suites.
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
import { db as pgDb, LifecycleConflictError, listHolds } from "@synap/database";
import {
  lifecycleConflictError,
  lifecycleConflictOf,
} from "../../lifecycle/conflict.js";
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

const holdOf = async (id: string) =>
  (
    await listHolds(pgDb as never, {
      subjects: [{ subjectType: "focus_session", subjectId: id }],
    })
  )[0]?.hold;

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
  h.judgeCalls = 0;
  await h.client!.exec(
    "delete from governance_rules where target_pattern = '@reversible';"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
});

describe("a session pause with expectedStatus never throws", () => {
  it("a stale expectedStatus answers conflict with the current status, and writes nothing", async () => {
    const id = await runAt({ stage: "build" });

    const res = await updateFocusSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      status: "paused",
      expectedStatus: "paused",
      hold: {
        on: "external",
        ref: "a release",
        reason: "The contract PR waits for a release.",
      },
    });

    expect(res).not.toBeNull();
    expect(res).toMatchObject({
      status: "conflict",
      conflict: { expectedStatus: "paused", currentStatus: "active" },
    });
    expect((await sessionOf(id)).status).toBe("active");
    expect(await holdOf(id)).toBeUndefined();
  });

  it("CONTROL: the status the agent saw applies the pause, with its hold", async () => {
    const id = await runAt({ stage: "build" });

    const res = await updateFocusSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      status: "paused",
      expectedStatus: "active",
      hold: {
        on: "external",
        ref: "a release",
        reason: "The contract PR waits for a release.",
      },
    });

    expect(res.status).toBe("updated");
    expect((await sessionOf(id)).status).toBe("paused");
    expect((await holdOf(id))?.ref).toBe("a release");
  });

  it("both error shapes read as the conflict: the bare error and one carried as a cause", () => {
    const bare = new LifecycleConflictError("paused", "active");
    expect(lifecycleConflictOf(bare)).toMatchObject({
      status: "conflict",
      conflict: { expectedStatus: "paused", currentStatus: "active" },
    });
    expect(
      lifecycleConflictOf(lifecycleConflictError("paused", "active"))
    ).toMatchObject({
      status: "conflict",
      conflict: { expectedStatus: "paused", currentStatus: "active" },
    });
    expect(lifecycleConflictOf(new Error("other"))).toBeNull();
  });
});
