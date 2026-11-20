/**
 * A JUDGE THAT COULD NOT RUN never moves work backwards (finding 881e0b61) —
 * driven on PGlite through the REAL doors: the agent's stage move
 * (`updateFocusSession`), THE advance door and its check gate
 * (`applyStageGateOnAdvance`), the evaluation ladder (`evaluateSession`) with
 * the REAL judge client and transport (`judgeSessionCriteria` →
 * `postSessionIntelligence`, so a 429 carries the status the transport
 * attributes), the ONE grade write door (`recordSessionEvaluation`), the
 * person's grade door (`gradeCriterionAsOwner`) and the agent floor
 * (`refuseAgentGateBypass` → `pendingStageGate`).
 *
 * What happened (session 6f5410fa, 20 Nov 2026): the pod's judge answered
 * HTTP 429 (AI quota spent), the judge criterion of the stage being left had
 * no grade, the "Checks green" check gate read that as failed and its
 * `onFail` sent the run back to Build; paused later for a reason of its own,
 * the stale gate record made every agent move a refusal. Each test rules out
 * one half:
 *  - a 429 records the criterion UNMEASURED with why and when to retry; the
 *    run stays, paused, on the gated stage — never sent back;
 *  - a judge that DID grade it "fail" still sends the run back (onFail stands);
 *  - the 429 spends no attempt: the judge is asked again, and its pass
 *    releases the gate; a person's grade releases it too;
 *  - a session sent back before this fix, paused for its own reason, is the
 *    agent's to resume and advance again.
 *
 * Stubbed, and why: the IS endpoint (`fetch`, no IS in unit tests) and the
 * service lookup (`resolveIntelligenceService`, its own suite); the session's
 * own permission ladder (granted, as for an attributed agent); side effects
 * with their own suites (events, realtime, room, notifications).
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
import { db as pgDb, listHolds, setSessionStatus } from "@synap/database";
import { updateFocusSession } from "../update-session.js";
import {
  evaluateSession,
  gradeCriterionAsOwner,
} from "../evaluations/evaluate.js";

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

const verdict = (v: "pass" | "fail") => ({
  status: 200,
  body: {
    verdicts: [{ key: KEY, verdict: v, rationale: `judged ${v}` }],
    decider: "llm",
    model: "judge-model",
  },
});

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

const rowsOf = async (id: string) =>
  (
    await q<{
      verdict: string;
      evaluator_kind: string;
      evaluator_id: string | null;
      evidence: Record<string, unknown>;
      rationale: string | null;
    }>(
      `select verdict, evaluator_kind, evaluator_id, evidence, rationale
         from session_evaluations where session_id = $1 order by created_at, attempt`,
      [id]
    )
  ).rows;

const holdOf = async (id: string) =>
  (
    await listHolds(pgDb as never, {
      subjects: [{ subjectType: "focus_session", subjectId: id }],
    })
  )[0]?.hold;

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

describe("a judge that could not run (HTTP 429) never sends the run back", () => {
  it("the criterion is recorded UNMEASURED with why and when to retry; the run stays, paused, on the gated stage", async () => {
    const id = await runAt({ stage: "pr-opened" });

    const res = await agentMoves(id, "pr-opened", "checks");
    expect(res.status).toBe("updated");
    expect(h.judgeCalls).toBeGreaterThan(0);

    const s = await sessionOf(id);
    // Not sent back to Build: the stage stands, the gate holds it.
    expect(s.current_stage).toBe("checks");
    expect(s.status).toBe("paused");
    expect(s.stage_history.map((e) => [e.fromStage, e.stageKey])).toEqual([
      ["pr-opened", "checks"],
    ]);
    const gate = s.metadata.checkGate as {
      failing: string[];
      judgeUnavailable?: string[];
      reason?: string;
    };
    expect(gate.failing).toEqual([KEY]);
    expect(gate.judgeUnavailable).toEqual([KEY]);
    expect(gate.reason).toContain("judge could not grade");
    expect(gate.reason).toContain("AI quota is spent");

    // The pause's own hold says it too: what the next move reads.
    const hold = await holdOf(id);
    expect(hold?.ref).toBe("check:checks");
    expect(hold?.reason).toContain("not sent back");

    // ONE row: unmeasured, by no model, carrying why and when to retry.
    const rows = await rowsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: "unmeasured",
      evaluator_kind: "judge",
      evaluator_id: null,
    });
    const why = rows[0]!.evidence.judgeUnavailable as {
      reason: string;
      retry: string;
    };
    expect(why.reason).toContain("HTTP 429");
    expect(why.retry).toContain("synap_evaluate_session");
  });

  it("CONTROL: a judge that DID grade it fail still sends the run back (onFail stands)", async () => {
    h.judge = verdict("fail");
    const id = await runAt({ stage: "pr-opened" });

    await agentMoves(id, "pr-opened", "checks");

    const s = await sessionOf(id);
    expect(s.current_stage).toBe("build");
    expect(s.status).toBe("active");
    expect(
      (s.metadata.checkGate as { judgeUnavailable?: unknown }).judgeUnavailable
    ).toBeUndefined();
  });

  it("the 429 spends no attempt: the judge is asked again, once per outage on record, and its pass releases the gate", async () => {
    const id = await runAt({ stage: "pr-opened" });
    await agentMoves(id, "pr-opened", "checks");

    // Still out of quota: asked again each time, recorded once, never spent.
    const before = h.judgeCalls;
    for (let i = 0; i < 3; i++) {
      const r = await evaluateSession({ sessionId: id, userId: USER });
      expect(r.status).toBe("evaluated");
    }
    expect(h.judgeCalls - before).toBe(3);
    expect(await rowsOf(id)).toHaveLength(1);
    expect((await sessionOf(id)).status).toBe("paused");

    // The quota is back: the judge grades it, and the gate lets the run on.
    h.judge = verdict("pass");
    const r = await evaluateSession({ sessionId: id, userId: USER });
    expect(r.status === "evaluated" && r.resumed).toBe(true);
    const s = await sessionOf(id);
    expect(s.status).toBe("active");
    expect(s.current_stage).toBe("checks");
    expect(s.metadata).not.toHaveProperty("checkGate");
    expect((await rowsOf(id)).map((x) => x.verdict)).toEqual([
      "unmeasured",
      "pass",
    ]);
  });

  it("a person grades it by hand after the 429, and the gate releases", async () => {
    const id = await runAt({ stage: "pr-opened" });
    await agentMoves(id, "pr-opened", "checks");
    expect((await sessionOf(id)).status).toBe("paused");

    const { out, resumed } = await gradeCriterionAsOwner({
      sessionId: id,
      userId: USER,
      criterionKey: KEY,
      verdict: "pass",
    });
    expect(out.status).toBe("recorded");
    expect(resumed).toBe(true);
    const s = await sessionOf(id);
    expect(s.status).toBe("active");
    expect(s.current_stage).toBe("checks");
  });
});

describe("a session the check already sent back recovers", () => {
  it("paused later for a reason of its own, its stale gate record holds nothing: the agent resumes and advances it", async () => {
    // Where session 6f5410fa stood: sent back to Build by an unmeasured
    // check, its record left on the row, then paused by its agent on a wait.
    const id = await runAt({
      stage: "build",
      metadata: {
        checkGate: {
          stageKey: "checks",
          fromStage: "pr-opened",
          failing: [KEY],
        },
      },
    });
    await setSessionStatus(pgDb as never, {
      sessionId: id,
      from: "active",
      to: "paused",
      actor: { kind: "agent", userId: USER, agentUserId: AGENT },
      hold: {
        on: "external",
        ref: "a release",
        reason: "The contract PR waits for a release.",
      },
    });

    const resume = await updateFocusSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      status: "active",
    });
    expect(resume.status).toBe("updated");
    expect((await sessionOf(id)).status).toBe("active");

    const move = await agentMoves(id, "build", "pr-opened");
    expect(move.status).toBe("updated");
    expect((await sessionOf(id)).current_stage).toBe("pr-opened");
  });

  it("CONTROL: a session the check gate itself holds is still not the agent's to resume", async () => {
    const id = await runAt({ stage: "pr-opened" });
    await agentMoves(id, "pr-opened", "checks");
    expect((await sessionOf(id)).status).toBe("paused");

    const res = await updateFocusSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      status: "active",
    });
    expect(res.status).toBe("denied");
    expect((await sessionOf(id)).status).toBe("paused");
  });
});
