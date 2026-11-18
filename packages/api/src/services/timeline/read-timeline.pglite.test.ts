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
 *
 * The session CHAIN (decision D3) sits where a looser read would leak: a
 * child of another person, a pod notice, a comment, a deleted and an
 * ephemeral row in the room, a post whose stamp names an agent that did not
 * write it, and a "sent" post in a room the reader cannot see.
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
import {
  readSessionTimelines,
  readTimeline,
  timelineSubjectOf,
} from "./read-timeline.js";

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
const AGENT = "agent-timeline";
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

/** A slot history row as the ask doors write it (`logEvent`, on the session). */
async function slotRow(
  sessionId: string,
  user: string,
  action: string,
  min: number,
  data: Record<string, unknown>
) {
  await q(
    `insert into events (id, type, user_id, subject_id, subject_type, data, timestamp)
     values ($1, $2, $3, $4, 'focus_session', $5::jsonb, $6)`,
    [
      randomUUID(),
      `focus_session.${action}.completed`,
      user,
      sessionId,
      JSON.stringify({ sessionId, ...data }),
      at(min),
    ]
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

  // The asks of the sibling session, as the ask doors record them.
  await q(
    `insert into users (id, email, name, user_type) values ($1, $2, 'Scout', 'agent')`,
    [AGENT, `${AGENT}@test`]
  );
  await slotRow(S.sibling, USER, "slot_asked", -9, {
    expectedLabel: "Pick the target",
    ask: { mode: "choose", options: [] },
    blockedReason: "decision",
    askedByAgentUserId: AGENT,
  });
  // "Not mine" (review a089b624 S3), as `notMineSessionSlot` writes it.
  await slotRow(S.sibling, USER, "slot_handed_back", -8, {
    expectedLabel: "Budget",
    handedBackBy: USER,
    blockedReason: "decision",
  });
  await slotRow(S.sibling, USER, "slot_answered", -7, {
    expectedLabel: "Pick the target",
    answeredBy: USER,
    handedBack: true,
    value: { type: "chip", chip: { label: "Staging" } },
  });
  await slotRow(S.sibling, USER, "question_withdrawn", -6, {
    expectedLabel: "Token",
    withdrawnBy: AGENT,
    note: "found it in the vault",
  });
  await slotRow(S.sibling, USER, "slot_attested", -5, {
    expectedLabel: "Rotate the key",
    attestedBy: USER,
  });
  await slotRow(S.sibling, USER, "relay_corrected", -4, {
    expectedLabel: "Pick the target",
  });
  // Another person's row on my session: past the events floor.
  await slotRow(S.sibling, OTHER, "slot_answered", -3, {
    expectedLabel: "Pick the target",
    answeredBy: OTHER,
  });
});

const kinds = (events: readonly DevTimelineEvent[]) =>
  events.map((e) => e.kind);

// ─── The session chain: stage moves, spawns, runners, room posts ─────────
const C = {
  parent: randomUUID(),
  child: randomUUID(),
  hiddenChild: randomUUID(),
  peer: randomUUID(),
  stranger: randomUUID(),
};
const ROOM = {
  parent: randomUUID(),
  peer: randomUUID(),
  stranger: randomUUID(),
};
const MACHINE = "machine-devbox";
const LONG = `${"word ".repeat(60)}end of the first line\nsecond line`;
const MSG = {
  person: randomUUID(),
  question: randomUUID(),
  received: randomUUID(),
  sent: randomUUID(),
};

async function room(id: string, owner: string) {
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at)
     values ($1, $2, 'session', 'room', $3, $3)`,
    [id, owner, at(-60)]
  );
}

async function message(
  id: string,
  channelId: string,
  min: number,
  m: {
    role: string;
    authorType: string;
    content: string;
    user?: string;
    agent?: string | null;
    metadata?: unknown;
    category?: string;
    deleted?: boolean;
    ephemeral?: boolean;
  }
) {
  await q(
    `insert into messages (id, channel_id, role, author_type, message_category, content, metadata, user_id, routed_teammate_id, timestamp, hash, ephemeral, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'h', $11, $12)`,
    [
      id,
      channelId,
      m.role,
      m.authorType,
      m.category ?? "chat",
      m.content,
      JSON.stringify(m.metadata ?? null),
      m.user ?? USER,
      m.agent ?? null,
      at(min),
      m.ephemeral ?? false,
      m.deleted ? at(min) : null,
    ]
  );
}

const sessionPost = (from: string, to: string, agent = AGENT) => ({
  sessionPost: {
    intent: "handoff",
    from: {
      sessionId: from,
      agentUserId: agent,
      harness: "claude-code",
      conversationId: "conv-1",
    },
    to: { sessionId: to },
    hop: 0,
    wake: true,
  },
  roomPost: { kind: "update" },
});

async function seedChain() {
  await q(
    `insert into users (id, email, name, user_type) values ($1, $2, 'devbox', 'agent')`,
    [MACHINE, `${MACHINE}@test`]
  );
  for (const id of [C.parent, C.child, C.peer]) await session(id, USER);
  await session(C.hiddenChild, OTHER);
  await session(C.stranger, OTHER);
  await room(ROOM.parent, USER);
  await room(ROOM.peer, USER);
  await room(ROOM.stranger, OTHER);
  await q(`update focus_sessions set channel_id = $2 where id = $1`, [
    C.parent,
    ROOM.parent,
  ]);
  await q(`update focus_sessions set channel_id = $2 where id = $1`, [
    C.peer,
    ROOM.peer,
  ]);
  await q(`update focus_sessions set channel_id = $2 where id = $1`, [
    C.stranger,
    ROOM.stranger,
  ]);
  // The stage ledger, as `appendSessionStageHistory` writes it.
  await q(`update focus_sessions set stage_history = $2::jsonb where id = $1`, [
    C.parent,
    JSON.stringify([
      {
        stageKey: "plan",
        fromStage: null,
        enteredAt: at(-50).toISOString(),
        actor: AGENT,
        userId: USER,
        via: "advance",
      },
      {
        stageKey: "build",
        fromStage: "plan",
        enteredAt: at(-45).toISOString(),
        actor: USER,
        userId: USER,
        via: "approval",
      },
    ]),
  ]);
  // Spawned: mine, and another person's child (past the session floor).
  for (const [child, min] of [
    [C.child, -44],
    [C.hiddenChild, -44.5],
  ] as const) {
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_by, created_at)
       values ($1, 'session', $2, 'session', $3, 'spawned_from', '{}'::jsonb, $4, $5)`,
      [randomUUID(), child, C.parent, AGENT, at(min)]
    );
  }
  await q(
    `insert into session_runners (session_id, client_key, user_id, agent_user_id, harness, conversation_id, machine_user_id, process_key, process_host, state, model, provider, first_seen_at, last_seen_at)
     values ($1, 'key:k1|conv:conv-1', $2, $3, 'claude-code', 'conv-1', $4, 'mac:1:1', 'mac.local', 'busy', 'opus', 'anthropic', $5, $6)`,
    [C.parent, USER, AGENT, MACHINE, at(-43), at(-1)]
  );
  // The room: a person's long message, an agent's question, a coordination
  // post received from the peer; then what must stay out.
  await message(MSG.person, ROOM.parent, -42, {
    role: "user",
    authorType: "human",
    content: `\n  ${LONG}`,
  });
  await message(MSG.question, ROOM.parent, -41, {
    role: "assistant",
    authorType: "ai_agent",
    agent: AGENT,
    content: "Which budget?\nThe details follow.",
    metadata: { roomPost: { kind: "question", slotLabel: "Budget" } },
  });
  await message(MSG.received, ROOM.parent, -40, {
    role: "assistant",
    authorType: "ai_agent",
    agent: AGENT,
    content: "Types landed, go on",
    metadata: sessionPost(C.peer, C.parent),
  });
  // Out: a pod notice, a comment, a deleted row, an ephemeral row.
  await message(randomUUID(), ROOM.parent, -38, {
    role: "assistant",
    authorType: "human",
    content: "Recall: related notes",
  });
  await message(randomUUID(), ROOM.parent, -37, {
    role: "user",
    authorType: "human",
    content: "a comment",
    category: "comment",
  });
  await message(randomUUID(), ROOM.parent, -36, {
    role: "user",
    authorType: "human",
    content: "deleted",
    deleted: true,
  });
  await message(randomUUID(), ROOM.parent, -35, {
    role: "user",
    authorType: "human",
    content: "typing…",
    ephemeral: true,
  });
  // Sent by the parent into the peer's room; a stamp another agent wrote;
  // a "sent" post in a room the reader cannot see.
  await message(MSG.sent, ROOM.peer, -39, {
    role: "assistant",
    authorType: "ai_agent",
    agent: AGENT,
    content: "Over to you",
    metadata: sessionPost(C.parent, C.peer),
  });
  await message(randomUUID(), ROOM.peer, -34, {
    role: "assistant",
    authorType: "ai_agent",
    agent: "agent-forger",
    content: "Forged",
    metadata: sessionPost(C.parent, C.peer),
  });
  await message(randomUUID(), ROOM.stranger, -33, {
    role: "assistant",
    authorType: "ai_agent",
    agent: AGENT,
    content: "Elsewhere",
    metadata: sessionPost(C.parent, C.stranger),
  });
}

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

  it("a key narrowed by its grant (a pod app): the sources it may not read are skipped and named, never empty", async () => {
    const t = await readTimeline(
      { kind: "session", id: S.mine },
      {
        userId: USER,
        isHubProtocol: true,
        withhold: ["dev_facts", "decisions"],
      }
    );
    const events = t!.events as DevTimelineEvent[];
    // The session's own rows only: its start and its move.
    expect(kinds(events)).toEqual(["status_moved", "session_started"]);
    expect(t).toMatchObject({ withheld: ["dev_facts", "decisions"] });
    // With an unpinned proposal read, the decisions come back.
    const withDecisions = await readTimeline(
      { kind: "session", id: S.mine },
      { userId: USER, isHubProtocol: true, withhold: ["dev_facts"] }
    );
    expect(kinds(withDecisions!.events as DevTimelineEvent[])).toEqual([
      "decision_answered",
      "status_moved",
      "session_started",
    ]);
    expect(withDecisions).toMatchObject({ withheld: ["dev_facts"] });
  });

  it("CONTROL: a whole read names nothing withheld", async () => {
    const t = await readTimeline(
      { kind: "session", id: S.mine },
      { userId: USER, isHubProtocol: true }
    );
    expect(t).not.toHaveProperty("withheld");
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

describe("the slots' history in the session timeline", () => {
  it("asked, handed back, answered, withdrawn, attested and corrected, each by who acted, under the events floor", async () => {
    const t = await readTimeline(
      { kind: "session", id: S.sibling },
      { userId: USER, isHubProtocol: true }
    );
    const events = t!.events as DevTimelineEvent[];
    expect(kinds(events)).toEqual([
      "relay_corrected",
      "slot_attested",
      "question_withdrawn",
      "slot_answered",
      "slot_handed_back",
      "slot_asked",
      "checks_finished", // its devbox job (-19)
      "session_started",
    ]);
    const asked = events.find((e) => e.kind === "slot_asked")!;
    expect(asked).toMatchObject({
      slot: "Pick the target",
      askMode: "choose",
      blockedReason: "decision",
      actor: { kind: "agent", id: AGENT, name: "Scout" },
      refs: { sessionId: S.sibling, slotLabel: "Pick the target" },
    });
    expect(events.find((e) => e.kind === "slot_answered")).toMatchObject({
      answerType: "chip",
      handedBack: true,
      relayed: false,
      actor: { kind: "human", id: USER, isViewer: true },
    });
    expect(events.find((e) => e.kind === "question_withdrawn")).toMatchObject({
      slot: "Token",
      note: "found it in the vault",
      actor: { kind: "agent", id: AGENT },
    });
    expect(events.find((e) => e.kind === "slot_attested")).toMatchObject({
      slot: "Rotate the key",
      actor: { kind: "human", id: USER },
    });
    expect(events.find((e) => e.kind === "slot_handed_back")).toMatchObject({
      slot: "Budget",
      actor: { kind: "human", id: USER, isViewer: true },
      refs: { sessionId: S.sibling, slotLabel: "Budget" },
    });
  });
});

describe("readSessionTimelines — a page of sessions in a fixed number of queries", () => {
  const reader = { userId: USER, isHubProtocol: true } as const;

  it("each session keeps its own newest events; a session past the cap says older events exist", async () => {
    const page = await readSessionTimelines(
      [S.mine, S.sibling, S.others],
      reader,
      2
    );
    // Another person's session is absent, never an empty timeline.
    expect([...page.keys()].sort()).toEqual([S.mine, S.sibling].sort());
    const sibling = page.get(S.sibling)!;
    // At most 2 rows per SOURCE: the two newest slot rows, its one job, its start.
    expect(kinds(sibling.events)).toEqual([
      "relay_corrected",
      "slot_attested",
      "checks_finished",
      "session_started",
    ]);
    expect(sibling.truncated).toBe(true);
    // Three dev facts, two kept: the PR's opening (the oldest) is past the cap.
    const mine = page.get(S.mine)!;
    expect(mine.truncated).toBe(true);
    expect(kinds(mine.events)).not.toContain("pr_opened");
  });

  it("the one-session door is the same projection, at the source cap", async () => {
    const page = await readSessionTimelines([S.mine, S.sibling], reader);
    for (const id of [S.mine, S.sibling]) {
      const door = await readTimeline({ kind: "session", id }, reader);
      expect(page.get(id)!.events).toEqual(door!.events);
      expect(page.get(id)!.truncated).toBe(false);
    }
  });

  it("reads as many times for three sessions as for one", async () => {
    const spy = vi.spyOn(h.client!, "query");
    await readSessionTimelines([S.mine], reader, 4);
    const one = spy.mock.calls.length;
    spy.mockClear();
    await readSessionTimelines([S.mine, S.sibling, S.others], reader, 4);
    const three = spy.mock.calls.length;
    spy.mockRestore();
    expect(one).toBeGreaterThan(0);
    expect(three).toBe(one);
  });
});

describe("the session chain (decision D3): stage moves, spawns, runners, room posts", () => {
  const reader = { userId: USER, isHubProtocol: true } as const;
  beforeAll(seedChain);

  it("each joins the session's chain at its time, newest first, with its door", async () => {
    const t = await readTimeline({ kind: "session", id: C.parent }, reader);
    const events = t!.events as DevTimelineEvent[];
    expect(kinds(events)).toEqual([
      "room_post", // sent to the peer (-39)
      "room_post", // received from the peer (-40)
      "room_post", // the agent's question (-41)
      "room_post", // the person's message (-42)
      "runner_seen", // -43
      "child_started", // -44; another person's child stays out
      "stage_moved", // build (-45)
      "stage_moved", // plan (-50)
      "session_started",
    ]);
    const stages = events.filter((e) => e.kind === "stage_moved");
    expect(stages[0]).toMatchObject({
      from: "plan",
      to: "build",
      via: "approval",
      at: at(-45).toISOString(),
      actor: { kind: "human", id: USER },
      refs: { sessionId: C.parent },
    });
    expect(stages[1]).toMatchObject({
      from: null,
      to: "plan",
      actor: { kind: "agent", id: AGENT },
    });
    // One entry, one id in every ledger reader (change feed, statusOf):
    // from when it was entered and which stage, never its position.
    expect(stages.map((e) => e.id)).toEqual([
      `stage:${C.parent}:${at(-45).toISOString()}:build`,
      `stage:${C.parent}:${at(-50).toISOString()}:plan`,
    ]);
    expect(events.find((e) => e.kind === "child_started")).toMatchObject({
      at: at(-44).toISOString(),
      child: { id: C.child, title: "Ship the feed", status: "active" },
      actor: { kind: "agent", id: AGENT },
      refs: { sessionId: C.child },
    });
    expect(events.find((e) => e.kind === "runner_seen")).toMatchObject({
      at: at(-43).toISOString(),
      actor: { kind: "agent", id: AGENT },
      refs: { sessionId: C.parent, runnerId: "claude-code:conv-1" },
      runner: {
        harness: "claude-code",
        conversationId: "conv-1",
        computer: "devbox",
        model: "opus",
        provider: "anthropic",
        state: "busy",
        lastSeenAt: at(-1).toISOString(),
      },
    });
  });

  it("a key narrowed by its grant: runners and room posts skipped and named; spawns and stage moves stay", async () => {
    const t = await readTimeline(
      { kind: "session", id: C.parent },
      { ...reader, withhold: ["dev_facts", "runners", "room_posts"] }
    );
    expect(kinds(t!.events as DevTimelineEvent[])).toEqual([
      "child_started",
      "stage_moved",
      "stage_moved",
      "session_started",
    ]);
    expect(t).toMatchObject({
      withheld: ["dev_facts", "runners", "room_posts"],
    });
  });

  it("room posts are one-line references: form, first line, message and room, never the body", async () => {
    const t = await readTimeline({ kind: "session", id: C.parent }, reader);
    const posts = t!.events.filter((e) => e.kind === "room_post") as Array<
      Extract<DevTimelineEvent, { kind: "room_post" }>
    >;
    expect(
      posts.map((e) => [e.refs.messageId, e.post.form, e.post.direction])
    ).toEqual([
      [MSG.sent, "session_message", "out"],
      [MSG.received, "session_message", "in"],
      [MSG.question, "question", null],
      [MSG.person, "person", null],
    ]);
    // A sent post opens the session it went to, a received one its sender.
    expect(posts[0]).toMatchObject({
      refs: { sessionId: C.peer, channelId: ROOM.peer },
      post: { intent: "handoff", line: "Over to you", truncated: false },
      actor: { kind: "agent", id: AGENT },
    });
    expect(posts[1]).toMatchObject({
      refs: { sessionId: C.peer, channelId: ROOM.parent },
      post: { intent: "handoff", line: "Types landed, go on" },
    });
    expect(posts[2]!.post).toEqual({
      form: "question",
      direction: null,
      intent: null,
      line: "Which budget?",
      truncated: true,
    });
    const person = posts[3]!;
    expect(person.actor).toMatchObject({ kind: "human", id: USER });
    expect([...person.post.line]).toHaveLength(120);
    expect(person.post.line.startsWith("word word")).toBe(true);
    expect(person.post.line.endsWith("…")).toBe(true);
    expect(person.post.truncated).toBe(true);
    // The body never rides on the wire.
    const wire = JSON.stringify(t);
    expect(wire).not.toContain("end of the first line");
    expect(wire).not.toContain("second line");
    expect(wire).not.toContain("The details follow");
    for (const out of [
      "Recall",
      "a comment",
      "deleted",
      "typing",
      "Forged",
      "Elsewhere",
    ])
      expect(wire).not.toContain(out);
  });

  it("the other session sees the same posts from its side; a stamp its writer did not sign is no mail", async () => {
    const t = await readTimeline({ kind: "session", id: C.peer }, reader);
    const posts = t!.events.filter((e) => e.kind === "room_post") as Array<
      Extract<DevTimelineEvent, { kind: "room_post" }>
    >;
    expect(
      posts.map((e) => [
        e.post.line,
        e.post.form,
        e.post.direction,
        e.refs.sessionId,
      ])
    ).toEqual([
      // In its room, written by agent-forger: an agent's post, not mail.
      ["Forged", "update", null, C.peer],
      ["Over to you", "session_message", "in", C.parent],
      ["Types landed, go on", "session_message", "out", C.parent],
    ]);
  });

  it("a page of sessions carries the chain as the one-session door does", async () => {
    const page = await readSessionTimelines([C.parent, C.peer], reader);
    for (const id of [C.parent, C.peer]) {
      const door = await readTimeline({ kind: "session", id }, reader);
      expect(page.get(id)!.events).toEqual(door!.events);
    }
    expect(kinds(page.get(C.parent)!.events)).toEqual(
      expect.arrayContaining([
        "stage_moved",
        "child_started",
        "runner_seen",
        "room_post",
      ])
    );
  });

  it("stays bounded: each chain source keeps its newest rows and says older ones exist", async () => {
    const page = await readSessionTimelines([C.parent], reader, 1);
    const chain = page.get(C.parent)!;
    expect(kinds(chain.events)).toEqual([
      "room_post", // the newest sent
      "room_post", // the newest in the room
      "runner_seen",
      "child_started",
      "stage_moved", // build: plan is past the cap
      "session_started",
    ]);
    expect(
      chain.events
        .filter((e) => e.kind === "room_post")
        .map((e) => e.refs.messageId)
    ).toEqual([MSG.sent, MSG.received]);
    expect(chain.truncated).toBe(true);
  });
});

describe("an automatic receipt's failure: answered by its agent, never by the person", () => {
  // A failed receipt names no reviewer; the timeline must still show it,
  // answered by the agent that filed it, or by the pod (`system`) when the
  // row records no agent.
  it("shows each failure with no reviewer, by its agent or the pod; an applied receipt stays out", async () => {
    const sessionId = randomUUID();
    await session(sessionId, USER);
    const receipt = (
      id: string,
      status: string,
      agent: string | null,
      reviewedMin: number
    ) =>
      q(
        `insert into proposals (id, session_id, status, agent_user_id, created_by, subject_user_id, data, created_at, reviewed_at, reviewed_by)
         values ($1, $2, $3, $4, $5, $5, '{"summary":"Capture a note"}'::jsonb, $6, $6, null)`,
        [id, sessionId, status, agent, USER, at(reviewedMin)]
      );
    const byAgent = randomUUID();
    const byPod = randomUUID();
    await receipt(byAgent, "approval_failed", AGENT, -3);
    await receipt(byPod, "approval_failed", null, -2);
    await receipt(randomUUID(), "auto_approved", AGENT, -1);

    const t = await readTimeline(
      { kind: "session", id: sessionId },
      { userId: USER, isHubProtocol: true }
    );
    const answered = t!.events.filter(
      (e) => e.kind === "decision_answered"
    ) as Array<Extract<DevTimelineEvent, { kind: "decision_answered" }>>;
    expect(answered.map((e) => e.refs.proposalId)).toEqual([byPod, byAgent]);
    expect(answered.map((e) => e.decision)).toEqual([
      "approval_failed",
      "approval_failed",
    ]);
    expect(answered[1]!.actor).toMatchObject({ kind: "agent", id: AGENT });
    expect(answered[0]!.actor).toMatchObject({ kind: "system", id: null });
    // Never the person the row is about.
    expect(
      answered.some((e) => e.actor.kind === "human" && e.actor.id === USER)
    ).toBe(false);
  });
});
