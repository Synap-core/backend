/**
 * A CHECK GATE WHOSE AI JUDGE COULD NOT RUN HOLDS; IT NEVER SENDS THE RUN BACK.
 *
 * Live (20 Nov 2026, findings 881e0b61 and 0f4fd344): two playbook sessions
 * finished their work, the stage's AI judge got `HTTP 429 … account_quota_exceeded`
 * from the IS, its criteria were skipped, and the check gate applied `onFail`:
 * the run went back a stage as if the work had failed. Founder decision: a
 * judge that cannot run holds the stage, with a human grade available.
 *
 * Through the REAL advance door (`advanceSessionStage` → `applyStageGateOnAdvance`
 * → `evaluateSession` → the REAL judge client and transport against a fake IS
 * at `fetch`), the REAL gate and its `onFail`, and the REAL owner-grade door
 * (`gradeCriterionAsOwner` → `resumeCheckGateIfMet`), on one PGlite:
 *  - the IS refuses the judge (account quota): the session is held at the
 *    gate, paused, with the failure in words and the owner's way out; it is
 *    NOT moved to `onFail.toStage`;
 *  - the judge answers `fail`: the run still goes back to `onFail` (a door
 *    that never sent back fails this);
 *  - the owner grades the held criterion: the gate resumes.
 *
 * Stubbed, and why: the IS service lookup (`resolveIntelligenceService`) and
 * the produced-work read (`loadProducedMaterial`, its own suite in
 * `judge-material.test.ts`), the subject-status writers (the session has no
 * subject; their suite covers the governed door), event fan-out.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    /** What the fake IS answers on `/api/judge-criteria`. */
    judge: null as null | (() => Response),
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
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});
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
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../stage-subject-status.js", () => ({
  writeStageSubjectStatus: async () => ({ status: "skipped" }),
  writeGatePassStatuses: async () => ({ entered: { status: "skipped" } }),
}));
vi.mock("../evaluations/judge-material.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadProducedMaterial: async () => [],
}));
vi.mock("@synap/intelligence-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIntelligenceService: vi.fn(async () => ({
    endpoint: "http://is",
    serviceApiKey: "k",
  })),
}));

import { pgliteAllTablesDdl } from "../../../__tests__/pglite-ddl.js";
import { advanceSessionStage } from "../advance-stage.js";
import { gradeCriterionAsOwner } from "../evaluations/evaluate.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const AGENT = randomUUID();

const STAGES = [
  { key: "work", name: "Work" },
  {
    key: "review",
    name: "Review",
    gate: { kind: "check" },
    onFail: { toStage: "work" },
  },
  { key: "done", name: "Done" },
];
const CRITERIA = [
  {
    key: "audit",
    statement: "The audit cites file:line evidence",
    check: { kind: "judge" },
    stageKey: "work",
  },
];

/** The IS quota middleware's refusal, as it answered on 20 Nov 2026. */
const QUOTA_429 = () =>
  new Response(
    JSON.stringify({
      error: "Token quota exceeded",
      message: "Monthly token quota exceeded for this account",
      failure: { code: "account_quota_exceeded", retryable: false },
    }),
    { status: 429, statusText: "Too Many Requests" }
  );

/**
 * The judge answered with no verdict: the only model left to grade is the
 * one that did the work (`decider: "none"`, IS judge.ts).
 */
const NO_DECIDER = () =>
  Response.json({
    decider: "none",
    verdicts: [
      {
        key: "audit",
        verdict: "unmeasured",
        rationale:
          "The only available judge is the model that did the work — it may not grade itself.",
      },
    ],
  });

const VERDICT = (verdict: "pass" | "fail") => () =>
  Response.json({
    decider: "llm",
    model: "judge/model-b",
    verdicts: [{ key: "audit", verdict, rationale: "read the audit" }],
  });

/** An active session at "work", following its playbook's run. */
async function sessionAtWork(): Promise<string> {
  const playbookId = randomUUID();
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, version, status, created_at, updated_at)
     values ($1, null, $2, 'Ship an audit', 'Ship it', 'is-agent',
             $3::jsonb, $4::jsonb, '[]'::jsonb, '[]'::jsonb, 1, 'active', now(), now())`,
    [playbookId, USER, JSON.stringify(STAGES), JSON.stringify(CRITERIA)]
  );
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, playbook_id, current_stage, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Ship the audit', 'Ship the audit', 'active', 'playbook', $3, 'work',
             '[]'::jsonb, $4::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
    [id, USER, playbookId, JSON.stringify(CRITERIA)]
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

/** The agent finishes "work" and moves into the check-gated "review". */
async function advanceToReview(sessionId: string) {
  const [row] = (
    await q<{ playbook_id: string }>(
      `select playbook_id from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows;
  return advanceSessionStage({
    session: {
      id: sessionId,
      currentStage: "work",
      workspaceId: null,
      projectId: null,
      channelId: null,
      playbookId: row!.playbook_id,
      subjectEntityId: null,
    },
    toStage: "review",
    userId: USER,
    agentUserId: AGENT,
    stageWrite: "door",
  });
}

const sessionOf = async (id: string) =>
  (
    await q<{
      status: string;
      current_stage: string | null;
      metadata: Record<string, unknown> | null;
    }>(
      `select status, current_stage, metadata from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0];

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

beforeEach(() => {
  h.judge = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).endsWith("/api/judge-criteria") && h.judge
        ? h.judge()
        : new Response("not found", { status: 404 })
    )
  );
});

describe("a check gate whose AI judge could not run", () => {
  it("holds the session at the gate, paused, and never moves it to onFail", async () => {
    h.judge = QUOTA_429;
    const sessionId = await sessionAtWork();

    const res = await advanceToReview(sessionId);

    expect(res).toMatchObject({ gated: true, paused: true });
    expect(res.onFail).toBeUndefined();
    expect(await sessionOf(sessionId)).toMatchObject({
      status: "paused",
      current_stage: "review",
    });
    // The hold says the AI judge could not run, why (the described failure,
    // never the raw HTTP body), and that the owner can grade by hand.
    const gate = (await sessionOf(sessionId))!.metadata?.checkGate as {
      reason?: string;
    };
    expect(gate.reason).toContain("The AI judge could not run");
    expect(gate.reason).toContain("out of AI credits");
    expect(gate.reason).toContain('the owner can grade "audit" by hand');
    expect(gate.reason).not.toContain("HTTP 429");
  });

  it("the owner's grade resumes the held gate", async () => {
    h.judge = QUOTA_429;
    const sessionId = await sessionAtWork();
    await advanceToReview(sessionId);

    const { resumed } = await gradeCriterionAsOwner({
      sessionId,
      userId: USER,
      criterionKey: "audit",
      verdict: "pass",
    });

    expect(resumed).toBe(true);
    expect(await sessionOf(sessionId)).toMatchObject({
      status: "active",
      current_stage: "review",
    });
  });
});

describe("a check gate whose judge answered with no decider", () => {
  it("holds at the gate like any judge that could not run, and never moves to onFail", async () => {
    h.judge = NO_DECIDER;
    const sessionId = await sessionAtWork();

    const res = await advanceToReview(sessionId);

    expect(res).toMatchObject({ gated: true, paused: true });
    expect(res.onFail).toBeUndefined();
    expect(await sessionOf(sessionId)).toMatchObject({
      status: "paused",
      current_stage: "review",
    });
    const gate = (await sessionOf(sessionId))!.metadata?.checkGate as {
      reason?: string;
    };
    expect(gate.reason).toContain(
      "The AI judge could not run: The only available judge is the model that did the work"
    );
    expect(gate.reason).toContain('the owner can grade "audit" by hand');
  });
});

describe("a check gate whose judge ran and said fail", () => {
  it("still sends the run back to its onFail stage", async () => {
    h.judge = VERDICT("fail");
    const sessionId = await sessionAtWork();

    const res = await advanceToReview(sessionId);

    expect(res.onFail).toEqual({ toStage: "work" });
    expect(await sessionOf(sessionId)).toMatchObject({
      status: "active",
      current_stage: "work",
    });
  });
});
