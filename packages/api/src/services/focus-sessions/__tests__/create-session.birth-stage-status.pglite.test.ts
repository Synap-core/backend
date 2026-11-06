/**
 * A SESSION BORN INTO ITS FIRST STAGE MOVES ITS SUBJECT (finding e100ddf6).
 *
 * `createFocusSession` seeds `current_stage` from the playbook's first stage,
 * but only an ADVANCE wrote a stage's `subjectStatus` onto the subject. Live:
 * session c90c0292 started from a playbook whose first stage "fix" names
 * "fixing", on finding bfae3b84 — the finding stayed "open"; advancing to the
 * next stage did move it.
 *
 * Through the REAL start door (`createFocusSession`), the REAL process loader
 * (`loadSessionProcess`, the run's frozen snapshot) and the REAL status door
 * (`moveStatus` behind `writeStageSubjectStatus`), on one PGlite. Each row
 * rules something out:
 *  - an UNGATED first stage naming a status moves the subject at birth, and
 *    the start reply says so (`subjectMove`) — the defect itself;
 *  - a GATED first stage moves nothing and reports nothing (the advance's
 *    rule: a stage held by its gate is not agreed yet);
 *  - a first stage that names no status moves nothing and adds nothing;
 *  - a subject write that FAILS is reported on the reply and the session is
 *    still created (never swallowed, never a failed start).
 *
 * A BIRTH THAT REOPENS PROPOSES (finding 2d84febb): an agent starting a
 * session on a subject already done (or lost) took it straight back to the
 * first stage's status, with no proposal. Now the move is filed for the
 * person (`LIFECYCLE_REOPEN`, rung 2.076): nothing written, the reply says
 * `proposed` with the proposal. An agent's birth on an OPEN subject still
 * writes, and a person's own start (the person IS the one reopening) writes.
 *
 * Harness: as process-follows-kind-lifecycle.pglite.test.ts (the session's own
 * `focus_session` gate stubbed so the start is granted; every entity move
 * reaches the REAL gate).
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
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});
vi.mock("../../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  broadcastNotification: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  dispatchLifecycleTransition: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
// The start's own gate is not under test; every other subject (the stage
// move's `entity.transition`) reaches the REAL gate.
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
import { createFocusSession } from "../create-session.js";

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
const STATUS_DEF = randomUUID();
const PHASE_DEF = randomUUID();

const CATEGORY: Record<string, string> = {
  open: "open",
  fixing: "active",
  fixed: "done",
  dropped: "lost",
};

async function seedFinding(status = "open"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, status, status_category, properties, created_at, updated_at)
     values ($1, $2, 'finding', $3, 'A finding', null, $4, $5, $6::jsonb, now(), now())`,
    [id, USER, FINDING, status, CATEGORY[status], JSON.stringify({ status })]
  );
  return id;
}

async function seedPlaybook(
  stages: unknown[],
  subjectProfile: Record<string, unknown> = { profileSlug: "finding" }
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, subject_profile, version, status, created_at, updated_at)
     values ($1, null, $2, 'Fix a finding', 'Fix it', 'is-agent',
             $3::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $4::jsonb, 1, 'active', now(), now())`,
    [id, USER, JSON.stringify(stages), JSON.stringify(subjectProfile)]
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

async function startOn(
  subjectEntityId: string,
  templateId: string,
  opts: { agentUserId?: string } = {}
) {
  const res = await createFocusSession({
    userId: USER,
    ...(opts.agentUserId ? { agentUserId: opts.agentUserId } : {}),
    goal: `Fix the finding ${randomUUID()}`,
    templateId,
    subjectEntityId,
    matchTemplate: false,
    forceCreate: true,
  });
  expect(res.status).toBe("created");
  return res as Extract<typeof res, { status: "created" }>;
}

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
     values ($1, 'finding', 'Finding', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now())`,
    [FINDING]
  );
  await q(
    `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
     values ($1, 'status', 'enum', $2::jsonb, now(), now()),
            ($3, 'phase', 'enum', $4::jsonb, now(), now())`,
    [
      STATUS_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "open", label: "Open", category: "open" },
          { key: "fixing", label: "Fixing", category: "active" },
          { key: "fixed", label: "Fixed", category: "done" },
          { key: "dropped", label: "Dropped", category: "lost" },
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
  // finding declares `status` as its lifecycle; `phase` is a plain field.
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle)
     values ($1, $2, true), ($1, $3, false)`,
    [FINDING, STATUS_DEF, PHASE_DEF]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from governance_rules where target_pattern = '@reversible';"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
});

describe("a session born into its first stage moves its subject", () => {
  it("an ungated first stage naming a status moves the subject, and the start reply says so", async () => {
    const finding = await seedFinding();
    const playbook = await seedPlaybook([
      { key: "fix", name: "Fix", subjectStatus: "fixing" },
      { key: "merged", name: "Merged", subjectStatus: "fixed" },
    ]);
    const res = await startOn(finding, playbook);
    expect(res.session.currentStage).toBe("fix");
    expect(await statusOf(finding)).toBe("fixing");
    expect(res.subjectMove).toMatchObject({
      status: "written",
      property: "status",
      value: "fixing",
      via: "status_door",
    });
  });

  it("a GATED first stage moves nothing and reports nothing", async () => {
    const finding = await seedFinding();
    const playbook = await seedPlaybook([
      {
        key: "fix",
        name: "Fix",
        subjectStatus: "fixing",
        gate: { kind: "human" },
      },
    ]);
    const res = await startOn(finding, playbook);
    expect(res.session.currentStage).toBe("fix");
    expect(await statusOf(finding)).toBe("open");
    expect(res.subjectMove).toBeUndefined();
  });

  it("a first stage that names no status moves nothing and adds nothing", async () => {
    const finding = await seedFinding();
    const playbook = await seedPlaybook([
      { key: "notes", name: "Notes" },
      { key: "fix", name: "Fix", subjectStatus: "fixing" },
    ]);
    const res = await startOn(finding, playbook);
    expect(res.session.currentStage).toBe("notes");
    expect(await statusOf(finding)).toBe("open");
    expect(res.subjectMove).toBeUndefined();
  });

  it("a subject write that fails is reported, and the session is still created", async () => {
    const finding = await seedFinding();
    // A second status ladder beside the declared lifecycle: the status door
    // refuses it (NOT_THE_LIFECYCLE).
    const playbook = await seedPlaybook(
      [{ key: "fix", name: "Fix", subjectStatus: "fixing" }],
      { profileSlug: "finding", statusProperty: "phase" }
    );
    const res = await startOn(finding, playbook);
    expect(res.session.id).toBeTruthy();
    expect(res.subjectMove).toMatchObject({ status: "failed" });
    expect(
      (res.subjectMove as { reason?: string } | undefined)?.reason
    ).toContain('This process moves "phase"');
    expect(await statusOf(finding)).toBe("open");
  });
});

const pendingProposal = async (id: string) =>
  (
    await q<{ id: string; status: string; governance_reason: string | null }>(
      `select id, status, governance_reason from proposals where id = $1`,
      [id]
    )
  ).rows[0];

describe("a session birth that would reopen a done or lost subject proposes", () => {
  const fixStages = [
    { key: "fix", name: "Fix", subjectStatus: "fixing" },
    { key: "merged", name: "Merged", subjectStatus: "fixed" },
  ];

  for (const settled of ["fixed", "dropped"]) {
    it(`an agent's start on a subject in "${settled}" files the reopen and writes nothing`, async () => {
      const finding = await seedFinding(settled);
      const playbook = await seedPlaybook(fixStages);
      const res = await startOn(finding, playbook, { agentUserId: AGENT });
      expect(res.session.currentStage).toBe("fix");
      // Nothing written: the subject is still where the person left it.
      expect(await statusOf(finding)).toBe(settled);
      expect(res.subjectMove).toMatchObject({
        status: "proposed",
        property: "status",
        value: "fixing",
        via: "status_door",
      });
      const proposalId = (res.subjectMove as { proposalId?: string })
        .proposalId;
      expect(proposalId).toBeTruthy();
      expect(await pendingProposal(proposalId!)).toMatchObject({
        status: "pending",
        governance_reason: "LIFECYCLE_REOPEN",
      });
    });
  }

  it("an agent's start on an OPEN subject still writes the first stage's status", async () => {
    const finding = await seedFinding("open");
    const playbook = await seedPlaybook(fixStages);
    const res = await startOn(finding, playbook, { agentUserId: AGENT });
    expect(await statusOf(finding)).toBe("fixing");
    expect(res.subjectMove).toMatchObject({
      status: "written",
      value: "fixing",
      via: "status_door",
    });
  });

  it("a person's own start on a done subject writes: the person is the one reopening", async () => {
    const finding = await seedFinding("fixed");
    const playbook = await seedPlaybook(fixStages);
    const res = await startOn(finding, playbook);
    expect(await statusOf(finding)).toBe("fixing");
    expect(res.subjectMove).toMatchObject({ status: "written" });
  });
});
