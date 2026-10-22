/**
 * The packet sections an external reader (the synap-bridge terminal band)
 * needs in ONE call — `room`, `live`, `gates` and each output's `noun`/`glyph`
 * — driven through the REAL `projectContinuationPacket` on PGlite.
 *
 * Every table of the schema is created (columns only), so every read inside the
 * builder runs its real query: `queryChannelMessages` behind the channel gate,
 * `loadSessionLiveness`, `loadSessionProcess` + `resolveStageGate`, and
 * `listSessionOutputs`. Nothing about the packet is hand-built.
 *
 * Discriminating rows (each would pass under a plausible WRONG rule):
 *  - room: an `ai_agent` row with `role: user` and the OWNER's userId (role-only
 *    and userId-only rules call it the person), a recall notice
 *    `assistant` + `human` + owner (authorType-only calls it the person), and a
 *    `human` row from ANOTHER user (every column-only rule calls it the person).
 *  - gates: the newest deploy row is `auto_approved` with the owner as
 *    reviewer, the one before it `approved` by an AGENT user — both newer than
 *    the human-approved commit, so "newest approved", "status = approved" and
 *    "reviewer is set" each name the wrong commit. A pending `playbook.stage_gate`
 *    for a stage that does not exist is newer than the real one (a rule that
 *    ignores `stageKey` reads it), and a human-approved deploy for ANOTHER
 *    session exists (a rule that ignores the target reads it).
 *  - failures: each section's own table is renamed away, so the real read
 *    fails and the section must say `unavailable` — never `[]` / `null`.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
        state.db = drizzle(client, { schema });
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
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db, focusSessions, eq } from "@synap/database";
import { projectContinuationPacket } from "../continuation-packet.js";
import { ROOM_TEXT_CAP } from "../room-messages.js";

const OWNER = "user-owner";
const OTHER = "user-other"; // another person, with no access to OWNER's rooms
const AGENT = "user-agent"; // an agent principal (userType agent)

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

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const S = {
  room: randomUUID(), // a room with every kind of author
  busy: randomUUID(), // a room past the cap
  gated: randomUUID(), // a playbook with every gate kind
  rejected: randomUUID(), // same playbook, review gate rejected
  plain: randomUUID(), // no playbook, no room
  idle: randomUUID(), // an agent spoke 10 minutes ago
};
const CH = {
  room: randomUUID(),
  busy: randomUUID(),
  gated: randomUUID(),
  idle: randomUUID(),
};
const PLAYBOOK = randomUUID();
const ENTITY_DECISION = randomUUID();
const ROW = {
  person: randomUUID(),
  agent: randomUUID(),
  recall: randomUUID(),
  teammate: randomUUID(),
  external: randomUUID(),
  bot: randomUUID(),
  deleted: randomUUID(),
  ephemeral: randomUUID(),
};
const P = {
  plan: randomUUID(),
  review: randomUUID(),
  deployHuman: randomUUID(),
  deployAgent: randomUUID(),
  deployAuto: randomUUID(),
  rejectedReview: randomUUID(),
  phantomStage: randomUUID(),
  otherSessionDeploy: randomUUID(),
};

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function session(
  id: string,
  opts: {
    channelId?: string | null;
    playbookId?: string | null;
    currentStage?: string | null;
    expectedOutputs?: unknown[];
  } = {}
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, title, goal, status, expected_outputs, metadata, origin, channel_id, playbook_id, current_stage, created_at, updated_at, started_at)
     values ($1, $2, null, null, $3, $4, 'active', $5::jsonb, '{}'::jsonb, 'human', $6, $7, $8, now(), now(), now())`,
    [
      id,
      OWNER,
      `Session ${id.slice(0, 4)}`,
      "Ship it",
      JSON.stringify(opts.expectedOutputs ?? []),
      opts.channelId ?? null,
      opts.playbookId ?? null,
      opts.currentStage ?? null,
    ]
  );
}

async function channel(id: string) {
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, created_at, updated_at)
     values ($1, $2, null, 'ai_thread', now(), now())`,
    [id, OWNER]
  );
}

async function message(
  id: string,
  channelId: string,
  m: {
    role: string;
    authorType: string;
    userId: string;
    content: string;
    at: Date;
    routedTeammateId?: string;
    deleted?: boolean;
    ephemeral?: boolean;
  }
) {
  await q(
    `insert into messages (id, channel_id, role, author_type, user_id, content, timestamp, routed_teammate_id, deleted_at, ephemeral, hash, previous_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'h', '')`,
    [
      id,
      channelId,
      m.role,
      m.authorType,
      m.userId,
      m.content,
      m.at.toISOString(),
      m.routedTeammateId ?? null,
      m.deleted ? new Date().toISOString() : null,
      m.ephemeral ?? false,
    ]
  );
}

async function proposal(
  id: string,
  p: {
    sessionId: string;
    type: string;
    status: string;
    data: Record<string, unknown>;
    reviewedBy?: string | null;
    createdAt: Date;
  }
) {
  await q(
    `insert into proposals (id, target_type, target_id, proposal_type, data, status, session_id, created_by, reviewed_by, reviewed_at, created_at, updated_at)
     values ($1, 'focus_session', $2, $3, $4::jsonb, $5, $10, $6, $7, $8, $9, $9)`,
    [
      id,
      p.sessionId,
      p.type,
      JSON.stringify(p.data),
      p.status,
      OWNER,
      p.reviewedBy ?? null,
      p.status === "pending" ? null : p.createdAt.toISOString(),
      p.createdAt.toISOString(),
      p.sessionId,
    ]
  );
}

async function packetFor(id: string, viewer = OWNER) {
  const [row] = await db
    .select()
    .from(focusSessions)
    .where(eq(focusSessions.id, id));
  return projectContinuationPacket(row!, { database: db, userId: viewer });
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, user_type) values ($1, 'human'), ($2, 'human'), ($3, 'agent')`,
    [OWNER, OTHER, AGENT]
  );

  // ── room ────────────────────────────────────────────────────────────────
  await channel(CH.room);
  await session(S.room, { channelId: CH.room });
  const roomRows: Array<[string, Parameters<typeof message>[2]]> = [
    [
      ROW.person,
      {
        role: "user",
        authorType: "human",
        userId: OWNER,
        content: "Use Stripe.",
        at: minutesAgo(70),
      },
    ],
    [
      ROW.agent,
      {
        role: "user",
        authorType: "ai_agent",
        userId: OWNER,
        content: "Drafted the keys page.",
        at: minutesAgo(69),
        routedTeammateId: AGENT,
      },
    ],
    [
      ROW.recall,
      {
        role: "assistant",
        authorType: "human",
        userId: OWNER,
        content: "Found 3 things you captured.",
        at: minutesAgo(68),
      },
    ],
    [
      ROW.teammate,
      {
        role: "user",
        authorType: "human",
        userId: OTHER,
        content: "Looks good to me.",
        at: minutesAgo(67),
      },
    ],
    [
      ROW.external,
      {
        role: "user",
        authorType: "external",
        userId: OWNER,
        content: "From WhatsApp.",
        at: minutesAgo(66),
      },
    ],
    [
      ROW.bot,
      {
        role: "system",
        authorType: "bot",
        userId: OWNER,
        content: "Session started.",
        at: minutesAgo(65),
      },
    ],
    [
      ROW.deleted,
      {
        role: "user",
        authorType: "human",
        userId: OWNER,
        content: "gone",
        at: minutesAgo(64),
        deleted: true,
      },
    ],
    [
      ROW.ephemeral,
      {
        role: "assistant",
        authorType: "ai_agent",
        userId: OWNER,
        content: "recap",
        at: minutesAgo(63),
        ephemeral: true,
      },
    ],
  ];
  for (const [id, m] of roomRows) await message(id, CH.room, m);

  await channel(CH.busy);
  await session(S.busy, { channelId: CH.busy });
  for (let i = 0; i < 10; i++) {
    await message(randomUUID(), CH.busy, {
      role: "user",
      authorType: "human",
      userId: OWNER,
      content: i === 9 ? "x".repeat(ROOM_TEXT_CAP + 50) : `message ${i}`,
      at: minutesAgo(100 - i),
    });
  }

  // ── gates ───────────────────────────────────────────────────────────────
  await q(
    `insert into playbooks (id, created_by, name, goal_template, stages, created_at, updated_at) values ($1, $2, 'Dev loop', 'Ship', $3::jsonb, now(), now())`,
    [
      PLAYBOOK,
      OWNER,
      JSON.stringify([
        {
          key: "plan",
          name: "Plan",
          gate: { kind: "awaits", proposalType: "dev.plan_approval" },
        },
        { key: "build", name: "Build" },
        { key: "review", name: "Review", gate: { kind: "human" } },
        { key: "verify", name: "Verify", gate: { kind: "check" } },
        {
          key: "ship",
          name: "Ship",
          gate: { kind: "awaits", proposalType: "dev.deploy_approval" },
        },
        { key: "done", name: "Done" },
      ]),
    ]
  );
  await channel(CH.gated);
  await session(S.gated, {
    channelId: CH.gated,
    playbookId: PLAYBOOK,
    currentStage: "ship",
    expectedOutputs: [
      { label: "Pick the provider", kind: "decision", owner: "human" },
      { label: "Write the handler", kind: "task" },
    ],
  });
  await session(S.rejected, { playbookId: PLAYBOOK, currentStage: "review" });
  await session(S.plain);

  const deploy = (sha: string) => ({
    sessionId: S.gated,
    repo: "synap-backend",
    branch: "feat/x",
    commitSha: sha,
    gateReport: { passed: true },
    targetHost: "pod-prod",
    deployCommand: "deploy",
  });
  await proposal(P.plan, {
    sessionId: S.gated,
    type: "dev.plan_approval",
    status: "approved",
    reviewedBy: OWNER,
    data: { sessionId: S.gated, repo: "synap-backend", branch: "feat/x" },
    createdAt: minutesAgo(50),
  });
  await proposal(P.review, {
    sessionId: S.gated,
    type: "playbook.stage_gate",
    status: "pending",
    data: { sessionId: S.gated, stageKey: "review", stageName: "Review" },
    createdAt: minutesAgo(40),
  });
  await proposal(P.deployHuman, {
    sessionId: S.gated,
    type: "dev.deploy_approval",
    status: "approved",
    reviewedBy: OWNER,
    data: deploy("aaaaaaa1"),
    createdAt: minutesAgo(30),
  });
  await proposal(P.deployAgent, {
    sessionId: S.gated,
    type: "dev.deploy_approval",
    status: "approved",
    reviewedBy: AGENT,
    data: deploy("bbbbbbb2"),
    createdAt: minutesAgo(20),
  });
  await proposal(P.deployAuto, {
    sessionId: S.gated,
    type: "dev.deploy_approval",
    status: "auto_approved",
    reviewedBy: OWNER,
    data: deploy("ccccccc3"),
    createdAt: minutesAgo(10),
  });
  await proposal(P.rejectedReview, {
    sessionId: S.rejected,
    type: "playbook.stage_gate",
    status: "rejected",
    reviewedBy: OWNER,
    data: { sessionId: S.rejected, stageKey: "review", stageName: "Review" },
    createdAt: minutesAgo(30),
  });
  await proposal(P.phantomStage, {
    sessionId: S.rejected,
    type: "playbook.stage_gate",
    status: "pending",
    data: { sessionId: S.rejected, stageKey: "not-a-stage", stageName: "X" },
    createdAt: minutesAgo(5),
  });
  await proposal(P.otherSessionDeploy, {
    sessionId: S.plain,
    type: "dev.deploy_approval",
    status: "approved",
    reviewedBy: OWNER,
    data: { ...deploy("ddddddd4"), sessionId: S.plain },
    createdAt: minutesAgo(5),
  });

  // ── outputs (identity) ─────────────────────────────────────────────────
  await q(
    `insert into entities (id, user_id, type, title, created_at, updated_at) values ($1, $2, 'decision', 'Use Stripe', now(), now())`,
    [ENTITY_DECISION, OWNER]
  );
  await q(
    `insert into artifacts (id, session_id, user_id, kind, ref_id, title, origin_kind, state, props, created_at)
     values ($1, $2, $3, 'entity', $4, 'Use Stripe', 'agent', 'kept', '{}'::jsonb, now())`,
    [randomUUID(), S.gated, OWNER, ENTITY_DECISION]
  );

  // ── live ────────────────────────────────────────────────────────────────
  await q(
    `insert into chat_turns (id, channel_id, user_id, request_id, user_message_id, assistant_message_id, status, started_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, 'running', $7, $7)`,
    [
      randomUUID(),
      CH.gated,
      OWNER,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      minutesAgo(2).toISOString(),
    ]
  );
  await channel(CH.idle);
  await session(S.idle, { channelId: CH.idle });
  await message(randomUUID(), CH.idle, {
    role: "assistant",
    authorType: "ai_agent",
    userId: OWNER,
    content: "Done for now.",
    at: minutesAgo(10),
  });
});

describe("continuation packet — room", () => {
  it("classifies every author once, newest first, skipping deleted and ephemeral rows", async () => {
    const { room } = await packetFor(S.room);
    expect(room.status).toBe("ok");
    if (room.status !== "ok") return;
    expect(room.channelId).toBe(CH.room);
    expect(room.items.map((m) => [m.id, m.author, m.isPerson])).toEqual([
      [ROW.bot, "system", false],
      [ROW.external, "teammate", false],
      [ROW.teammate, "teammate", false],
      [ROW.recall, "system", false],
      [ROW.agent, "agent", false],
      [ROW.person, "person", true],
    ]);
    expect(room.items.find((m) => m.id === ROW.agent)?.agentUserId).toBe(AGENT);
    expect(room.hasMore).toBe(false);
    expect(room.cursor).toBe(ROW.bot);
  });

  it("caps at 8 with hasMore, and caps long text", async () => {
    const { room } = await packetFor(S.busy);
    if (room.status !== "ok") throw new Error("room unavailable");
    expect(room.items).toHaveLength(8);
    expect(room.hasMore).toBe(true);
    expect(room.cursor).toBe(room.items[0]!.id);
    expect(room.items[0]!.truncated).toBe(true);
    expect(room.items[0]!.text).toHaveLength(ROOM_TEXT_CAP);
    expect(room.items[1]!.truncated).toBe(false);
  });

  it("a session with no room is an empty ok, not unavailable", async () => {
    const { room } = await packetFor(S.plain);
    expect(room).toEqual({
      status: "ok",
      channelId: null,
      items: [],
      hasMore: false,
      cursor: null,
    });
  });

  it("a viewer who cannot see the room gets unavailable, never an empty room", async () => {
    const { room } = await packetFor(S.room, OTHER);
    expect(room.status).toBe("unavailable");
  });
});

describe("continuation packet — live", () => {
  it("a running turn reads working, since the turn started", async () => {
    const { live } = await packetFor(S.gated);
    expect(live).toMatchObject({
      status: "ok",
      state: "working",
      turnInFlight: true,
      windowMs: 5 * 60_000,
    });
    if (live.status !== "ok") return;
    expect(Date.parse(live.since!)).toBeLessThan(Date.now() - 60_000);
  });

  it("activity older than the window reads idle, since the last activity", async () => {
    const { live } = await packetFor(S.idle);
    expect(live).toMatchObject({
      status: "ok",
      state: "idle",
      turnInFlight: false,
    });
    if (live.status !== "ok") return;
    expect(live.since).toBe(live.lastActivityAt);
    expect(live.lastActivityAt).not.toBeNull();
  });
});

describe("continuation packet — gates", () => {
  it("lists every gated stage in order, its state from proposal rows only", async () => {
    const { gates } = await packetFor(S.gated);
    if (gates.status !== "ok") throw new Error("gates unavailable");
    expect(
      gates.items.map((g) => [g.stageKey, g.kind, g.state, g.decidedByHuman])
    ).toEqual([
      ["plan", "awaits", "approved", true],
      ["review", "human", "pending", false],
      ["verify", "check", "by_criteria", false],
      // The NEWEST deploy row decides the gate — auto-approved, not a person.
      ["ship", "awaits", "approved", false],
    ]);
    const ship = gates.items.find((g) => g.stageKey === "ship")!;
    expect(ship).toMatchObject({
      proposalId: P.deployAuto,
      commitSha: "ccccccc3",
    });
    expect(gates.items.find((g) => g.stageKey === "plan")).toMatchObject({
      proposalId: P.plan,
      decidedAt: expect.any(String),
    });
  });

  it("deploy names ONLY the commit a person approved — not the agent's, not the auto-approval", async () => {
    const { gates } = await packetFor(S.gated);
    if (gates.status !== "ok") throw new Error("gates unavailable");
    expect(gates.deploy).toEqual({
      proposalId: P.deployHuman,
      commitSha: "aaaaaaa1",
      branch: "feat/x",
      repo: "synap-backend",
      targetHost: "pod-prod",
      approvedAt: expect.any(String),
    });
  });

  it("a human rejection reads rejected; another stage's and another session's rows do not leak in", async () => {
    const { gates } = await packetFor(S.rejected);
    if (gates.status !== "ok") throw new Error("gates unavailable");
    expect(gates.items.find((g) => g.stageKey === "review")).toMatchObject({
      state: "rejected",
      decidedByHuman: true,
      proposalId: P.rejectedReview,
    });
    expect(gates.items.find((g) => g.stageKey === "plan")).toMatchObject({
      state: "not_reached",
      decidedByHuman: false,
    });
    expect(gates.deploy).toBeNull();
  });

  it("a session with no process has no gates (ok, not unavailable)", async () => {
    const { gates } = await packetFor(S.plain);
    expect(gates).toMatchObject({ status: "ok", items: [] });
  });
});

describe("continuation packet — kind identity", () => {
  it("outputs and slot items carry the vocabulary's noun and glyph", async () => {
    const packet = await packetFor(S.gated);
    if (packet.outputs.status !== "ok") throw new Error("outputs unavailable");
    expect(packet.outputs.items).toContainEqual(
      expect.objectContaining({
        kind: "entity",
        refId: ENTITY_DECISION,
        noun: "Decision",
        glyph: "◇",
      })
    );
    if (packet.userMustDecide.owedSlots.status !== "ok") throw new Error();
    expect(packet.userMustDecide.owedSlots.items[0]).toMatchObject({
      kind: "decision",
      noun: "Decision",
      glyph: "◇",
    });
    if (packet.aiCanDo.status !== "ok") throw new Error();
    expect(packet.aiCanDo.items[0]).toMatchObject({
      kind: "task",
      noun: "Task",
      glyph: "☐",
    });
  });
});

describe("continuation packet — a failed read is unavailable, never empty", () => {
  async function withTableGone<T>(table: string, run: () => Promise<T>) {
    await h.client!.exec(`alter table ${table} rename to ${table}_gone;`);
    try {
      return await run();
    } finally {
      await h.client!.exec(`alter table ${table}_gone rename to ${table};`);
    }
  }

  it("room: its messages read failing", async () => {
    const packet = await withTableGone("messages", () => packetFor(S.gated));
    expect(packet.room).toEqual({
      status: "unavailable",
      reason: expect.any(String),
    });
    expect(packet.gates.status).toBe("ok");
  });

  it("live: its turns read failing, while the room still answers", async () => {
    const packet = await withTableGone("chat_turns", () => packetFor(S.gated));
    expect(packet.live).toEqual({
      status: "unavailable",
      reason: expect.any(String),
    });
    expect(packet.room.status).toBe("ok");
    expect(packet.gates.status).toBe("ok");
  });

  it("gates: the process read failing, while room and live still answer", async () => {
    const packet = await withTableGone("playbook_runs", () =>
      packetFor(S.gated)
    );
    expect(packet.gates).toEqual({
      status: "unavailable",
      reason: expect.any(String),
    });
    expect(packet.room.status).toBe("ok");
    expect(packet.live.status).toBe("ok");
  });
});
