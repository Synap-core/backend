/**
 * A STATUS MOVE GOES THROUGH THE STAGE GATE IT WOULD WALK (finding 8f2dee79).
 *
 * Live (8 Nov 2026, session 03a2bf4f, playbook "Win a deal"): an agent moved a
 * deal draft → proposed through the entity door. The move landed, the follow
 * then entered the human-gated stage "Send proposal" and only THEN filed its
 * gate; the check gate of the skipped stage "Write proposal" was never asked.
 *
 * Through the REAL status door (`moveStatus`), the REAL gate plan
 * (`subject-move-gate.ts` → `refuseAgentGateBypass`), the REAL advance door
 * (`advanceSessionStage` → `applyStageGateOnAdvance`, the pause, `onFail`),
 * the REAL process loader, the REAL follow (`syncProcessOnEvent`) and the
 * REAL stage-gate approve executor, on one PGlite. Each row rules something
 * out:
 *  - an agent's move into a HUMAN-gated status files the gate and writes no
 *    status; the gate's approval writes it (a door that wrote first fails);
 *  - an agent's move that SKIPS a gated stage is refused, nothing changes
 *    (a door with no refusal moves the deal and the run);
 *  - an agent's move INTO a check-gated status whose criteria fail is refused
 *    and the run goes back to its `onFail` stage; one whose criteria pass
 *    moves (a gate that refused everything fails the second);
 *  - a move into an UNGATED owned status still moves and the session follows;
 *  - a PERSON's move is the person deciding: it moves, even past gates;
 *  - the gate proposal names the stage and the thing, through the title door.
 *
 * Stubbed, and why: governance (`checkPermissionOrPropose` /
 * `previewPermissionDecision` answer "execute": the ladder has its own
 * suites, the holes this guards live behind its grant), the gate proposal's
 * notification fan-out (`createEventBackedProposal` writes the row as the real
 * one stores it: data + summary), the check evaluator (`evaluateSession`
 * answers the criteria each test sets), post-commit delivery, PGlite is one
 * connection.
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
    /** The left stage's criterion verdicts the check evaluator reports. */
    evaluations: [] as Array<{ criterionKey: string; verdict: string }>,
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
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
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
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
  previewPermissionDecision: async () => ({ decision: "execute" }),
}));
vi.mock("../../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async (p: {
    targetType: string;
    targetId: string;
    proposalType: string;
    summary?: string;
    data: Record<string, unknown>;
  }) => {
    const id = randomUUID();
    await h.client!.query(
      `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_at, updated_at)
       values ($1, 'pending', $2, $3, $4, $5::jsonb, now(), now())`,
      [
        id,
        p.proposalType,
        p.targetType,
        p.targetId,
        JSON.stringify({ ...p.data, summary: p.summary }),
      ]
    );
    return { proposal: { id } };
  },
}));
vi.mock("../evaluations/evaluate.js", () => ({
  evaluateSession: async () => ({
    status: "evaluated",
    criteria: [{ key: "qualified", required: true, stageKey: "qualify" }],
    evaluations: h.evaluations,
  }),
}));
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));

import { pgliteAllTablesDdl } from "../../../__tests__/pglite-ddl.js";
import { moveStatus } from "../../lifecycle/move-status.js";
import { advanceSessionStage } from "../advance-stage.js";
import { registerPlaybookStageGateExecutors } from "../../../routers/proposals/executors/playbook-stage-gate.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { extractProposalName } from "../../proposals/fingerprint.js";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { syncProcessOnEvent } from "@synap/jobs/utils/process-sync.js";
import { registerStageAdvancer } from "@synap/jobs/utils/stage-advance.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const AGENT = randomUUID();
const DEAL = randomUUID();
const STAGE_DEF = randomUUID();

const AS_AGENT = {
  kind: "agent" as const,
  userId: USER,
  agentUserId: AGENT,
};
const AS_PERSON = { kind: "human" as const, userId: USER };

/** "Win a deal", trimmed to the shape of the live walk. */
const STAGES = [
  { key: "qualify", name: "Qualify", subjectStatus: "draft" },
  {
    key: "write",
    name: "Write proposal",
    subjectStatus: "writing",
    gate: { kind: "check" },
    onFail: { toStage: "qualify" },
  },
  {
    key: "send",
    name: "Send proposal",
    subjectStatus: "proposed",
    gate: { kind: "human" },
  },
  { key: "follow", name: "Follow up", subjectStatus: "following" },
];

async function seedDeal(status: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, status, status_category, properties, created_at, updated_at)
     values ($1, $2, 'deal', $3, 'EU data residency deal', null, $4, 'open', $5::jsonb, now(), now())`,
    [id, USER, DEAL, status, JSON.stringify({ commercialStage: status })]
  );
  return id;
}

/** An active session about the deal, following "Win a deal" at `stage`. */
async function sessionAt(dealId: string, stage: string): Promise<string> {
  const playbookId = randomUUID();
  const subjectProfile = { profileSlug: "deal" };
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, subject_profile, version, status, created_at, updated_at)
     values ($1, null, $2, 'Win a deal', 'Win it', 'is-agent',
             $3::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $4::jsonb, 1, 'active', now(), now())`,
    [playbookId, USER, JSON.stringify(STAGES), JSON.stringify(subjectProfile)]
  );
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, playbook_id, subject_entity_id, current_stage, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Win the EU deal', 'Win the EU deal', 'active', 'playbook', $3, $4, $5,
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
    [id, USER, playbookId, dealId, stage]
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

const sessionOf = async (id: string) =>
  (
    await q<{ status: string; current_stage: string | null }>(
      `select status, current_stage from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0];

const gatesOf = async (sessionId: string) =>
  (
    await q<{ id: string; data: Record<string, unknown> }>(
      `select id, data from proposals where target_id = $1 and status = 'pending'
         and data ->> 'changeType' = 'stage_gate'`,
      [sessionId]
    )
  ).rows;

/** Feed the deal's latest transition to the REAL follow, as the trigger hop does. */
async function follow(dealId: string, to: string) {
  const [row] = (
    await q<{ transition: Record<string, unknown> }>(
      `select transition from lifecycle_transition_outbox
        where transition->>'subjectId' = $1 and transition->>'to' = $2
        order by created_at desc limit 1`,
      [dealId, to]
    )
  ).rows;
  expect(row).toBeDefined();
  const t = row!.transition;
  return syncProcessOnEvent({
    eventType: "entity.transition.completed",
    subjectId: dealId,
    userId: USER,
    producerAgentUserId: AGENT,
    data: { ...t, lifecycleProfile: t.role ?? t.profileSlug },
  });
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
     values ($1, 'deal', 'Deal', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now())`,
    [DEAL]
  );
  await q(
    `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
     values ($1, 'commercialStage', 'enum', $2::jsonb, now(), now())`,
    [
      STAGE_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "draft", label: "Draft", category: "open" },
          { key: "writing", label: "Writing", category: "active" },
          { key: "proposed", label: "Proposed", category: "active" },
          { key: "following", label: "Following up", category: "active" },
          { key: "won", label: "Won", category: "done" },
        ],
      }),
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle)
     values ($1, $2, true)`,
    [DEAL, STAGE_DEF]
  );
  registerPlaybookStageGateExecutors();
  // apps/api fills this slot at boot: the follow advances through the door.
  registerStageAdvancer((input) => advanceSessionStage(input));
}, 120_000);

beforeEach(() => {
  h.evaluations = [];
});

describe("an agent's move into a HUMAN-gated status goes through the gate", () => {
  it("files the gate BEFORE any status is written; the approval writes it", async () => {
    const deal = await seedDeal("writing");
    const sessionId = await sessionAt(deal, "write");

    const res = await moveStatus({
      entityId: deal,
      property: "commercialStage",
      expectedFrom: "writing",
      to: "proposed",
      actor: AS_AGENT,
    });

    expect(res).toMatchObject({
      status: "proposed",
      proposalType: "playbook.stage_gate",
      stageGate: { sessionId, stageKey: "send" },
    });
    // The thing did not move: the gate holds IT, not only the session.
    expect(await statusOf(deal)).toBe("writing");
    expect(await sessionOf(sessionId)).toMatchObject({
      status: "paused",
      current_stage: "send",
    });
    const [gate] = await gatesOf(sessionId);
    expect(gate).toBeDefined();
    expect(gate!.id).toBe((res as { proposalId: string }).proposalId);

    // A person approves the gate: the status is written as the approver.
    const executor = proposalExecRegistry.resolveExact(
      "focus_session/playbook.stage_gate"
    )!;
    await executor.execute({
      proposal: {
        id: gate!.id,
        targetId: sessionId,
        workspaceId: null,
        projectId: null,
        subjectUserId: USER,
        data: gate!.data,
        targetType: "focus_session",
        proposalType: "playbook.stage_gate",
      },
      payload: null,
      userId: USER,
      input: { proposalId: gate!.id },
      deps: {
        reportProposalOutcome: () => undefined,
        emitProposalReviewed: () => undefined,
        emitSideEffects: () => undefined,
        notify: async () => undefined,
      },
    } as never);
    expect(await statusOf(deal)).toBe("proposed");
    expect((await sessionOf(sessionId))?.status).toBe("active");
  });

  it("the gate is titled by the stage and the thing, through the title door", async () => {
    const deal = await seedDeal("writing");
    const sessionId = await sessionAt(deal, "write");
    await moveStatus({
      entityId: deal,
      to: "proposed",
      actor: AS_AGENT,
    });
    const [gate] = await gatesOf(sessionId);
    expect(gate!.data.targetName).toBe(
      "Send proposal for EU data residency deal"
    );
    // The stored summary (the read door, the push) …
    expect(gate!.data.summary).toBe(
      "Approve stage: Send proposal for EU data residency deal"
    );
    // … and the derivation every other surface runs (status facts, the
    // continuation packet, the closing report), never "Stage gate Job".
    expect(
      buildObjectActionTitle({
        action: "playbook.stage_gate",
        objectKind: "focus_session",
        objectName: extractProposalName(gate!.data) ?? null,
      })
    ).toBe("Approve stage: Send proposal for EU data residency deal");
  });
});

describe("an agent's move that SKIPS a gated stage is refused", () => {
  it("draft → proposed from Qualify walks past Write proposal: nothing changes", async () => {
    const deal = await seedDeal("draft");
    const sessionId = await sessionAt(deal, "qualify");

    const res = await moveStatus({
      entityId: deal,
      expectedFrom: "draft",
      to: "proposed",
      actor: AS_AGENT,
    });

    expect(res).toMatchObject({
      status: "refused",
      code: "STAGE_GATE",
      sessionId,
    });
    expect((res as { reason: string }).reason).toContain(
      'would skip the gated stage "Write proposal"'
    );
    expect(await statusOf(deal)).toBe("draft");
    expect(await sessionOf(sessionId)).toMatchObject({
      status: "active",
      current_stage: "qualify",
    });
    expect(await gatesOf(sessionId)).toHaveLength(0);
  });
});

describe("an agent's move INTO a check-gated status", () => {
  it("is refused when the left stage's criteria fail, and the run goes back to onFail", async () => {
    const deal = await seedDeal("draft");
    const sessionId = await sessionAt(deal, "qualify");

    const res = await moveStatus({
      entityId: deal,
      to: "writing",
      actor: AS_AGENT,
    });

    expect(res).toMatchObject({
      status: "refused",
      code: "STAGE_GATE",
      sessionId,
    });
    expect((res as { reason: string }).reason).toContain(
      "whose check did not pass (qualified)"
    );
    expect(await statusOf(deal)).toBe("draft");
    expect(await sessionOf(sessionId)).toMatchObject({
      status: "active",
      current_stage: "qualify",
    });
  });

  it("moves when the left stage's criteria pass, and the stage stands", async () => {
    h.evaluations = [{ criterionKey: "qualified", verdict: "pass" }];
    const deal = await seedDeal("draft");
    const sessionId = await sessionAt(deal, "qualify");

    const res = await moveStatus({
      entityId: deal,
      to: "writing",
      actor: AS_AGENT,
    });

    expect(res.status).toBe("moved");
    expect(await statusOf(deal)).toBe("writing");
    expect(await sessionOf(sessionId)).toMatchObject({
      status: "active",
      current_stage: "write",
    });
  });
});

describe("a move into an UNGATED owned status still moves", () => {
  it("the status lands and the session follows it", async () => {
    const deal = await seedDeal("proposed");
    const sessionId = await sessionAt(deal, "send");

    const res = await moveStatus({
      entityId: deal,
      to: "following",
      actor: AS_AGENT,
    });
    expect(res.status).toBe("moved");
    expect(await statusOf(deal)).toBe("following");

    await follow(deal, "following");
    expect(await sessionOf(sessionId)).toMatchObject({
      status: "active",
      current_stage: "follow",
    });
  });
});

describe("a PERSON's move is the person deciding", () => {
  it("moves, even past the gated stages (as a person's session advance does)", async () => {
    const deal = await seedDeal("draft");
    const sessionId = await sessionAt(deal, "qualify");

    const res = await moveStatus({
      entityId: deal,
      to: "proposed",
      actor: AS_PERSON,
    });

    expect(res.status).toBe("moved");
    expect(await statusOf(deal)).toBe("proposed");
    // The gate plan never ran: the run is untouched until the follow.
    expect(await sessionOf(sessionId)).toMatchObject({
      status: "active",
      current_stage: "qualify",
    });
  });
});
