/**
 * ONE ROW SHAPE FOR EVERY BIRTH DOOR (plan "One model" §11 row 5).
 *
 * Four doors birth a focus session: the direct start (`createFocusSession`),
 * the run funnel (`instantiateSession`), the approved-proposal executor
 * (`focus_session/create`) and the run door (`openRunSession`). Each held its
 * own INSERT and the copies drifted: the run funnel never copied the stages
 * nor moved the subject into its first stage, the direct door never owed the
 * first stage's outputs, an approved plain start and a run session were born
 * nameless, a run session's slots were never keyed. They now all go through
 * THE row writer (`insertFocusSessionRow`) and the birth rules beside it
 * (`session-birth.ts`).
 *
 * For the SAME input, every door must produce the SAME row shape:
 *  - no playbook (direct start, approved plain start, run door): the same
 *    derived name, the same keyed slots, no stages, no stage;
 *  - a staged playbook with a subject (direct start, run funnel, approved
 *    playbook start): the same stages snapshot, the same first stage, the
 *    same slots (the playbook's + the first stage's), and the subject moved
 *    to the first stage's status.
 *
 * Seen failing with one door reverted to its own copy (negative control).
 * Harness: as create-session.birth-stage-status.pglite.test.ts, one PGlite,
 * the REAL doors, the REAL status door behind the subject move.
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
vi.mock("../../links/links-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLinks: vi.fn(async () => []),
}));
vi.mock("../session-recall.js", () => ({
  enqueueSessionRecall: vi.fn(),
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
import { instantiateSession } from "../../playbooks/playbook-lifecycle.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { openRunSession } from "@synap/database";
import { buildDerivedSessionTitle } from "@synap-core/types/focus-sessions";

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
const WS = randomUUID();
const FINDING = randomUUID();
const STATUS_DEF = randomUUID();

const STAGES = [
  {
    key: "fix",
    name: "Fix",
    subjectStatus: "fixing",
    expectedOutputs: [{ kind: "note", label: "Fix notes" }],
  },
  { key: "merged", name: "Merged", subjectStatus: "fixed" },
];
const PLAYBOOK_OUTPUTS = [{ kind: "note", label: "Hygiene report" }];
const DECLARED = [{ kind: "note", label: "Hygiene report" }];

let PLAYBOOK: string;

async function seedFinding(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, status, status_category, properties, created_at, updated_at)
     values ($1, $2, 'finding', $3, 'A finding', null, 'open', 'open', '{"status":"open"}'::jsonb, now(), now())`,
    [id, USER, FINDING]
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

type Row = {
  id: string;
  title: string | null;
  playbook_id: string | null;
  stages: unknown;
  current_stage: string | null;
  track_stage: string | null;
  status: string;
  subject_entity_id: string | null;
  expected_outputs: Array<{ label?: string; key?: string }> | null;
  metadata: Record<string, unknown>;
};
const rowOf = async (id: string): Promise<Row> =>
  (await q<Row>(`select * from focus_sessions where id = $1`, [id])).rows[0]!;

/** What the four doors must agree on, read off the stored row. */
const shape = (r: Row) => ({
  playbookId: r.playbook_id,
  stages: r.stages,
  currentStage: r.current_stage,
  trackStage: r.track_stage,
  status: r.status,
  slots: (r.expected_outputs ?? []).map((o) => `${o.label}#${o.key}`).sort(),
});

/** The approved-proposal door: a pending `focus_session/create`, approved. */
async function approve(data: Record<string, unknown>): Promise<string> {
  const proposalId = randomUUID();
  const targetId = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, workspace_id, created_at, updated_at)
     values ($1, 'pending', 'create', 'focus_session', $2, $3::jsonb, $4, now(), now())`,
    [proposalId, targetId, JSON.stringify({ data }), WS]
  );
  const result = (await proposalExecRegistry
    .resolveExact("focus_session/create")!
    .execute({
      proposal: {
        id: proposalId,
        targetId,
        workspaceId: WS,
        projectId: null,
        subjectUserId: USER,
        agentUserId: null,
        correlationId: null,
        data: { data },
        targetType: "focus_session",
        proposalType: "create",
      },
      payload: null,
      userId: USER,
      input: { proposalId },
      ctx: {},
      deps: {
        emitProposalReviewed: () => undefined,
        reportProposalOutcome: () => undefined,
      },
    } as never)) as { primaryId?: string };
  expect(result.primaryId).toBe(targetId);
  return targetId;
}

beforeAll(async () => {
  await h.init();
  await h.client!.exec(pgliteAllTablesDdl());
  registerFocusSessionExecutors();
  await q(
    `insert into users (id, name, email, user_type) values ($1, 'Founder', 'f@x', 'human')`,
    [USER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'W', $2, '{}'::jsonb)`,
    [WS, USER]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
    [WS, USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, created_at, updated_at)
     values ($1, 'finding', 'Finding', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now())`,
    [FINDING]
  );
  await q(
    `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
     values ($1, 'status', 'enum', $2::jsonb, now(), now())`,
    [
      STATUS_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "open", label: "Open", category: "open" },
          { key: "fixing", label: "Fixing", category: "active" },
          { key: "fixed", label: "Fixed", category: "done" },
        ],
      }),
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1, $2, true)`,
    [FINDING, STATUS_DEF]
  );
  PLAYBOOK = randomUUID();
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, subject_profile, version, status, created_at, updated_at)
     values ($1, null, $2, 'Fix a finding', 'Fix it', 'is-agent',
             $3::jsonb, '[]'::jsonb, $4::jsonb, '[]'::jsonb, '{"profileSlug":"finding"}'::jsonb, 1, 'active', now(), now())`,
    [PLAYBOOK, USER, JSON.stringify(STAGES), JSON.stringify(PLAYBOOK_OUTPUTS)]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from governance_rules where target_pattern = '@reversible';"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
});

describe("every birth door writes the same row for the same input", () => {
  it("no playbook: the direct start, an approved start and a run session are born alike", async () => {
    const goal = `Tidy the CRM ${randomUUID()}`;
    // The approval first: it asks the twin question (an open session with
    // the same goal and scope is LINKED, not inserted), which is not under
    // test here. The direct start then forces past the same question.
    const approvedId = await approve({ goal, expectedOutputs: DECLARED });
    const direct = await createFocusSession({
      userId: USER,
      workspaceId: WS,
      goal,
      expectedOutputs: DECLARED as never,
      templateId: null,
      matchTemplate: false,
      forceCreate: true,
    });
    expect(direct.status).toBe("created");
    const directId = (direct as { session: { id: string } }).session.id;
    const { sessionId: runId } = await openRunSession({
      userId: USER,
      workspaceId: WS,
      goal,
      source: "agent-run",
      expectedOutputs: DECLARED,
    });

    const rows = await Promise.all([directId, approvedId, runId].map(rowOf));
    const [first, ...rest] = rows.map(shape);
    expect(first).toEqual({
      playbookId: null,
      stages: [],
      currentStage: null,
      trackStage: null,
      status: "active",
      slots: ["Hygiene report#hygiene-report"],
    });
    for (const other of rest) expect(other).toEqual(first);
    // No session is stored nameless: each is named from its goal, `derived`.
    for (const r of rows) {
      expect(r.title).toBe(buildDerivedSessionTitle({ kind: "goal", goal }));
      expect(r.metadata.titleSource).toBe("derived");
    }
  });

  it("a staged playbook with a subject: the direct start, a run and an approved start are born alike, and each moves its subject", async () => {
    const goal = `Fix the finding ${randomUUID()}`;
    const [f1, f2, f3] = [
      await seedFinding(),
      await seedFinding(),
      await seedFinding(),
    ];
    const direct = await createFocusSession({
      userId: USER,
      workspaceId: WS,
      goal,
      templateId: PLAYBOOK,
      subjectEntityId: f1,
      matchTemplate: false,
      forceCreate: true,
    });
    expect(direct.status).toBe("created");
    const directId = (direct as { session: { id: string } }).session.id;
    const run = await instantiateSession({
      playbookId: PLAYBOOK,
      workspaceId: WS,
      userId: USER,
      subjectId: f2,
    });
    const approvedId = await approve({
      goal,
      playbookId: PLAYBOOK,
      templateId: PLAYBOOK,
      subjectEntityId: f3,
    });

    const rows = await Promise.all([directId, run.id, approvedId].map(rowOf));
    const [first, ...rest] = rows.map(shape);
    expect(first).toEqual({
      playbookId: PLAYBOOK,
      stages: STAGES,
      currentStage: "fix",
      trackStage: null,
      status: "active",
      slots: ["Fix notes#fix-notes", "Hygiene report#hygiene-report"],
    });
    for (const other of rest) expect(other).toEqual(first);
    // Born into "fix": each subject now stands at that stage's status.
    expect([
      await statusOf(f1),
      await statusOf(f2),
      await statusOf(f3),
    ]).toEqual(["fixing", "fixing", "fixing"]);
  });
});
