/**
 * The timeline read on PGlite — the REAL `readTimeline` over a session and a
 * pull request: the transition log, the dev facts under the event floor, the
 * proposals of the session, the actors named in one read. Every table is
 * generated from the Drizzle definitions.
 *
 * Fixture rows sit where the candidate rules DISAGREE:
 *   - a BACKDATED pause recorded after a later fact — ordering by record time
 *     puts it first; the timeline orders by when it happened, and says
 *     `recordedAt`;
 *   - a CI run of the session's PR that names no session (only its `pr`) —
 *     a read that follows `data.sessionId` alone misses it;
 *   - a devbox job that names the session and no PR — a read that follows
 *     the PR alone misses it;
 *   - another session's job, and another person's fact on the same PR — a
 *     read without the session rule or the event floor shows them;
 *   - a CI run on the PR's head sha that names no PR — the PR timeline's
 *     head rule finds it; a run on another sha stays out;
 *   - another person's session — read as missing, never as empty.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client);
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

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { DevTimelineEvent } from "@synap-core/types/units";
import { readTimeline, timelineSubjectOf } from "./read-timeline.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const USER = "user-timeline";
const OTHER = "user-other";
const BE = "Synap-core/backend";
const S = { mine: randomUUID(), sibling: randomUUID(), others: randomUUID() };
const PROPOSAL = randomUUID();
const NOW = Date.now();
const at = (min: number) => new Date(NOW + min * 60_000);
const HEAD = "c".repeat(40);

async function session(id: string, user: string, outputs: unknown = []) {
  await q(
    `insert into focus_sessions (id, user_id, title, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
     values ($1, $2, 'Ship the feed', 'g', 'active', 'user', $3::jsonb, '{}'::jsonb, $4, $4, $4)`,
    [id, user, JSON.stringify(outputs), at(-60)]
  );
}

async function devFact(
  user: string,
  type: string,
  min: number,
  data: Record<string, unknown>
) {
  await q(
    `insert into events (id, type, user_id, subject_id, subject_type, data, timestamp)
     values ($1, $2, $3, $4, 'observation', $5::jsonb, $6)`,
    [randomUUID(), type, user, randomUUID(), JSON.stringify(data), at(min)]
  );
}

async function move(
  sessionId: string,
  t: { from: string; to: string; category: string; occurred: number },
  recorded: number,
  hold: unknown = null
) {
  const id = randomUUID();
  await q(
    `insert into lifecycle_transition_outbox (transition_id, transition, created_at)
     values ($1, $2::jsonb, $3)`,
    [
      id,
      JSON.stringify({
        transitionId: id,
        subjectType: "focus_session",
        subjectId: sessionId,
        property: "status",
        from: t.from,
        to: t.to,
        category: t.category,
        actorKind: "human",
        userId: USER,
        agentUserId: null,
        reason: "waiting on the types PR",
        occurredAt: at(t.occurred).toISOString(),
        recordedAt: at(recorded).toISOString(),
        backdated: t.occurred < recorded,
        hold,
      }),
      at(recorded),
    ]
  );
  return id;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => is(v, PgTable)
  );
  const names = tables.map((t) => getTableConfig(t).name);
  expect(names).toEqual(
    expect.arrayContaining([
      "events",
      "focus_sessions",
      "lifecycle_transition_outbox",
      "proposals",
      "users",
    ])
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));
  await q(
    `insert into users (id, email, name, user_type) values ($1, $2, 'Antoine', 'human')`,
    [USER, `${USER}@test`]
  );

  await session(S.mine, USER, [
    {
      key: "pr-backend-47",
      kind: "pull_request",
      label: "backend#47",
      ref: { url: `https://github.com/${BE}/pull/47` },
    },
  ]);
  await session(S.sibling, USER);
  await session(S.others, OTHER);

  const pr = { repo: BE, number: 47, url: `https://github.com/${BE}/pull/47` };
  await devFact(USER, "dev.pr_opened", -50, {
    ...pr,
    sha: HEAD,
    title: "feat: the feed",
  });
  // The session's PR, its run naming no session; heard 5 min late.
  await devFact(USER, "ci.finished", -30, {
    repo: BE,
    sha: HEAD,
    pr: 47,
    status: "failure",
    workflow: "CI",
    ingestedAt: at(-25).toISOString(),
  });
  // A devbox job of this session, tied to no PR; another session's job.
  await devFact(USER, "ci.finished", -20, {
    repo: BE,
    sha: "d".repeat(40),
    status: "success",
    workflow: "devbox dev-feed-h",
    sessionId: S.mine,
  });
  await devFact(USER, "ci.finished", -19, {
    repo: BE,
    sha: "d".repeat(40),
    status: "success",
    workflow: "devbox other-h",
    sessionId: S.sibling,
  });
  // A run on the PR's head that names no PR; a run on another sha.
  await devFact(USER, "ci.finished", -15, {
    repo: BE,
    sha: HEAD.slice(0, 7),
    status: "success",
    workflow: "devbox gate",
  });
  await devFact(USER, "ci.finished", -14, {
    repo: BE,
    sha: "e".repeat(40),
    status: "success",
    workflow: "CI",
  });
  // Another person's merge of the same PR: past the event floor.
  await devFact(OTHER, "dev.pr_merged", -10, { ...pr, intoDefault: true });

  // A pause recorded NOW, backdated to before the CI run.
  await move(
    S.mine,
    { from: "active", to: "paused", category: "paused", occurred: -40 },
    -1,
    {
      on: "thing",
      ref: null,
      reason: "the types PR lands first",
      until: { moves: "pr:synap-core/backend#9200" },
      reviewBy: null,
      resumeTo: "active",
      since: at(-40).toISOString(),
    }
  );
  await q(
    `insert into proposals (id, session_id, status, data, created_at, reviewed_at, reviewed_by, rejection_reason)
     values ($1, $2, 'rejected', '{"_summary":"Close the session"}'::jsonb, $3, $4, $5, 'not yet')`,
    [PROPOSAL, S.mine, at(-12), at(-8), USER]
  );
});

const kinds = (events: readonly DevTimelineEvent[]) =>
  events.map((e) => e.kind);

describe("timelineSubjectOf — one subject per call", () => {
  it("refuses none, two, or a malformed one", () => {
    expect(timelineSubjectOf({}).ok).toBe(false);
    expect(timelineSubjectOf({ sessionId: S.mine, pr: `${BE}#47` }).ok).toBe(
      false
    );
    expect(timelineSubjectOf({ sessionId: "c04bca72" }).ok).toBe(false);
    expect(timelineSubjectOf({ pr: "backend#47" }).ok).toBe(false);
    expect(timelineSubjectOf({ pr: `${BE}#47` })).toEqual({
      ok: true,
      subject: { kind: "pull_request", ref: { repo: BE, number: 47 } },
    });
  });
});

describe("readTimeline on PGlite", () => {
  it("a session: its start, its moves at their OCCURRED time, its PR's and its job's facts, its decisions", async () => {
    const t = await readTimeline(
      { kind: "session", id: S.mine },
      { userId: USER, isHubProtocol: true }
    );
    expect(t?.subject).toEqual({
      kind: "session",
      id: S.mine,
      title: "Ship the feed",
    });
    const events = t!.events as DevTimelineEvent[];
    expect(kinds(events)).toEqual([
      "decision_answered", // reviewed at -8
      "checks_finished", // the devbox job (-20)
      "checks_finished", // the PR's run (-30)
      "status_moved", // backdated to -40, recorded at -1
      "pr_opened",
      "session_started",
    ]);
    const pause = events.find((e) => e.kind === "status_moved")!;
    expect(pause).toMatchObject({
      at: at(-40).toISOString(),
      recordedAt: at(-1).toISOString(),
      actor: { kind: "human", id: USER, isViewer: true },
      hold: { on: "thing", until: { moves: "pr:synap-core/backend#9200" } },
    });
    const runs = events.filter((e) => e.kind === "checks_finished");
    expect(runs.map((e) => e.kind === "checks_finished" && e.checks)).toEqual([
      expect.objectContaining({
        job: "dev-feed-h",
        pr: null,
        result: "passed",
      }),
      expect.objectContaining({ job: null, pr: 47, result: "failed" }),
    ]);
    // Heard 5 min after it happened: said so.
    expect(runs[1]).toMatchObject({
      at: at(-30).toISOString(),
      recordedAt: at(-25).toISOString(),
    });
    // A fact recorded on time carries no recordedAt.
    expect(runs[0]).not.toHaveProperty("recordedAt");
    expect(events[0]).toMatchObject({
      decision: "rejected",
      note: "not yet",
      title: "Close the session",
      refs: { sessionId: S.mine, proposalId: PROPOSAL },
    });
    expect(t!.truncated).toBe(false);
  });

  it("another person's session is missing, not empty", async () => {
    expect(
      await readTimeline(
        { kind: "session", id: S.others },
        { userId: USER, isHubProtocol: true }
      )
    ).toBeNull();
  });

  it("a pull request: its facts and the runs on its head, never another person's", async () => {
    const t = await readTimeline(
      { kind: "pull_request", ref: { repo: "synap-core/BACKEND", number: 47 } },
      { userId: USER, isHubProtocol: true }
    );
    expect(t?.subject).toMatchObject({ kind: "pull_request", number: 47 });
    const events = t!.events as DevTimelineEvent[];
    expect(kinds(events)).toEqual([
      "checks_finished", // the head-sha run naming no PR (-15)
      "checks_finished", // the PR's run (-30)
      "pr_opened",
    ]);
    expect(events.some((e) => e.kind === "pr_merged")).toBe(false);
  });
});
