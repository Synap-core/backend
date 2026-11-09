/**
 * A PROCESS THAT NAMES NO statusProperty FOLLOWS THE LIFECYCLE ITS KIND
 * DECLARES (finding bfae3b84) — what `synap_create_playbook` tells agents to
 * do. Live, such a process moved nothing: the stage write skipped
 * `no_status_property`, the close's end moves returned nothing, and the
 * update reply said nothing (session 808d1419 entered a stage with
 * subjectStatus "fixing"; its finding stayed "open").
 *
 * Through the REAL update door (`updateFocusSession` → `advanceSessionStage`
 * → `writeStageSubjectStatus`), the REAL close door (`completeFocusSession`),
 * the REAL process loader (`loadSessionProcess`, where the property is
 * resolved once for every reader) and the REAL status door (`moveStatus`), on
 * one PGlite. Each row rules something out:
 *  - no statusProperty, a kind that declares its lifecycle: the stage advance
 *    moves the subject and the reply says so; the session end moves it too;
 *  - a ROLE process with no statusProperty moves the role's facet at the end;
 *  - a NAMED statusProperty still wins over the declared lifecycle (a resolver
 *    that always took the lifecycle would write "status" here, not refuse);
 *  - a kind that declares NO lifecycle: nothing moves, and both replies carry
 *    the skip with its reason (`no_status_property`), never a silent nothing;
 *  - a stage that asks for no move adds nothing to the reply.
 *
 * Harness and stubs: as session-end-moves.pglite.test.ts (the close door's
 * own `focus_session` gate stubbed, post-commit delivery stubbed, PGlite is
 * one connection).
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
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { pgliteAllTablesDdl } from "../../../__tests__/pglite-ddl.js";
import { completeFocusSession } from "../complete-session.js";
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
const FINDING = randomUUID();
const MEMO = randomUUID();
const PERSON = randomUUID();
const LEAD = randomUUID();
const STATUS_DEF = randomUUID();
const STAGE_DEF = randomUUID();
const PHASE_DEF = randomUUID();

/** The process's stages: "fix" asks for "fixing", "notes" asks for nothing. */
const STAGES = [
  { key: "fix", name: "Fix", subjectStatus: "fixing" },
  { key: "notes", name: "Notes" },
];

async function seedThing(profileId: string, type: string, status: string) {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, status, status_category, properties, created_at, updated_at)
     values ($1, $2, $3, $4, 'A thing', null, $5, 'open', $6::jsonb, now(), now())`,
    [id, USER, type, profileId, status, JSON.stringify({ status })]
  );
  return id;
}

/**
 * A live session following a playbook whose process is `subjectProfile`
 * (frozen on its run, as a run started from it would be).
 */
async function sessionOn(
  subjectEntityId: string,
  subjectProfile: Record<string, unknown>
): Promise<string> {
  const playbookId = randomUUID();
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, subject_profile, version, status, created_at, updated_at)
     values ($1, null, $2, 'Fix a finding', 'Fix it', 'is-agent',
             $3::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $4::jsonb, 1, 'active', now(), now())`,
    [playbookId, USER, JSON.stringify(STAGES), JSON.stringify(subjectProfile)]
  );
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, playbook_id, subject_entity_id, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Fix it', 'Fix the finding', 'active', 'playbook', $3, $4,
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
    [id, USER, playbookId, subjectEntityId]
  );
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, created_by, definition_snapshot, started_at)
     values ($1, $2, $3, 'is-agent', 'running', $4, $5::jsonb, now())`,
    [
      randomUUID(),
      playbookId,
      id,
      USER,
      JSON.stringify({ version: 1, stages: STAGES, subjectProfile }),
    ]
  );
  return id;
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string | null }>(
      `select status from entities where id = $1`,
      [id]
    )
  ).rows[0]?.status;

async function advance(sessionId: string, currentStage: string) {
  const res = await updateFocusSession({
    sessionId,
    userId: USER,
    currentStage,
  });
  expect(res.status).toBe("updated");
  return res as Extract<typeof res, { status: "updated" }>;
}

beforeAll(async () => {
  await h.init();
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `insert into users (id, name, email, user_type) values ($1, 'Founder', 'f@x', 'human')`,
    [USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, created_at, updated_at)
     values ($1, 'finding', 'Finding', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now()),
            ($2, 'memo', 'Memo', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now()),
            ($3, 'person', 'Person', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now()),
            ($4, 'lead', 'Lead', 'role', 'system', 'pod', null, true, '{}'::jsonb, now(), now())`,
    [FINDING, MEMO, PERSON, LEAD]
  );
  await q(
    `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
     values ($1, 'status', 'enum', $2::jsonb, now(), now()),
            ($3, 'stage', 'enum', $4::jsonb, now(), now()),
            ($5, 'phase', 'enum', $6::jsonb, now(), now())`,
    [
      STATUS_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "open", label: "Open", category: "open" },
          { key: "fixing", label: "Fixing", category: "active" },
          { key: "fixed", label: "Fixed", category: "done" },
        ],
      }),
      STAGE_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "new", label: "New", category: "open" },
          { key: "qualified", label: "Qualified", category: "active" },
        ],
      }),
      PHASE_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "open", label: "Open" },
          { key: "fixing", label: "Fixing" },
        ],
      }),
    ]
  );
  // finding declares `status` as its lifecycle; lead declares `stage`; memo
  // and the finding's `phase` declare none.
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle)
     values ($1, $2, true), ($3, $4, true), ($1, $5, false)`,
    [FINDING, STATUS_DEF, LEAD, STAGE_DEF, PHASE_DEF]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from governance_rules where target_pattern = '@reversible';"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
});

describe("no statusProperty: the process follows the kind's declared lifecycle", () => {
  it("a stage advance moves the subject, and the reply says so", async () => {
    const finding = await seedThing(FINDING, "finding", "open");
    const sessionId = await sessionOn(finding, { profileSlug: "finding" });
    const res = await advance(sessionId, "fix");
    expect(await statusOf(finding)).toBe("fixing");
    expect(res.subjectMove).toMatchObject({
      status: "written",
      property: "status",
      value: "fixing",
      via: "status_door",
    });
  });

  it("the session end moves the subject", async () => {
    const finding = await seedThing(FINDING, "finding", "fixing");
    const sessionId = await sessionOn(finding, {
      profileSlug: "finding",
      onEnd: { closed: "fixed" },
    });
    const res = await completeFocusSession({ sessionId, userId: USER });
    expect(res?.session.status).toBe("closed");
    expect(await statusOf(finding)).toBe("fixed");
    expect(res?.endMoves?.moves).toEqual([
      expect.objectContaining({
        entityId: finding,
        as: "subject",
        outcome: expect.objectContaining({
          status: "written",
          property: "status",
        }),
      }),
    ]);
  });

  it("a ROLE process moves the role's facet at the end", async () => {
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
    const sessionId = await sessionOn(person, {
      profileSlug: "lead",
      onEnd: { closed: "qualified" },
    });
    const res = await completeFocusSession({ sessionId, userId: USER });
    expect(res?.endMoves?.moves[0]?.outcome).toMatchObject({
      status: "written",
      property: "stage",
    });
    const [row] = (
      await q<{ status: string }>(
        `select status from entity_facets where id = $1`,
        [facet]
      )
    ).rows;
    expect(row?.status).toBe("qualified");
  });

  it("a stage that asks for no move adds nothing to the reply", async () => {
    const finding = await seedThing(FINDING, "finding", "open");
    const sessionId = await sessionOn(finding, { profileSlug: "finding" });
    const res = await advance(sessionId, "notes");
    expect(res.subjectMove).toBeUndefined();
    expect(await statusOf(finding)).toBe("open");
  });
});

describe("a NAMED statusProperty still wins", () => {
  it("the process's own property is the one moved, not the declared lifecycle", async () => {
    const finding = await seedThing(FINDING, "finding", "open");
    const sessionId = await sessionOn(finding, {
      profileSlug: "finding",
      statusProperty: "phase",
    });
    const res = await advance(sessionId, "fix");
    // The kind declares `status`: a second ladder on `phase` is refused, and
    // the refusal names the process's own property. The lifecycle is untouched.
    expect(res.subjectMove).toMatchObject({ status: "failed" });
    expect(
      (res.subjectMove as { reason?: string } | undefined)?.reason
    ).toContain('This process moves "phase"');
    expect(await statusOf(finding)).toBe("open");
  });
});

describe("a kind that declares NO lifecycle: nothing moves, and the reply says why", () => {
  it("the stage advance reports skipped: no_status_property", async () => {
    const memo = await seedThing(MEMO, "memo", "open");
    const sessionId = await sessionOn(memo, { profileSlug: "memo" });
    const res = await advance(sessionId, "fix");
    expect(res.subjectMove).toEqual({
      status: "skipped",
      reason: "no_status_property",
    });
    expect(await statusOf(memo)).toBe("open");
  });

  it("the close reports each thing skipped: no_status_property, with a warning", async () => {
    const memo = await seedThing(MEMO, "memo", "open");
    const sessionId = await sessionOn(memo, {
      profileSlug: "memo",
      onEnd: { closed: "fixed" },
    });
    const res = await completeFocusSession({ sessionId, userId: USER });
    expect(res?.session.status).toBe("closed");
    expect(res?.endMoves).toEqual({
      status: "closed",
      value: "fixed",
      moves: [
        {
          entityId: memo,
          as: "subject",
          outcome: { status: "skipped", reason: "no_status_property" },
        },
      ],
    });
    expect(res?.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("declares no lifecycle")])
    );
    expect(await statusOf(memo)).toBe("open");
  });
});
