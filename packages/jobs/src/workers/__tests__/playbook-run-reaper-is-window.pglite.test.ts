/**
 * AN IS RUN IS REAPED AFTER 2 HOURS, AN EXTERNAL AGENT'S AFTER 24 (finding
 * db27cac2: outage runs stayed active for a day). A run the pod handed to its own AI reports every turn's end, failed
 * included, so a run nobody moved for 2 hours is a dead worker. An external
 * agent works on its own clock and keeps the 24-hour window (D6).
 *
 * The REAL `handlePlaybookRunReaper` against PGlite; the close door is
 * CAPTURED (its own suites cover it).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  channels,
  focusSessions,
  playbookRuns,
  messages,
  proposals,
  automationRuns,
  lifecycleTransitionOutbox,
  sessionStageRuns,
  apiKeys,
} from "@synap/database/schema";
import { handlePlaybookRunReaper } from "../playbook-run-reaper.js";
import { registerSessionCloser } from "../../utils/session-close.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const closed: string[] = [];

/**
 * A run `startedHours` ago on a session last touched `idleHours` ago. Its
 * session has its OWN room (a `focus_session` channel naming it), unless
 * `borrowedRoom`: then the channel is about another session.
 */
async function run(opts: {
  executor: "is-agent" | "external-agent";
  startedHours: number;
  idleHours: number;
  clientKey?: string;
  outputs?: unknown[];
  /** `playbook_runs.holder.kind`; omitted = no holder (a run before 0420). */
  holder?: "agent" | "synap_ai";
  metadata?: Record<string, unknown>;
  borrowedRoom?: boolean;
}): Promise<{ run: string; sess: string; room: string }> {
  const sess = randomUUID();
  const room = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, expected_outputs, started_at, updated_at, channel_id)
     values ($1, 'u1', 'g', 'active', $2::jsonb, $3::jsonb, now() - ($4::int * interval '1 hour'), now() - ($5::int * interval '1 hour'), $6)`,
    [
      sess,
      JSON.stringify({
        ...(opts.metadata ?? {}),
        ...(opts.clientKey ? { clientKey: opts.clientKey } : {}),
      }),
      JSON.stringify(opts.outputs ?? []),
      opts.startedHours,
      opts.idleHours,
      room,
    ]
  );
  await q(
    `insert into channels (id, user_id, channel_type, scope, status, context_object_type, context_object_id)
     values ($1, 'u1', 'group', 'workspace', 'active', 'focus_session', $2)`,
    [room, opts.borrowedRoom ? randomUUID() : sess]
  );
  const id = randomUUID();
  const now = new Date().toISOString();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, started_at, created_by, input, holder)
     values ($1, $2, $3, $4, 'running', now() - ($5::int * interval '1 hour'), 'u1', '{}'::jsonb, $6::jsonb)`,
    [
      id,
      randomUUID(),
      sess,
      opts.executor,
      opts.startedHours,
      opts.holder
        ? JSON.stringify({
            kind: opts.holder,
            id: opts.holder === "agent" ? "agent-1" : null,
            assignedAt: now,
            claimedAt: now,
          })
        : null,
    ]
  );
  return { run: id, sess, room };
}

/** A message in `room`, `minutesAgo` minutes ago. */
async function post(
  room: string,
  minutesAgo: number,
  opts: {
    authorType: "human" | "ai_agent" | "bot";
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const id = randomUUID();
  await q(
    `insert into messages (id, channel_id, role, author_type, message_category, content, user_id, timestamp, hash, metadata, ephemeral)
     values ($1, $2, $3, $4, 'chat', 'note', 'u1', now() - ($5::int * interval '1 minute'), $7, $6::jsonb, false)`,
    [
      id,
      room,
      opts.authorType === "human"
        ? "user"
        : opts.authorType === "bot"
          ? "system"
          : "assistant",
      opts.authorType,
      minutesAgo,
      JSON.stringify(opts.metadata ?? {}),
      `hash-${id}`,
    ]
  );
}

const sessionStatusOf = async (id: string) =>
  (
    await q<{ status: string }>(
      `select status from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.status;

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(
      `select status from playbook_runs where id = $1`,
      [id]
    )
  ).rows[0]!.status;

beforeAll(async () => {
  for (const t of [
    // A room post is activity (founder Q14): the reaper reads the room.
    channels,
    focusSessions,
    playbookRuns,
    messages,
    proposals,
    automationRuns,
    lifecycleTransitionOutbox,
    // Both windows skip a run whose step waits (0422): they read it.
    sessionStageRuns,
    apiKeys,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  registerSessionCloser(async ({ sessionId }) => {
    closed.push(sessionId);
    return {
      session: { id: sessionId, status: "closed" },
      counts: { pending: 0, unfinishedOutputs: 0, expiredEphemerals: 0 },
      warnings: [],
    };
  });
}, 120_000);

beforeEach(async () => {
  closed.length = 0;
  await h.client!.exec(
    "delete from channels; delete from focus_sessions; delete from playbook_runs; delete from messages; delete from proposals; delete from automation_runs; delete from lifecycle_transition_outbox;"
  );
});

describe("the playbook run reaper's window follows who holds the run", () => {
  it("FAILS an IS run quiet for 3 hours and closes its session", async () => {
    const quiet = await run({
      executor: "is-agent",
      startedHours: 3,
      idleHours: 3,
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(quiet.run)).toBe("failed");
    expect(closed).toEqual([quiet.sess]);
  });

  it("spares an IS run whose session moved within 2 hours, and an IS run younger than 2 hours", async () => {
    const moving = await run({
      executor: "is-agent",
      startedHours: 3,
      idleHours: 1,
    });
    const young = await run({
      executor: "is-agent",
      startedHours: 1,
      idleHours: 1,
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(moving.run)).toBe("running");
    expect(await statusOf(young.run)).toBe("running");
    expect(closed).toEqual([]);
  });

  it("an external agent's quiet run keeps its 24 hours: by executor, or by a key-client session", async () => {
    const external = await run({
      executor: "external-agent",
      startedHours: 3,
      idleHours: 3,
    });
    const keyClient = await run({
      executor: "is-agent",
      startedHours: 3,
      idleHours: 3,
      clientKey: "key:abc",
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(external.run)).toBe("running");
    expect(await statusOf(keyClient.run)).toBe("running");
    expect(closed).toEqual([]);
  });

  it("an IS run quiet for 3 hours whose session owes the person waits on them, never failed", async () => {
    const owing = await run({
      executor: "is-agent",
      startedHours: 3,
      idleHours: 3,
      outputs: [
        {
          label: "Stripe key",
          kind: "credential",
          owner: "human",
          owedSince: "2026-09-01T00:00:00.000Z",
        },
      ],
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(owing.run)).toBe("waiting_on_you");
    expect(closed).toEqual([]);
  });
});

/**
 * FINDING c573d32d, founder Q14: a wave's lane is started by an agent from
 * its lead's conversation, so its session is bound to NO client key
 * (`decideNewSessionClientKey`). The reaper read that as the pod's own AI and
 * failed the lane after 2 hours, while its agent posted in its room every
 * 20 minutes (a room post never moves `updatedAt`). Room activity is now
 * liveness, and an agent-held run with no client key goes stale, never failed.
 * A dead automation run keeps today's verdict: it carries the same
 * `startedByAgentId` stamp and no client key, but the IS holds its run.
 */
describe("agent lanes with no client key and room activity (finding c573d32d)", () => {
  it("a live agent lane (room post 30 min ago, updatedAt 3 h ago) is not failed", async () => {
    const lane = await run({
      executor: "is-agent",
      holder: "agent",
      metadata: { startedByAgentId: "agent-1" },
      startedHours: 3,
      idleHours: 3,
    });
    await post(lane.room, 30, { authorType: "ai_agent" });
    await handlePlaybookRunReaper();
    expect(await statusOf(lane.run)).toBe("running");
    expect(await sessionStatusOf(lane.sess)).toBe("active");
    expect(closed).toEqual([]);
  });

  it("a quiet agent lane with no client key keeps the 24-hour window, then goes stale with its session, never failed", async () => {
    const recent = await run({
      executor: "is-agent",
      holder: "agent",
      metadata: { startedByAgentId: "agent-1" },
      startedHours: 3,
      idleHours: 3,
    });
    const quiet = await run({
      executor: "is-agent",
      holder: "agent",
      metadata: { startedByAgentId: "agent-1" },
      startedHours: 25,
      idleHours: 25,
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(recent.run)).toBe("running");
    expect(await statusOf(quiet.run)).toBe("stale");
    expect(await sessionStatusOf(quiet.sess)).toBe("stale");
    expect(closed).toEqual([]);
  });

  it("room activity counts on both windows: an IS run and a day-old lane whose own room heard a person or an agent are spared", async () => {
    const isRun = await run({
      executor: "is-agent",
      holder: "synap_ai",
      startedHours: 3,
      idleHours: 3,
    });
    await post(isRun.room, 30, { authorType: "ai_agent" });
    const dayOldLane = await run({
      executor: "is-agent",
      holder: "agent",
      startedHours: 25,
      idleHours: 25,
    });
    await post(dayOldLane.room, 30, { authorType: "human" });
    await handlePlaybookRunReaper();
    expect(await statusOf(isRun.run)).toBe("running");
    expect(await statusOf(dayOldLane.run)).toBe("running");
    expect(await sessionStatusOf(dayOldLane.sess)).toBe("active");
    expect(closed).toEqual([]);
  });

  it("a dead automation run is still failed: its stamp, a pod notice, another session's post and a borrowed room keep nothing alive", async () => {
    const automation = await run({
      executor: "is-agent",
      holder: "synap_ai",
      // What an automation's playbook run session carries: the automation's
      // agent stamp, no client key.
      metadata: { startedByAgentId: "agent-1", automationRunId: randomUUID() },
      startedHours: 3,
      idleHours: 3,
    });
    // The pod's own notice and a coordination post from another session,
    // both 30 minutes ago in its own room.
    await post(automation.room, 30, { authorType: "bot" });
    await post(automation.room, 30, {
      authorType: "ai_agent",
      metadata: {
        sessionPost: {
          intent: "fyi",
          from: { sessionId: randomUUID(), agentUserId: "agent-2" },
          to: { sessionId: automation.sess },
          hop: 0,
          wake: false,
        },
      },
    });
    // An agent post 30 minutes ago in a channel that is another session's room.
    const borrowed = await run({
      executor: "is-agent",
      holder: "synap_ai",
      startedHours: 3,
      idleHours: 3,
      borrowedRoom: true,
    });
    await post(borrowed.room, 30, { authorType: "ai_agent" });
    // A post older than the window.
    const old = await run({
      executor: "is-agent",
      holder: "synap_ai",
      startedHours: 3,
      idleHours: 3,
    });
    await post(old.room, 150, { authorType: "ai_agent" });
    await handlePlaybookRunReaper();
    expect(await statusOf(automation.run)).toBe("failed");
    expect(await statusOf(borrowed.run)).toBe("failed");
    expect(await statusOf(old.run)).toBe("failed");
    expect([...closed].sort()).toEqual(
      [automation.sess, borrowed.sess, old.sess].sort()
    );
  });
});
