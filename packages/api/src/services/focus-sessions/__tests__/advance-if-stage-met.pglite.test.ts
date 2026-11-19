/**
 * A STEP ADVANCES BY ITSELF (W6, decision D5 a) on PGlite: the REAL slot
 * doors owe the slot's move, the REAL reactor (`handleReactions`) runs the
 * built-in rule `builtin:stage-met-advances` through THE advance door, the
 * REAL grade door (`gradeCriterionAsOwner`) fires the same rule as a fact,
 * the REAL status door moves the subject. Each row rules something out:
 *  - the last required output met moves the session on, once, with ONE log
 *    row saying who (the rule) and why (what was met); a stage still owed an
 *    output does not move;
 *  - a passing grade does the same; a failing one does not;
 *  - a stage a PERSON gates is never entered by itself, nor a subject status
 *    only a person may set; the ungated twin of each does move;
 *  - a legacy `deploy_approved` stamp is never advanced out of;
 *  - the compare-and-set: a stale manual advance is refused, and a step
 *    planned before a manual advance never lands on top of it (no jump);
 *  - the cascade: the subject move names the session (the trigger matcher's
 *    depth floor reads it) and carries the rule's cause; a slot move already
 *    at the reaction depth ceiling advances nothing;
 *  - a check gate held on an output the stage declares is released when the
 *    output is delivered (the gate reads the same outcomes).
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
// The session's own gate is not under test; every other subject (the stage
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
import { db as pgDb, setSessionStatus } from "@synap/database";
import { updateFocusSession } from "../update-session.js";
import { advanceSessionStage } from "../advance-stage.js";
import {
  planStageWorkStep,
  stageMetAdvanceInput,
} from "../advance-if-stage-met.js";
import { gradeCriterionAsOwner } from "../evaluations/evaluate.js";
import { loadSessionNudges } from "../session-nudges.js";
import { collectPlaybookCriteria } from "@synap/playbooks";
import {
  satisfyClaimsByEvidence,
  satisfyOutputsByRef,
} from "../satisfy-expected-output.js";
import { handleReactions } from "@synap/jobs/workers/reactions.js";
import { registerReactionEffect } from "@synap/jobs/utils/reaction-effects.js";
import {
  MAX_REACTION_DEPTH,
  OUTCOME_MET_REACTION_ID,
  STAGE_MET_REACTION_ID,
} from "@synap/jobs/utils/reactions.js";
import { advanceStageReactionEffect } from "../../reactions/advance-stage-effect.js";

// apps/api fills the effect's slot at boot; here, once.
registerReactionEffect(advanceStageReactionEffect);

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
const POST = randomUUID();
const STATUS_DEF = randomUUID();

const spec = (extra: Record<string, unknown> = {}) => ({
  kind: "document",
  label: "Spec",
  status: "pending",
  claimedDone: true,
  ref: { url: "https://example.com/spec" },
  ...extra,
});

/** Build owes a Spec; Review is ungated; Publish is a person's gate. */
const STAGES = [
  {
    key: "build",
    name: "Build",
    expectedOutputs: [{ kind: "document", label: "Spec" }],
  },
  {
    key: "review",
    name: "Review",
    subjectStatus: "Scripted",
    expectedOutputs: [{ kind: "document", label: "Notes" }],
  },
  { key: "publish", name: "Publish", gate: { kind: "human" } },
];

async function seedPost(status: string) {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, status, status_category, properties, created_at, updated_at)
     values ($1, $2, 'post', $3, 'A post', null, $4, 'active', $5::jsonb, now(), now())`,
    [id, USER, POST, status, JSON.stringify({ status })]
  );
  return id;
}

/** A live session standing at `stage`, its run frozen on `stages`. */
async function runAt(input: {
  stage: string;
  outputs?: unknown[];
  criteria?: unknown[];
  stages?: readonly unknown[];
  subject?: string | null;
  status?: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const stages = input.stages ?? STAGES;
  const subjectProfile = { profileSlug: "post" };
  const playbookId = randomUUID();
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, subject_profile, version, status, created_at, updated_at)
     values ($1, null, $2, 'Ship it', 'Ship', 'is-agent',
             $3::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $4::jsonb, 1, 'active', now(), now())`,
    [playbookId, USER, JSON.stringify(stages), JSON.stringify(subjectProfile)]
  );
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, playbook_id, subject_entity_id, current_stage, expected_outputs, criteria, metadata, stages, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Ship the thing', 'Ship the thing', $3, 'playbook', $4, $5, $6,
             $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, '{}', now(), now(), now())`,
    [
      id,
      USER,
      input.status ?? "active",
      playbookId,
      input.subject ?? null,
      input.stage,
      JSON.stringify(input.outputs ?? []),
      JSON.stringify(input.criteria ?? []),
      JSON.stringify(input.metadata ?? {}),
      JSON.stringify(stages),
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
      JSON.stringify({ version: 1, stages, subjectProfile }),
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

const statusOf = async (id: string) =>
  (
    await q<{ status: string | null }>(
      `select status from entities where id = $1`,
      [id]
    )
  ).rows[0]?.status;

/** The subject's moves: to, the session it names, the rule that caused it. */
const movesOf = async (id: string) =>
  (
    await q<{ to: string; sid: string | null; rid: string | null }>(
      `select transition->>'to' as "to", transition->>'sessionId' as sid,
              transition->'cause'->>'reactionId' as rid
         from lifecycle_transition_outbox
        where coalesce(transition->>'subjectId', transition->>'entityId') = $1
        order by created_at`,
      [id]
    )
  ).rows;

/** The rule's log rows for a session (the audit line). */
const logOf = async (sessionId: string) =>
  (
    await q<{
      type: string;
      data: { code: string; reason: string; source: string; to: string };
    }>(
      `select type, data from events
        where subject_type = 'reaction' and subject_id = $1 and session_id = $2
        order by "timestamp"`,
      [STAGE_MET_REACTION_ID, sessionId]
    )
  ).rows;

/** The reactor, on every slot move the doors owed for `sessionId`. */
async function react(sessionId: string) {
  const rows = (
    await q<{ id: string }>(
      `select transition->>'transitionId' as id
         from lifecycle_transition_outbox
        where transition->>'subjectType' = 'slot'
          and transition->>'sessionId' = $1
        order by created_at`,
      [sessionId]
    )
  ).rows;
  for (const r of rows) await handleReactions({ transitionId: r.id });
}

/** Deliver every claimed slot by its own evidence, then run the reactor. */
async function deliver(sessionId: string) {
  await satisfyClaimsByEvidence({ sessionId, userId: USER });
  await react(sessionId);
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
     values ($1, 'post', 'Post', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now())`,
    [POST]
  );
  await q(
    `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
     values ($1, 'status', 'enum', $2::jsonb, now(), now())`,
    [
      STATUS_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "Briefed", label: "Briefed", category: "active" },
          { key: "Scripted", label: "Scripted", category: "active" },
          {
            key: "approved",
            label: "Approved",
            category: "active",
            humanOnly: true,
          },
          { key: "Published", label: "Published", category: "done" },
        ],
      }),
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle)
     values ($1, $2, true)`,
    [POST, STATUS_DEF]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from governance_rules where target_pattern = '@reversible';"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
});

describe("the last required output met moves the step on, by itself", () => {
  it("through the reactor: build → review, once, with one log row (who: the rule; why: what was met)", async () => {
    const id = await runAt({ stage: "build", outputs: [spec()] });
    await deliver(id);
    const s = await sessionOf(id);
    expect(s.current_stage).toBe("review");
    expect(s.stage_history.map((e) => [e.fromStage, e.stageKey])).toEqual([
      ["build", "review"],
    ]);
    const log = await logOf(id);
    expect(log).toHaveLength(1);
    expect(log[0]!.type).toBe("reaction.applied");
    expect(log[0]!.data.to).toBe("review");
    expect(log[0]!.data.reason).toBe(
      "Moved “Ship the thing” on to Review: “Spec” met."
    );
  });

  it("NEGATIVE: a stage still owed another output does not move", async () => {
    const stages = [
      {
        ...STAGES[0]!,
        expectedOutputs: [
          { kind: "document", label: "Spec" },
          { kind: "document", label: "Plan" },
        ],
      },
      ...STAGES.slice(1),
    ];
    const id = await runAt({
      stage: "build",
      outputs: [spec(), { kind: "document", label: "Plan", status: "pending" }],
      stages,
    });
    await deliver(id);
    expect((await sessionOf(id)).current_stage).toBe("build");
    expect(await logOf(id)).toEqual([]);
  });

  it("with a subject: the subject leads, moved as the system, naming the session and the rule", async () => {
    const post = await seedPost("Briefed");
    const id = await runAt({
      stage: "build",
      outputs: [spec()],
      subject: post,
    });
    await deliver(id);
    expect(await statusOf(post)).toBe("Scripted");
    // The cascade's link: the move names the session (the trigger matcher's
    // depth floor reads its chain) and carries the rule's cause.
    expect(await movesOf(post)).toEqual([
      { to: "Scripted", sid: id, rid: STAGE_MET_REACTION_ID },
    ]);
  });
});

describe("a passing grade fires the same rule", () => {
  const criteria = [
    {
      key: "spec-read",
      statement: "The spec was read",
      check: { kind: "human" },
      stageKey: "build",
    },
  ];

  it("the stage's last criterion graded pass: build → review, logged with the grade as its source", async () => {
    const id = await runAt({
      stage: "build",
      criteria,
      stages: [{ key: "build", name: "Build" }, ...STAGES.slice(1)],
    });
    await gradeCriterionAsOwner({
      sessionId: id,
      userId: USER,
      criterionKey: "spec-read",
      verdict: "pass",
    });
    expect((await sessionOf(id)).current_stage).toBe("review");
    const log = await logOf(id);
    expect(log).toHaveLength(1);
    expect(log[0]!.data.source).toBe(`grade:${id}/spec-read`);
  });

  it("NEGATIVE: graded fail, the step stays", async () => {
    const id = await runAt({
      stage: "build",
      criteria,
      stages: [{ key: "build", name: "Build" }, ...STAGES.slice(1)],
    });
    await gradeCriterionAsOwner({
      sessionId: id,
      userId: USER,
      criterionKey: "spec-read",
      verdict: "fail",
    });
    expect((await sessionOf(id)).current_stage).toBe("build");
  });
});

describe("a person's gate stays a person's", () => {
  it("a stage gated by a person is never entered by itself, and no gate is filed", async () => {
    const id = await runAt({
      stage: "review",
      outputs: [spec({ label: "Notes" })],
    });
    await deliver(id);
    expect((await sessionOf(id)).current_stage).toBe("review");
    expect(
      (await q(`select id from proposals where target_id = $1`, [id])).rows
    ).toEqual([]);
  });

  it("CONTROL: the same stage ungated is entered", async () => {
    const stages = [
      STAGES[0]!,
      STAGES[1]!,
      { key: "publish", name: "Publish" },
    ];
    const id = await runAt({
      stage: "review",
      outputs: [spec({ label: "Notes" })],
      stages,
    });
    await deliver(id);
    expect((await sessionOf(id)).current_stage).toBe("publish");
  });

  it("a step whose subject status only a person may set waits for the person", async () => {
    const post = await seedPost("Briefed");
    const stages = [
      STAGES[0]!,
      { key: "review", name: "Review", subjectStatus: "approved" },
    ];
    const id = await runAt({
      stage: "build",
      outputs: [spec()],
      stages,
      subject: post,
    });
    await deliver(id);
    expect((await sessionOf(id)).current_stage).toBe("build");
    expect(await statusOf(post)).toBe("Briefed");
  });

  it("a legacy deploy_approved stamp is never advanced out of", async () => {
    // A process that names the stamp as a stage, its work met: only the
    // exclusion holds it.
    const stages = [
      {
        key: "deploy_approved",
        name: "Deploy approved",
        expectedOutputs: [{ kind: "document", label: "Spec" }],
      },
      { key: "dogfood", name: "Dogfood" },
    ];
    const id = await runAt({
      stage: "deploy_approved",
      outputs: [spec()],
      stages,
    });
    await deliver(id);
    expect((await sessionOf(id)).current_stage).toBe("deploy_approved");
  });
});

describe("compare-and-set on the step", () => {
  it("update_session with a stale expectedStage answers conflict and writes nothing", async () => {
    const id = await runAt({ stage: "review" });
    const res = await updateFocusSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      currentStage: "publish",
      expectedStage: "build",
    });
    expect(res).toMatchObject({
      status: "conflict",
      conflict: {
        reason: "stage_stale",
        expectedStage: "build",
        currentStage: "review",
      },
    });
    const s = await sessionOf(id);
    expect(s.current_stage).toBe("review");
    expect(s.stage_history).toEqual([]);
  });

  it("a step planned before a manual advance never lands on top of it (no jump of two)", async () => {
    const stages = [
      STAGES[0]!,
      { key: "review", name: "Review" },
      { key: "publish", name: "Publish" },
    ];
    const id = await runAt({
      stage: "build",
      outputs: [spec({ status: "done" })],
      stages,
    });
    const step = await planStageWorkStep(id);
    expect(step).toMatchObject({
      kind: "advance",
      fromStage: "build",
      toStage: "review",
    });
    // The agent moves it meanwhile (expecting what it read).
    const manual = await updateFocusSession({
      sessionId: id,
      userId: USER,
      currentStage: "review",
      expectedStage: "build",
    });
    expect(manual.status).toBe("updated");
    const late = await advanceSessionStage(stageMetAdvanceInput(step!, null));
    expect(late).toMatchObject({
      changed: false,
      stale: { expectedStage: "build", currentStage: "review" },
    });
    const s = await sessionOf(id);
    expect(s.current_stage).toBe("review");
    expect(s.stage_history.map((e) => e.stageKey)).toEqual(["review"]);
  });
});

describe("the cascade stays bounded", () => {
  const doc = randomUUID();
  const docSlot = {
    kind: "document",
    label: "Spec",
    status: "pending",
    ref: { kind: "document", id: doc },
  };
  const metBy = (depth: number) => {
    const fired = randomUUID();
    return {
      reactionId: OUTCOME_MET_REACTION_ID,
      transitionId: fired,
      chainId: fired,
      depth,
    };
  };

  it("a slot met by a reaction one link deep still moves the step (default 3 chains)", async () => {
    const id = await runAt({ stage: "build", outputs: [docSlot] });
    await satisfyOutputsByRef({
      sessionId: id,
      userId: USER,
      ref: { kind: "document", id: doc },
      proposalId: randomUUID(),
      cause: metBy(1),
    });
    await react(id);
    expect((await sessionOf(id)).current_stage).toBe("review");
  });

  it(`NEGATIVE: a slot met at the reaction depth ceiling (${MAX_REACTION_DEPTH}) moves nothing, and says why`, async () => {
    const id = await runAt({ stage: "build", outputs: [docSlot] });
    await satisfyOutputsByRef({
      sessionId: id,
      userId: USER,
      ref: { kind: "document", id: doc },
      proposalId: randomUUID(),
      cause: metBy(MAX_REACTION_DEPTH),
    });
    await react(id);
    expect((await sessionOf(id)).current_stage).toBe("build");
    const log = await logOf(id);
    expect(log.map((r) => r.data.code)).toEqual(["chain_depth"]);
  });
});

describe("a check gate reads the same outcomes", () => {
  const stages = [
    STAGES[0]!,
    { key: "ship", name: "Ship", gate: { kind: "check" } },
  ];

  it("held on an output its stage declares, it is released when the output is delivered", async () => {
    const id = await runAt({ stage: "build", outputs: [spec()], stages });
    // Into the gated stage before the Spec is delivered: the gate holds it.
    await updateFocusSession({ sessionId: id, userId: USER, currentStage: "ship" });
    const held = await sessionOf(id);
    expect(held.status).toBe("paused");
    expect(held.metadata).toHaveProperty("checkGate");
    await deliver(id);
    const s = await sessionOf(id);
    expect(s.status).toBe("active");
    expect(s.current_stage).toBe("ship");
    expect(s.metadata).not.toHaveProperty("checkGate");
  });

  it("a session a PERSON paused, with a stale gate record, is never released by its outcomes", async () => {
    const id = await runAt({
      stage: "ship",
      outputs: [spec()],
      stages,
      metadata: {
        checkGate: { stageKey: "ship", fromStage: "build", failing: ["spec"] },
      },
    });
    await setSessionStatus(pgDb as never, {
      sessionId: id,
      from: "active",
      to: "paused",
      actor: { kind: "human", userId: USER },
      hold: { on: "person", ref: `person:${USER}`, reason: "I look first" },
    });
    await deliver(id);
    expect((await sessionOf(id)).status).toBe("paused");
    expect(await logOf(id)).toEqual([]);
  });
});

describe("one step per fact", () => {
  // Build → Review → Publish; Review's own criterion was graded before the
  // run reached it, so Review is met the moment it is entered.
  const stages = [
    STAGES[0]!,
    { key: "review", name: "Review" },
    { key: "publish", name: "Publish" },
  ];
  const criteria = [
    {
      key: "reviewed",
      statement: "Reviewed",
      check: { kind: "human" },
      stageKey: "review",
    },
  ];

  it("a retried job and a next stage already met: one step, one log row", async () => {
    const id = await runAt({ stage: "build", outputs: [spec()], stages, criteria });
    // Graded while the run is on Build: not Build's work, nothing moves.
    await gradeCriterionAsOwner({
      sessionId: id,
      userId: USER,
      criterionKey: "reviewed",
      verdict: "pass",
    });
    expect((await sessionOf(id)).current_stage).toBe("build");
    await deliver(id);
    // The same slot move again (a pg-boss retry): Review is met, but the Spec
    // is not Review's work.
    await react(id);
    const s = await sessionOf(id);
    expect(s.current_stage).toBe("review");
    expect(s.stage_history.map((e) => e.stageKey)).toEqual(["review"]);
    expect((await logOf(id)).map((r) => r.data.code)).toEqual(["applied"]);
  });

  it("a stage with no outputs and no criteria never moves, whatever settles", async () => {
    const id = await runAt({
      stage: "plan",
      outputs: [spec()],
      stages: [
        { key: "plan", name: "Plan" },
        { key: "do", name: "Do" },
      ],
    });
    await deliver(id);
    expect((await sessionOf(id)).current_stage).toBe("plan");
  });

  it("an open ask of the person holds the step (lead default)", async () => {
    const id = await runAt({
      stage: "build",
      outputs: [
        spec(),
        {
          key: "go-ahead",
          kind: "decision",
          label: "Go ahead?",
          owner: "human",
          status: "pending",
          blockedReason: "decision",
          ask: { mode: "confirm", prompt: "Go ahead?" },
          owedSince: new Date().toISOString(),
        },
      ],
    });
    await deliver(id);
    expect((await sessionOf(id)).current_stage).toBe("build");
  });
});

describe("the plan and the write: the write re-checks", () => {
  it("a session paused, or closed, between the plan and the write is not moved", async () => {
    for (const to of ["paused", "closed"] as const) {
      const id = await runAt({
        stage: "build",
        outputs: [spec({ status: "done" })],
      });
      const step = await planStageWorkStep(id, { slotKey: "spec" });
      expect(step).toMatchObject({ kind: "advance", toStage: "review" });
      await setSessionStatus(pgDb as never, {
        sessionId: id,
        from: "active",
        to,
        actor: { kind: "human", userId: USER },
        ...(to === "paused"
          ? { hold: { on: "person", ref: `person:${USER}`, reason: "wait" } }
          : {}),
      });
      const late = await advanceSessionStage(stageMetAdvanceInput(step!, null));
      expect(late).toMatchObject({
        changed: false,
        stale: { expectedStage: "build", currentStage: "build", status: to },
      });
      expect((await sessionOf(id)).current_stage).toBe("build");
    }
  });

  it("the subject-first race: a manual advance between the plan and the write moves the subject once", async () => {
    const post = await seedPost("Briefed");
    const id = await runAt({
      stage: "build",
      outputs: [spec({ status: "done" })],
      subject: post,
    });
    const step = await planStageWorkStep(id, { slotKey: "spec" });
    expect(step).toMatchObject({ kind: "advance", toStage: "review" });
    await updateFocusSession({
      sessionId: id,
      userId: USER,
      currentStage: "review",
      expectedStage: "build",
    });
    const late = await advanceSessionStage(stageMetAdvanceInput(step!, null));
    expect(late).toMatchObject({ changed: false, stale: { currentStage: "review" } });
    expect((await movesOf(post)).map((m) => m.to)).toEqual(["Scripted"]);
    expect((await sessionOf(id)).stage_history.map((e) => e.stageKey)).toEqual([
      "review",
    ]);
  });
});

describe("an agent moving the step back names the stage it read", () => {
  it("refused without expectedStage; nothing written", async () => {
    const id = await runAt({ stage: "review" });
    const res = await updateFocusSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      currentStage: "build",
    });
    expect(res.status).toBe("denied");
    expect((res as { reason: string }).reason).toContain("needs expectedStage");
    expect((await sessionOf(id)).current_stage).toBe("review");
  });
});

describe("a held check gate tells the agent how to get out", () => {
  it("a PR recorded under its own key leaves the declared slot owed: the hold and the nudge name it and say how", async () => {
    const stages = [
      {
        key: "pr-opened",
        name: "PR opened",
        expectedOutputs: [{ kind: "pull_request", label: "Pull request" }],
      },
      { key: "checks", name: "Checks", gate: { kind: "check" } },
    ];
    const id = await runAt({
      stage: "pr-opened",
      stages,
      outputs: [
        {
          key: "pull-request",
          kind: "pull_request",
          label: "Pull request",
          status: "pending",
        },
        // The work-units convention: the PR as a NEW outcome.
        {
          key: "pr-backend-7",
          kind: "pull_request",
          label: "backend#7",
          status: "done",
          ref: { url: "https://github.com/Synap-core/backend/pull/7" },
        },
      ],
    });
    const res = await updateFocusSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      currentStage: "checks",
      expectedStage: "pr-opened",
    });
    expect(res.status).toBe("updated");
    const s = await sessionOf(id);
    expect(s.status).toBe("paused");
    const how =
      'Output "pull-request" is owed: complete it with your PR\'s url (completeOutput "pull-request" with ref.url).';
    const gate = s.metadata.checkGate as { failing: string[]; reason: string };
    expect(gate.failing).toEqual(["pull-request"]);
    expect(gate.reason).toContain(how);
    // What the update_session reply carries (the ONE nudge loader its door calls).
    const row = await (
      h.db as {
        query: {
          focusSessions: {
            findFirst: (q: unknown) => Promise<Record<string, unknown>>;
          };
        };
      }
    ).query.focusSessions.findFirst({
      where: (
        f: { id: unknown },
        { eq }: { eq: (a: unknown, b: unknown) => unknown }
      ) => eq(f.id, id),
    });
    const nudges = await loadSessionNudges({
      session: row as never,
      phase: "update",
      userId: USER,
      agentUserId: AGENT,
    });
    expect(nudges).toMatchObject({
      heldByCheck: { stageKey: "checks", fromStage: "pr-opened" },
    });
    expect(
      (nudges as { hints: string[] }).hints.some((x) => x.includes(how))
    ).toBe(true);
  });
});

/**
 * SHIP A CHANGE, WALKED WITH ITS REAL DEFINITION (the catalog sibling,
 * `synap-app/packages/workspace-templates`): shape → build → pr-opened →
 * checks → merge, the steps advancing by themselves on the grades and the
 * outputs. The deadlock to rule out: the PR output the PR step declares is
 * also named by the MERGE criterion, so a step reading every criterion would
 * hold `pr-opened ⇒ checks` until the merge, which comes after checks.
 */
describe("Ship a change walks shape → merge with its real definition (no deadlock)", () => {
  const CATALOG = fileURLToPath(
    new URL(
      "../../../../../../../synap-app/packages/workspace-templates/src/templates.ts",
      import.meta.url
    )
  );
  type Stage = {
    key: string;
    expectedOutputs?: Array<Record<string, unknown>>;
    criteria?: Array<Record<string, unknown>>;
  };
  const PR = "https://github.com/Synap-core/backend/pull/7";

  async function shipAChange(): Promise<{
    stages: Stage[];
    criteria: unknown[];
  }> {
    const { getWorkspaceTemplate } = (await import(
      /* @vite-ignore */ CATALOG
    )) as {
      getWorkspaceTemplate: (
        slug: string
      ) => { playbooks?: unknown[] } | undefined;
    };
    const pb = (
      getWorkspaceTemplate("builder-workspace")?.playbooks ?? []
    ).find((p) => (p as { name?: string }).name === "Ship a change") as
      { stages: Stage[]; criteria?: unknown[] } | undefined;
    expect(pb, "Ship a change is not in the catalog sibling").toBeDefined();
    return { stages: pb!.stages, criteria: collectPlaybookCriteria(pb!) };
  }

  const grade = (id: string, key: string) =>
    gradeCriterionAsOwner({
      sessionId: id,
      userId: USER,
      criterionKey: key,
      verdict: "pass",
    });
  const keysOf = (criteria: unknown[], stage: string) =>
    (criteria as Array<{ key: string; stageKey?: string; required?: boolean }>)
      .filter((c) => c.stageKey === stage && c.required !== false)
      .map((c) => c.key);
  const prSlotOf = async (id: string) => {
    const [row] = (
      await q<{ expected_outputs: Array<Record<string, unknown>> }>(
        `select expected_outputs from focus_sessions where id = $1`,
        [id]
      )
    ).rows;
    return row!.expected_outputs.find((o) => o.kind === "pull_request")!;
  };

  /** The walk: every step's criteria graded, the PR recorded as `record` says. */
  async function walk(
    def: { stages: Stage[]; criteria: unknown[] },
    record: (id: string) => Promise<void>
  ): Promise<string> {
    const id = await runAt({
      stage: "shape",
      stages: def.stages,
      criteria: def.criteria,
    });
    for (const k of keysOf(def.criteria, "shape")) await grade(id, k);
    expect((await sessionOf(id)).current_stage).toBe("build");
    for (const k of keysOf(def.criteria, "build")) await grade(id, k);
    expect((await sessionOf(id)).current_stage).toBe("pr-opened");
    await record(id);
    for (const k of keysOf(def.criteria, "pr-opened")) await grade(id, k);
    const atChecks = await sessionOf(id);
    expect(atChecks.current_stage).toBe("checks");
    expect(atChecks.status).toBe("active");
    for (const k of keysOf(def.criteria, "checks")) await grade(id, k);
    return id;
  }

  it("as the catalog teaches today: the PR completes the declared slot, its merge criterion names its own outcome", async () => {
    const def = await shipAChange();
    const id = await walk(def, async (sid) => {
      const slot = await prSlotOf(sid);
      const current = (
        await q<{ criteria: unknown[] }>(
          `select criteria from focus_sessions where id = $1`,
          [sid]
        )
      ).rows[0]!.criteria;
      const res = await updateFocusSession({
        sessionId: sid,
        userId: USER,
        agentUserId: AGENT,
        expectedOutputs: [
          { ...slot, ref: { url: PR } },
          {
            key: "pr-backend-7",
            kind: "pull_request",
            label: "backend#7",
            ref: { url: PR },
          },
        ] as never,
        // A run in flight on the old definition carries the unkeyed label
        // slot: completed by its label, as the slot doors match it.
        completeOutput: slot.label as string,
        criteria: [
          ...(current as never[]),
          {
            key: "backend-7-merged",
            statement: "backend#7 is merged",
            check: { kind: "capability", capability: "github_check_pr_merged" },
            outputKey: "pr-backend-7",
          },
        ] as never,
      });
      expect(res.status).toBe("updated");
    });
    const s = await sessionOf(id);
    expect(s.current_stage).toBe("merge");
    expect(s.status).toBe("active");
  });

  it("the declared PR output named by the MERGE step's criterion too (app-bases@fix/catalog-pr-slot-wording): pr-opened ⇒ checks does not wait for the merge", async () => {
    const real = await shipAChange();
    // The companion's three edits, applied to the real definition: the slot
    // keyed `pull-request`, named by the PR step's criterion AND the merge
    // step's.
    const stages = real.stages.map((st) =>
      st.key === "pr-opened"
        ? {
            ...st,
            expectedOutputs: (st.expectedOutputs ?? []).map((o) => ({
              ...o,
              key: "pull-request",
            })),
          }
        : st
    );
    const criteria = (real.criteria as Array<Record<string, unknown>>).map(
      (c) =>
        c.key === "pr-opened" || c.key === "merged"
          ? { ...c, outputKey: "pull-request" }
          : c
    );
    const id = await walk({ stages, criteria }, async (sid) => {
      const slot = await prSlotOf(sid);
      expect(slot.key).toBe("pull-request");
      const res = await updateFocusSession({
        sessionId: sid,
        userId: USER,
        agentUserId: AGENT,
        expectedOutputs: [{ ...slot, ref: { url: PR } }] as never,
        completeOutput: "pull-request",
      });
      expect(res.status).toBe("updated");
    });
    const s = await sessionOf(id);
    expect(s.current_stage).toBe("merge");
    expect(s.status).toBe("active");
  });
});
