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
 * And when AI comes back by itself (W3): the hold of an AVAILABILITY failure
 * also waits on `ai:available`; the pod's pull recording AI available again
 * and the REAL hold-resume worker (its devFact wake and its hourly sweep,
 * with the REAL regrader in its slot) grade the gate again:
 *  - the judge now passes: the run moves on by itself;
 *  - AI is still refused: it stays held, the same hold;
 *  - the judge now says fail: the check's own hold, and back to `onFail`;
 *  - AI available BEFORE the pause began is no news: nothing runs;
 *  - a judge failure that is not about availability (a 5xx) holds for the
 *    owner's grade only, with no wait on AI.
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
import { regradeAiHeldGate } from "../ai-held-gate.js";
import { listHolds, recordPodAiAvailability } from "@synap/database";
import {
  handleHoldResume,
  registerAiHeldGateRegrader,
} from "@synap/jobs/workers/hold-resume.js";

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
    expect(gate.reason).toContain("monthly AI quota");
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


/** The session's current hold, as the transition log records it. */
const holdOf = async (sessionId: string) =>
  (
    await listHolds((await h.init()) as Parameters<typeof listHolds>[0], {
      subjects: [{ subjectType: "focus_session", subjectId: sessionId }],
    })
  )[0]?.hold;

/** The pod's pull records an answer from the CP at `at`. */
const pulled = (state: "ok" | "empty", at: Date) =>
  recordPodAiAvailability(
    {
      billing: {
        readFailed: false,
        state,
        threshold: null,
        dismissKey: null,
        resetsAt: null,
        viewerRole: "pod_owner",
        canTopUp: true,
        action: state === "ok" ? "none" : "top_up",
        actionUrl: state === "ok" ? null : "https://cp.example/credits",
      },
      checkedAt: at.toISOString(),
    },
    at
  );

/** A UPSTREAM fault, not an availability state. */
const UPSTREAM_502 = () =>
  new Response(JSON.stringify({ error: "Bad gateway" }), { status: 502 });

describe("a check gate held because AI was not available grades again when AI is back", () => {
  beforeAll(() => {
    registerAiHeldGateRegrader((held) => regradeAiHeldGate(held));
  });
  beforeEach(async () => {
    await q(`delete from pod_settings`);
    // AI was out before the pause: the pull's memory says not available.
    await pulled("empty", new Date(Date.now() - 60_000));
  });

  /** Credits empty at the advance: held on the check AND on AI. */
  async function heldOnAi(): Promise<string> {
    h.judge = QUOTA_429;
    const sessionId = await sessionAtWork();
    await advanceToReview(sessionId);
    return sessionId;
  }

  it("holds on ai:available with the payer's wait, and a pass after AI is back moves on by itself", async () => {
    const sessionId = await heldOnAi();
    expect(await holdOf(sessionId)).toMatchObject({
      on: "external",
      ref: "check:review",
      until: { moves: "ai:available" },
    });

    // The credits came back: the pull sees it, the wake runs the worker.
    h.judge = VERDICT("pass");
    await pulled("ok", new Date(Date.now() + 1_000));
    await handleHoldResume({ devFact: "ai:available" });

    expect(await sessionOf(sessionId)).toMatchObject({
      status: "active",
      current_stage: "review",
    });
    expect(await holdOf(sessionId)).toBeUndefined();
  });

  it("the hourly sweep re-checks it too", async () => {
    const sessionId = await heldOnAi();
    h.judge = VERDICT("pass");
    await pulled("ok", new Date(Date.now() + 1_000));
    await handleHoldResume({});
    expect(await sessionOf(sessionId)).toMatchObject({ status: "active" });
  });

  it("AI still refused when it is graded again: it stays held, the same hold", async () => {
    const sessionId = await heldOnAi();
    const before = await holdOf(sessionId);
    await pulled("ok", new Date(Date.now() + 1_000));
    await handleHoldResume({ devFact: "ai:available" });
    expect(await sessionOf(sessionId)).toMatchObject({
      status: "paused",
      current_stage: "review",
    });
    expect(await holdOf(sessionId)).toEqual(before);
  });

  it("the judge says fail once AI is back: the check's own hold, then back to onFail", async () => {
    const sessionId = await heldOnAi();
    h.judge = VERDICT("fail");
    await pulled("ok", new Date(Date.now() + 1_000));
    await handleHoldResume({ devFact: "ai:available" });
    expect(await sessionOf(sessionId)).toMatchObject({
      status: "active",
      current_stage: "work",
    });
  });

  it("AI available before the pause began is no news: nothing is graded", async () => {
    await pulled("ok", new Date(Date.now() - 30_000));
    const sessionId = await heldOnAi();
    h.judge = VERDICT("pass");
    await handleHoldResume({ devFact: "ai:available" });
    expect(await sessionOf(sessionId)).toMatchObject({ status: "paused" });
  });

  it("a judge failure that is not about availability holds for the owner's grade, with no wait on AI", async () => {
    h.judge = UPSTREAM_502;
    const sessionId = await sessionAtWork();
    const res = await advanceToReview(sessionId);
    expect(res).toMatchObject({ gated: true, paused: true });
    expect(res.onFail).toBeUndefined();
    const hold = await holdOf(sessionId);
    expect(hold).toMatchObject({ on: "thing", ref: "check:review" });
    expect(hold?.until ?? null).toBeNull();
  });
});
