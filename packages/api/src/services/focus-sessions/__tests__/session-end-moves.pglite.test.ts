/**
 * A SESSION'S END MOVES THE THINGS IT WORKED ON (`subjectProfile.onEnd`) —
 * through the REAL close door (`completeFocusSession`), the REAL process
 * reader (`loadSessionProcess`), the REAL status door (`moveStatus`: its
 * compare-and-set, the lifecycle governance floor through the real
 * `checkPermissionOrPropose` and the pod default row 0282, the transition it
 * owes) and the REAL target stamp, all on one PGlite.
 *
 * Each row rules something out:
 *  - closed / cancelled / failed each move the subject to THEIR value (a
 *    close door that applied one value for every end, or none, fails);
 *  - no `onEnd` moves nothing;
 *  - the process's own `humanOnlyStatuses` force a proposal even for a move
 *    an agent may otherwise make (the forcePropose plumbing);
 *  - a lifecycle humanOnly option by an AGENT's close is a proposal; the
 *    same move by a PERSON's close applies;
 *  - an agent's END move into done APPLIES: the session's end is the
 *    guardrail, so the done/lost default floor of a stage move does not apply
 *    (founder, 2026-11-05; governance `lifecycleMove.atSessionEnd`);
 *  - a subject already at the value is left alone (no second transition);
 *  - a subject or target already in a done or lost status is NEVER moved out
 *    of it, by a person's close or an agent's (`already_settled`, finding
 *    8f1c774f): an end move that skipped the done/lost floor reopened it;
 *  - a ROLE process moves the role's facet, not the entity;
 *  - a target still open at the close moves; one the session already
 *    settled does not;
 *  - the transition names the session;
 *  - the FROZEN run snapshot decides, not a later edit of the playbook (the
 *    process is read before the close settles the run).
 *
 * Stubbed, and why: the close door's OWN gate (`focus_session` — not under
 * test; every other subject goes to the real gate), post-commit delivery
 * (events, realtime, notifications), `getAgentFocusProjectId` (PGlite is one
 * connection). PGlite is ONE connection: a transaction runs on the same handle
 * (atomicity is not under test, as status-move-grant.pglite.test.ts).
 *
 * NOT COVERED: the approval replay of a proposed end move (the
 * entity-transition executor's suite) and `stale` (never reaches this door).
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
// The close door's own gate is not under test; every other subject (the end
// moves' `entity.transition`) reaches the REAL gate.
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
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { pgliteAllTablesDdl } from "../../../__tests__/pglite-ddl.js";
import { completeFocusSession } from "../complete-session.js";

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
const FINDING = randomUUID();
const PERSON = randomUUID();
const LEAD = randomUUID();
const STATUS_DEF = randomUUID();
const STAGE_DEF = randomUUID();

type OnEnd = Partial<Record<"closed" | "cancelled" | "failed", string>>;

async function seedFinding(status: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, status, status_category, properties, created_at, updated_at)
     values ($1, $2, 'finding', $3, 'A finding', null, $4, 'open', $5::jsonb, now(), now())`,
    [id, USER, FINDING, status, JSON.stringify({ status })]
  );
  return id;
}

/** A playbook whose process works on `profileSlug`, with `onEnd`. */
async function seedPlaybook(subjectProfile: Record<string, unknown>) {
  const id = randomUUID();
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, subject_profile, version, status, created_at, updated_at)
     values ($1, null, $2, 'Fix a finding', 'Fix it', 'is-agent',
             '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $3::jsonb, 1, 'active', now(), now())`,
    [id, USER, JSON.stringify(subjectProfile)]
  );
  return id;
}

/**
 * A live session following the playbook, with its LIVE run whose frozen
 * snapshot holds `snapshotProfile` (default: the playbook's own).
 */
async function seedSession(opts: {
  playbookId: string;
  subjectEntityId: string | null;
  snapshotProfile: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, playbook_id, subject_entity_id, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Fix it', 'Fix the finding', 'active', 'playbook', $3, $4,
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
    [id, USER, opts.playbookId, opts.subjectEntityId]
  );
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, created_by, definition_snapshot, started_at)
     values ($1, $2, $3, 'is-agent', 'running', $4, $5::jsonb, now())`,
    [
      randomUUID(),
      opts.playbookId,
      id,
      USER,
      JSON.stringify({
        version: 1,
        stages: [],
        subjectProfile: opts.snapshotProfile,
      }),
    ]
  );
  return id;
}

async function sessionOn(
  subjectEntityId: string | null,
  onEnd: OnEnd | undefined,
  extra: Record<string, unknown> = {}
) {
  const profile = {
    profileSlug: "finding",
    statusProperty: "status",
    ...(onEnd ? { onEnd } : {}),
    ...extra,
  };
  const playbookId = await seedPlaybook(profile);
  return seedSession({ playbookId, subjectEntityId, snapshotProfile: profile });
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(`select status from entities where id = $1`, [
      id,
    ])
  ).rows[0]?.status;

/** The transitions owed for a thing (the outbox the status door writes). */
const transitionsOf = async (id: string) =>
  (
    await q<{ transition: Record<string, unknown> }>(
      `select transition from lifecycle_transition_outbox where transition->>'subjectId' = $1`,
      [id]
    )
  ).rows.map((r) => r.transition);

const pendingProposalsOf = async (sessionId: string) =>
  (
    await q<{ id: string }>(
      `select id from proposals where session_id = $1 and status = 'pending'`,
      [sessionId]
    )
  ).rows;

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
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, created_at, updated_at)
     values ($1, 'finding', 'Finding', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now()),
            ($2, 'person', 'Person', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now()),
            ($3, 'lead', 'Lead', 'role', 'system', 'pod', null, true, '{}'::jsonb, now(), now())`,
    [FINDING, PERSON, LEAD]
  );
  await q(
    `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
     values ($1, 'status', 'enum', $2::jsonb, now(), now()),
            ($3, 'stage', 'enum', $4::jsonb, now(), now())`,
    [
      STATUS_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "open", label: "Open", category: "open" },
          { key: "fixing", label: "Fixing", category: "active" },
          // Not terminal, not humanOnly: an agent may move here — unless the
          // PROCESS lists it in its own humanOnlyStatuses.
          { key: "triaged", label: "Triaged", category: "active" },
          // Not terminal: isolates the lifecycle humanOnly floor.
          {
            key: "signed_off",
            label: "Signed off",
            category: "active",
            humanOnly: true,
          },
          { key: "fixed", label: "Fixed", category: "done" },
          { key: "wont_fix", label: "Won't fix", category: "lost" },
        ],
      }),
      STAGE_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "new", label: "New", category: "open" },
          { key: "qualified", label: "Qualified", category: "active" },
          { key: "won", label: "Won", category: "done" },
        ],
      }),
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle)
     values ($1, $2, true), ($3, $4, true)`,
    [FINDING, STATUS_DEF, LEAD, STAGE_DEF]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from governance_rules where target_pattern = '@reversible';"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
});

describe("each end moves the subject to its own onEnd value (a person's close)", () => {
  const onEnd: OnEnd = { closed: "fixed", cancelled: "open", failed: "open" };

  it("closed → fixed, and the transition names the session", async () => {
    const finding = await seedFinding("fixing");
    const sessionId = await sessionOn(finding, onEnd);
    const res = await completeFocusSession({ sessionId, userId: USER });
    expect(res?.session.status).toBe("closed");
    expect(await statusOf(finding)).toBe("fixed");
    expect(res?.endMoves).toMatchObject({
      status: "closed",
      value: "fixed",
      moves: [
        {
          entityId: finding,
          as: "subject",
          outcome: { status: "written", via: "status_door" },
        },
      ],
    });
    const [t] = await transitionsOf(finding);
    expect(t).toMatchObject({ to: "fixed", sessionId });
  });

  it("cancelled → open", async () => {
    const finding = await seedFinding("fixing");
    const sessionId = await sessionOn(finding, onEnd);
    const res = await completeFocusSession({
      sessionId,
      userId: USER,
      terminalStatus: "cancelled",
    });
    expect(res?.session.status).toBe("cancelled");
    expect(await statusOf(finding)).toBe("open");
  });

  it("failed → open", async () => {
    const finding = await seedFinding("fixing");
    const sessionId = await sessionOn(finding, onEnd);
    const res = await completeFocusSession({
      sessionId,
      userId: USER,
      terminalStatus: "failed",
    });
    expect(res?.session.status).toBe("failed");
    expect(await statusOf(finding)).toBe("open");
  });

  it("an end the process names nothing for moves nothing", async () => {
    const finding = await seedFinding("fixing");
    const sessionId = await sessionOn(finding, { cancelled: "open" });
    const res = await completeFocusSession({ sessionId, userId: USER });
    expect(res?.session.status).toBe("closed");
    expect(await statusOf(finding)).toBe("fixing");
    expect(res?.endMoves).toBeUndefined();
    expect(await transitionsOf(finding)).toEqual([]);
  });
});

describe("no onEnd", () => {
  it("moves nothing", async () => {
    const finding = await seedFinding("fixing");
    const sessionId = await sessionOn(finding, undefined);
    const res = await completeFocusSession({ sessionId, userId: USER });
    expect(res?.session.status).toBe("closed");
    expect(await statusOf(finding)).toBe("fixing");
    expect(res?.endMoves).toBeUndefined();
    expect(await transitionsOf(finding)).toEqual([]);
  });
});

describe("governance: the status door decides each end move", () => {
  it("an agent's close into done APPLIES: the session's end is the guardrail", async () => {
    const finding = await seedFinding("fixing");
    const sessionId = await sessionOn(finding, { closed: "fixed" });
    const res = await completeFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
    });
    expect(res?.session.status).toBe("closed");
    expect(res?.endMoves?.moves[0]?.outcome).toMatchObject({
      status: "written",
      value: "fixed",
    });
    expect(await statusOf(finding)).toBe("fixed");
    // Nothing waits for the person: the move was not filed as a proposal.
    expect(await pendingProposalsOf(sessionId)).toEqual([]);
  });

  it("an agent's close into a lifecycle humanOnly option is a proposal", async () => {
    const finding = await seedFinding("fixing");
    const sessionId = await sessionOn(finding, { closed: "signed_off" });
    const res = await completeFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
    });
    expect(res?.endMoves?.moves[0]?.outcome.status).toBe("proposed");
    expect(await statusOf(finding)).toBe("fixing");
  });

  it("an agent's ordinary move applies — unless the PROCESS lists it humanOnly", async () => {
    const free = await seedFinding("fixing");
    const freeSession = await sessionOn(free, { closed: "triaged" });
    const applied = await completeFocusSession({
      sessionId: freeSession,
      userId: USER,
      agentUserId: AGENT,
    });
    expect(applied?.endMoves?.moves[0]?.outcome.status).toBe("written");
    expect(await statusOf(free)).toBe("triaged");

    const held = await seedFinding("fixing");
    const heldSession = await sessionOn(
      held,
      { closed: "triaged" },
      { humanOnlyStatuses: ["triaged"] }
    );
    const proposed = await completeFocusSession({
      sessionId: heldSession,
      userId: USER,
      agentUserId: AGENT,
    });
    expect(proposed?.endMoves?.moves[0]?.outcome.status).toBe("proposed");
    expect(await statusOf(held)).toBe("fixing");
  });

  it("a subject already at the value is left alone (no second transition)", async () => {
    const finding = await seedFinding("open");
    const sessionId = await sessionOn(finding, { cancelled: "open" });
    const res = await completeFocusSession({
      sessionId,
      userId: USER,
      terminalStatus: "cancelled",
    });
    expect(res?.endMoves?.moves[0]?.outcome).toEqual({
      status: "skipped",
      reason: "already_set",
    });
    expect(await transitionsOf(finding)).toEqual([]);
  });
});

describe("an end move never takes a thing out of done or lost", () => {
  it("a person's cancel leaves a subject already done where it is", async () => {
    const finding = await seedFinding("fixed");
    const sessionId = await sessionOn(finding, { cancelled: "open" });
    const res = await completeFocusSession({
      sessionId,
      userId: USER,
      terminalStatus: "cancelled",
    });
    expect(res?.session.status).toBe("cancelled");
    expect(res?.endMoves?.moves).toEqual([
      {
        entityId: finding,
        as: "subject",
        outcome: { status: "skipped", reason: "already_settled" },
      },
    ]);
    expect(await statusOf(finding)).toBe("fixed");
    expect(await transitionsOf(finding)).toEqual([]);
  });

  it("an agent's failed end leaves a subject already lost where it is, with no proposal", async () => {
    const finding = await seedFinding("wont_fix");
    const sessionId = await sessionOn(finding, { failed: "open" });
    const res = await completeFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      terminalStatus: "failed",
    });
    expect(res?.endMoves?.moves[0]?.outcome).toEqual({
      status: "skipped",
      reason: "already_settled",
    });
    expect(await statusOf(finding)).toBe("wont_fix");
    expect(await pendingProposalsOf(sessionId)).toEqual([]);
  });

  it("a target still open on the session but done by its status is left alone; an active one moves", async () => {
    const active = await seedFinding("fixing");
    const done = await seedFinding("fixed");
    const sessionId = await sessionOn(null, { cancelled: "open" });
    for (const entityId of [active, done]) {
      await q(
        `insert into links (from_type, from_id, to_type, to_id, link_type, metadata)
         values ('session', $1, 'entity', $2, 'targets', $3::jsonb)`,
        [sessionId, entityId, JSON.stringify({ role: "worker_target" })]
      );
    }
    const res = await completeFocusSession({
      sessionId,
      userId: USER,
      terminalStatus: "cancelled",
    });
    expect(await statusOf(active)).toBe("open");
    expect(await statusOf(done)).toBe("fixed");
    expect(res?.endMoves?.moves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: active,
          outcome: expect.objectContaining({ status: "written" }),
        }),
        {
          entityId: done,
          as: "target",
          outcome: { status: "skipped", reason: "already_settled" },
        },
      ])
    );
  });
});

describe("a ROLE process moves the role's facet", () => {
  it("the lead facet moves; the person's own status does not", async () => {
    const person = randomUUID();
    await q(
      `insert into entities (id, user_id, type, profile_id, title, workspace_id, properties, created_at, updated_at)
       values ($1, $2, 'person', $3, 'Ada', null, '{}'::jsonb, now(), now())`,
      [person, USER, PERSON]
    );
    const facet = randomUUID();
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, status_category, properties, metadata, created_at, updated_at)
       values ($1, $2, $3, $4, null, 'new', 'open', '{"stage":"new"}'::jsonb, '{}'::jsonb, now(), now())`,
      [facet, person, LEAD, USER]
    );
    const profile = {
      profileSlug: "lead",
      statusProperty: "stage",
      onEnd: { closed: "qualified" },
    };
    const playbookId = await seedPlaybook(profile);
    const sessionId = await seedSession({
      playbookId,
      subjectEntityId: person,
      snapshotProfile: profile,
    });
    const res = await completeFocusSession({ sessionId, userId: USER });
    expect(res?.endMoves?.moves[0]?.outcome).toMatchObject({
      status: "written",
      via: "status_door",
    });
    const [row] = (
      await q<{ status: string }>(
        `select status from entity_facets where id = $1`,
        [facet]
      )
    ).rows;
    expect(row?.status).toBe("qualified");
    expect(await statusOf(person)).toBeNull();
  });
});

describe("targets", () => {
  it("a target still open at the close moves; one the session settled does not", async () => {
    const open = await seedFinding("fixing");
    const settled = await seedFinding("fixing");
    const sessionId = await sessionOn(null, { cancelled: "open" });
    for (const [entityId, metadata] of [
      [open, { role: "worker_target" }],
      [settled, { role: "worker_target", result: "done" }],
    ] as const) {
      await q(
        `insert into links (from_type, from_id, to_type, to_id, link_type, metadata)
         values ('session', $1, 'entity', $2, 'targets', $3::jsonb)`,
        [sessionId, entityId, JSON.stringify(metadata)]
      );
    }
    const res = await completeFocusSession({
      sessionId,
      userId: USER,
      terminalStatus: "cancelled",
    });
    expect(await statusOf(open)).toBe("open");
    expect(await statusOf(settled)).toBe("fixing");
    expect(res?.endMoves?.moves).toEqual([
      expect.objectContaining({ entityId: open, as: "target" }),
    ]);
    const [t] = await transitionsOf(open);
    expect(t).toMatchObject({ to: "open", sessionId });
    // The close's own stamp still marks it: unfinished is a mark.
    const [edge] = (
      await q<{ metadata: Record<string, unknown> }>(
        `select metadata from links where from_id = $1 and to_id = $2`,
        [sessionId, open]
      )
    ).rows;
    expect(edge?.metadata).toMatchObject({
      result: "skipped",
      reason: "session_closed",
    });
  });
});

describe("the frozen process decides", () => {
  it("the run snapshot's onEnd is applied, not a later edit of the playbook", async () => {
    const finding = await seedFinding("fixing");
    // The playbook was edited after the run started: its live onEnd differs.
    const playbookId = await seedPlaybook({
      profileSlug: "finding",
      statusProperty: "status",
      onEnd: { closed: "wont_fix" },
    });
    const sessionId = await seedSession({
      playbookId,
      subjectEntityId: finding,
      snapshotProfile: {
        profileSlug: "finding",
        statusProperty: "status",
        onEnd: { closed: "fixed" },
      },
    });
    const res = await completeFocusSession({ sessionId, userId: USER });
    expect(res?.endMoves?.value).toBe("fixed");
    expect(await statusOf(finding)).toBe("fixed");
  });
});
