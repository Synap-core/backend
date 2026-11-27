/**
 * A HOLD THAT ASKED TO WAKE ITS AGENT WAKES IT, ONCE, WHEN IT RESUMES.
 *
 * Founder (27 Nov 2026): when a hold resumes, nothing woke the agent that holds
 * the session; the resume follow-up only refreshed goal judgements, revived
 * stale runs and re-checked stage tools. A pause may now ask for it
 * (`hold.wake`), and the resume calls the ONE door that wakes whatever agent
 * holds a session (`wakeSessionHolder`).
 *
 * Through the REAL pause door (`setSessionStatus`, the hold recorded in the
 * transition log), the REAL hold-resume worker (`handleHoldResume`, its
 * awaited-move path) with the REAL api follow-up in its slot
 * (`holdResumeFollowUp`), the REAL room post door, the REAL wake target rule
 * and the REAL door, on one PGlite:
 *  - a session paused until a thing moves, with `wake`, is resumed by that
 *    move and its pod-run agent gets exactly ONE turn, told why (what moved)
 *    and what it waited on, fenced as data; a redelivered move and a replayed
 *    follow-up wake nobody again;
 *  - the same pause WITHOUT `wake` resumes and wakes nobody (no behaviour
 *    change for existing holds);
 *  - a wake that fails (the turn cannot be queued) leaves the resume applied
 *    and the job green: the failure is reported, never thrown into the resume;
 *  - the door: a closed session or one with no agent wakes nobody and says so;
 *    a burst past the cap is held.
 *
 * Stubbed, and why: the IS turn door (`triggerAutoRespond`, CAPTURED — the
 * call and its named agent are what is under test; pg-boss + IS resolution
 * are its own suite), the stage runner's tool re-check (its own suite),
 * event fan-out and realtime transports (no transport here), the channel
 * visibility predicate (its own suite).
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
    triggers: [] as Array<Record<string, unknown>>,
    /** What the IS turn door answers (false = it could not queue the turn). */
    triggerAnswer: true,
    /** The stage runner's tool re-check throws (an earlier follow-up fails). */
    recheckThrows: false,
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
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    emitMessageEvent: async () => undefined,
  };
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
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../notifications/expo-push.js", () => ({
  sendExpoPush: async () => ({ sent: 1, revoked: 0, failed: 0 }),
}));
vi.mock("../../../utils/channel-visibility.js", async (importOriginal) => {
  const { sql } = await import("drizzle-orm");
  return {
    ...(await importOriginal<
      typeof import("../../../utils/channel-visibility.js")
    >()),
    channelVisibilityWhere: () => sql`true`,
  };
});
vi.mock("../../playbooks/stage-runner.js", () => ({
  recheckStageTools: async () => {
    if (h.recheckThrows) throw new Error("tool re-check failed");
  },
}));
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async (p: Record<string, unknown>) => {
    h.triggers.push(p);
    return h.triggerAnswer;
  },
}));

import { pgliteAllTablesDdl } from "../../../__tests__/pglite-ddl.js";
import { setSessionStatus } from "@synap/database";
import {
  handleHoldResume,
  registerHoldResumeFollowUp,
} from "@synap/jobs/workers/hold-resume.js";
import { holdResumeFollowUp } from "../../lifecycle/hold-resume-follow-up.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const POD_AGENT = randomUUID();

/** An active session in its own room, worked by `agentIds`. */
async function session(
  agentIds: string[] = [POD_AGENT],
  status = "active"
): Promise<{ sessionId: string; channelId: string }> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at)
     values ($1, $2, 'group', 'Sign the lease', now(), now())`,
    [channelId, OWNER]
  );
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, expected_outputs, criteria, metadata, agent_ids, channel_id, started_at, created_at, updated_at)
     values ($1, $2, 'Sign the lease', 'Sign the lease', $3, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, $4, $5, now(), now(), now())`,
    [sessionId, OWNER, status, agentIds, channelId]
  );
  return { sessionId, channelId };
}

/** Pause the session until `thing` moves, through the real door. */
async function pauseUntilMoved(
  sessionId: string,
  thing: string,
  wake?: boolean
): Promise<void> {
  await setSessionStatus(
    h.db as never,
    {
      sessionId,
      from: "active",
      to: "paused",
      actor: { kind: "human", userId: OWNER },
      hold: {
        on: "thing",
        ref: `entity:${thing}`,
        reason: "Waits for the signed contract",
        until: { moves: `entity:${thing}` },
        ...(wake === undefined ? {} : { wake }),
      },
    } as never
  );
}

/** The awaited thing moved: the worker's awaited-move path. */
const moved = (thing: string) =>
  handleHoldResume({
    awaiting: {
      subjectType: "entity",
      subjectId: thing,
      to: "done",
      category: "done",
    },
  });

const statusOf = async (sessionId: string) =>
  (
    await q<{ status: string }>(
      `select status from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.status;
const roomOf = async (channelId: string) =>
  (
    await q<{ id: string; role: string; content: string }>(
      `select id, role, content from messages where channel_id = $1 order by timestamp`,
      [channelId]
    )
  ).rows;
const holdTransitionOf = async (sessionId: string) =>
  (
    await q<{ id: string; hold: Record<string, unknown> }>(
      `select transition->>'transitionId' as id, transition->'hold' as hold
         from lifecycle_transition_outbox
        where transition->>'subjectId' = $1 and transition->>'to' = 'paused'
        order by (transition->>'recordedAt') desc limit 1`,
      [sessionId]
    )
  ).rows[0]!;

beforeAll(async () => {
  await h.init();
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `insert into users (id, name, email, user_type) values ($1, 'Founder', 'f@x', 'human')`,
    [OWNER]
  );
  // A pod-run agent: an agent user with a type, no key of its own, no binding.
  await q(
    `insert into users (id, name, email, user_type, agent_type, agent_metadata, created_by_user_id)
     values ($1, 'Researcher', 'r@x', 'agent', 'researcher', '{}'::jsonb, $2)`,
    [POD_AGENT, OWNER]
  );
  // The api's follow-up in the worker's slot, as apps/api registers it at boot.
  registerHoldResumeFollowUp((resumed) => holdResumeFollowUp(resumed));
}, 120_000);

beforeEach(() => {
  h.triggers = [];
  h.triggerAnswer = true;
  h.recheckThrows = false;
});

describe("a hold that asked to wake its agent, resumed by a move", () => {
  it("wakes the session's agent exactly once, with why it resumed and what it waited on", async () => {
    const thing = randomUUID();
    const { sessionId, channelId } = await session();
    await pauseUntilMoved(sessionId, thing, true);
    expect((await holdTransitionOf(sessionId)).hold).toMatchObject({
      wake: true,
    });

    expect(await moved(thing)).toMatchObject({ resumed: 1 });
    expect(await statusOf(sessionId)).toBe("active");

    // ONE turn, for the agent working the session, in its session.
    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]).toMatchObject({
      channelId,
      focusSessionId: sessionId,
      agentType: "researcher",
      sourceUserId: OWNER,
    });
    const content = String(h.triggers[0]!.content);
    expect(content).toContain(
      `What it waited on (entity:${thing}) moved to done.`
    );
    // What the pauser wrote reaches the agent as fenced data.
    expect(content).toMatch(
      /BEGIN UNTRUSTED CONTENT[\s\S]*Waits for the signed contract[\s\S]*END UNTRUSTED CONTENT/
    );
    // The note it is woken at is in the room, written by the pod.
    const room = await roomOf(channelId);
    expect(room).toHaveLength(1);
    expect(room[0]).toMatchObject({
      id: h.triggers[0]!.userMessageId,
      role: "system",
    });

    // The same move delivered again: nothing is held any more, nobody woken.
    expect(await moved(thing)).toMatchObject({ resumed: 0 });
    // The same resume's follow-up replayed: the wake already happened.
    const held = await holdTransitionOf(sessionId);
    await holdResumeFollowUp({
      subjectType: "focus_session",
      subjectId: sessionId,
      from: "paused",
      hold: held.hold as never,
      holdTransitionId: held.id,
      reason: `What it waited on (entity:${thing}) moved to done.`,
    } as never);
    expect(h.triggers).toHaveLength(1);
    expect(await roomOf(channelId)).toHaveLength(1);
  });

  it("without `wake`, resumes and wakes nobody, as before", async () => {
    const thing = randomUUID();
    const { sessionId, channelId } = await session();
    await pauseUntilMoved(sessionId, thing);
    expect((await holdTransitionOf(sessionId)).hold).not.toHaveProperty("wake");

    expect(await moved(thing)).toMatchObject({ resumed: 1 });
    expect(await statusOf(sessionId)).toBe("active");
    expect(h.triggers).toHaveLength(0);
    expect(await roomOf(channelId)).toHaveLength(0);
  });

  it("a wake that fails leaves the resume applied and the job green", async () => {
    h.triggerAnswer = false;
    const thing = randomUUID();
    const { sessionId, channelId } = await session();
    await pauseUntilMoved(sessionId, thing, true);

    // The job does not throw (a throw would retry a move already made).
    expect(await moved(thing)).toMatchObject({ resumed: 1 });
    expect(await statusOf(sessionId)).toBe("active");
    // The wake was tried, once, and is not reported as done.
    expect(h.triggers).toHaveLength(1);
    expect(await roomOf(channelId)).toHaveLength(1);
  });
});

describe("an earlier resume follow-up that throws", () => {
  it("still wakes the agent once: the resume already happened and a retry finds nothing held", async () => {
    h.recheckThrows = true;
    const thing = randomUUID();
    const { sessionId } = await session();
    await pauseUntilMoved(sessionId, thing, true);

    // The follow-up's own error still fails the job (pg-boss retries it)...
    await expect(moved(thing)).rejects.toThrow("tool re-check failed");
    expect(await statusOf(sessionId)).toBe("active");
    // ...but the agent was woken, and the retry wakes nobody again.
    expect(h.triggers).toHaveLength(1);
    h.recheckThrows = false;
    expect(await moved(thing)).toMatchObject({ resumed: 0 });
    expect(h.triggers).toHaveLength(1);
  });
});

describe("wakeSessionHolder, the door", () => {
  const door = async () => import("../wake-session-holder.js");

  it("reports a failed wake as a failure, never as woken or empty", async () => {
    h.triggerAnswer = false;
    const { wakeSessionHolder } = await door();
    const { sessionId } = await session();
    const r = await wakeSessionHolder({
      sessionId,
      reason: "The thing it waited on moved.",
      idempotencyKey: `t:${randomUUID()}`,
    });
    expect(r.status).toBe("failed");
    expect(r).toHaveProperty("message");
    expect(await statusOf(sessionId)).toBe("active");
  });

  it("wakes nobody, and says why, for a closed session or one no agent works", async () => {
    const { wakeSessionHolder } = await door();
    const closed = await session([POD_AGENT], "closed");
    expect(
      await wakeSessionHolder({
        sessionId: closed.sessionId,
        reason: "r",
        idempotencyKey: `t:${randomUUID()}`,
      })
    ).toEqual({ status: "nobody", why: "session_not_active" });
    const unstaffed = await session([]);
    expect(
      await wakeSessionHolder({
        sessionId: unstaffed.sessionId,
        reason: "r",
        idempotencyKey: `t:${randomUUID()}`,
      })
    ).toEqual({ status: "nobody", why: "no_agent" });
    expect(
      await wakeSessionHolder({
        sessionId: randomUUID(),
        reason: "r",
        idempotencyKey: `t:${randomUUID()}`,
      })
    ).toEqual({ status: "nobody", why: "session_not_found" });
    expect(h.triggers).toHaveLength(0);
    expect(await roomOf(closed.channelId)).toHaveLength(0);
    expect(await roomOf(unstaffed.channelId)).toHaveLength(0);
  });

  it("holds a burst past the cap: three wakes per session in the window, not four", async () => {
    const { wakeSessionHolder } = await door();
    const { sessionId, channelId } = await session();
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(
        await wakeSessionHolder({
          sessionId,
          reason: `moved ${i}`,
          idempotencyKey: `burst:${sessionId}:${i}`,
        })
      );
    }
    expect(results.map((r) => r.status)).toEqual([
      "woken",
      "woken",
      "woken",
      "held",
    ]);
    expect(h.triggers).toHaveLength(3);
    expect(await roomOf(channelId)).toHaveLength(3);
  });
});
