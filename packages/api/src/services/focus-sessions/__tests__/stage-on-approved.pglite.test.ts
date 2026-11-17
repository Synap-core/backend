/**
 * REACHED ON APPROVAL (decision D2) — a stage's `onApproved` on PGlite,
 * through the REAL status door (`moveStatus`: target, write floor, the
 * lifecycle's own governance, the transition outbox) and the REAL governance
 * (`checkPermissionOrPropose`; only the `focus_session` gate is stubbed), the
 * REAL process loader (the run's frozen definition) and the REAL update door
 * for the advance case. Each row rules something out:
 *  - a gate pass writes the stage left's reached status, THEN the gated
 *    stage's entered one, both named with the session (not the reverse, not
 *    one of them);
 *  - a humanOnly reached status is WRITTEN when a person approves (founder
 *    default c), and PROPOSED when an agent's approval reaches it — the same
 *    call with only the approver changed;
 *  - a stage's declared outputs all delivered reach its status; one still
 *    owed reaches nothing;
 *  - an UNGATED advance out of a stage with no outputs reaches nothing (the
 *    rule's third case: no signal, no write);
 *  - approval signal 1 is ONE built-in reaction (decision D1, review
 *    6bf3101d M2), not a call from the doors: the REAL settle doors
 *    (`satisfyPullRequestByMerge`, `satisfyClaimsByEvidence`,
 *    `attestExpectedOutput`, and default 3's `satisfyOutputsByRef` — M2b)
 *    owe the slot's move; the REAL reactor (`handleReactions`) runs the rule
 *    `builtin:approved-output-reaches-status` on it, and the subject reaches
 *    the stage's status with the reaction's `cause` — also when the run
 *    already moved on; a merge of another pull request, or a stage still
 *    owed an output, reaches nothing; a humanOnly status is written as the
 *    PERSON who attested, and proposed when no person approved.
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
import { updateFocusSession } from "../update-session.js";
import {
  writeGatePassStatuses,
  writeStageReachedStatus,
} from "../stage-subject-status.js";
import {
  attestExpectedOutput,
  satisfyClaimsByEvidence,
  satisfyOutputsByRef,
  satisfyPullRequestByMerge,
} from "../satisfy-expected-output.js";
import { parsePullRequestRef } from "@synap-core/types";
import { handleReactions } from "@synap/jobs/workers/reactions.js";
import { registerReactionEffect } from "@synap/jobs/utils/reaction-effects.js";
import { OUTCOME_MET_REACTION_ID } from "@synap/jobs/utils/reactions.js";
import { reachStageStatusReactionEffect } from "../../reactions/reach-stage-status-effect.js";

// apps/api fills the effect's slot at boot; here, once.
registerReactionEffect(reachStageStatusReactionEffect);
const REACH = "builtin:approved-output-reaches-status";

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

/** Produce Content, its D2 shape (plus a humanOnly "approved" reach). */
const STAGES = [
  { key: "brief", name: "Brief", onApproved: "Briefed" },
  {
    key: "script",
    name: "Script",
    onApproved: "Scripted",
    expectedOutputs: [{ kind: "document", label: "Script" }],
  },
  {
    key: "draft",
    name: "Draft",
    subjectStatus: "In Draft",
    gate: { kind: "human" },
  },
  { key: "review", name: "Review", onApproved: "approved" },
  // Ungated here: an agent reaching `approved` must meet GOVERNANCE, not a
  // gate (the gate route has its own suite, subject-move-gate).
  { key: "publish", name: "Publish" },
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

/** A live run on `subject`, standing at `stage`, frozen on STAGES. */
async function runOn(
  subject: string,
  stage: string,
  expectedOutputs: unknown[] = [],
  stages: readonly unknown[] = STAGES
): Promise<{
  id: string;
  playbookId: string;
  subjectEntityId: string;
  workspaceId: null;
}> {
  const subjectProfile = { profileSlug: "post" };
  const playbookId = randomUUID();
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, subject_profile, version, status, created_at, updated_at)
     values ($1, null, $2, 'Produce Content', 'Make it', 'is-agent',
             $3::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $4::jsonb, 1, 'active', now(), now())`,
    [playbookId, USER, JSON.stringify(stages), JSON.stringify(subjectProfile)]
  );
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, playbook_id, subject_entity_id, current_stage, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Make it', 'Make the post', 'active', 'playbook', $3, $4, $5,
             $6::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
    [id, USER, playbookId, subject, stage, JSON.stringify(expectedOutputs)]
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
  return { id, playbookId, subjectEntityId: subject, workspaceId: null };
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string | null }>(
      `select status from entities where id = $1`,
      [id]
    )
  ).rows[0]?.status;

/** The moves the door recorded for `id`, in order: [to, sessionId]. */
const movesOf = async (id: string) =>
  (
    await q<{ to: string; sid: string | null }>(
      `select transition->>'to' as "to", transition->>'sessionId' as sid
         from lifecycle_transition_outbox
        where coalesce(transition->>'subjectId', transition->>'entityId') = $1
        order by created_at`,
      [id]
    )
  ).rows.map((r) => [r.to, r.sid]);

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
          { key: "Idea", label: "Idea", category: "open" },
          { key: "Briefed", label: "Briefed", category: "active" },
          { key: "Scripted", label: "Scripted", category: "active" },
          { key: "In Draft", label: "In Draft", category: "active" },
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

describe("a gate pass: the stage left reaches its status, THEN the gated stage's", () => {
  it("Scripted, then In Draft, both named with the session", async () => {
    const post = await seedPost("Briefed");
    const session = await runOn(post, "draft");
    const out = await writeGatePassStatuses({
      session,
      gatedStage: "draft",
      fromStage: "script",
      userId: USER,
    });
    expect(out.reached).toMatchObject({ status: "written", value: "Scripted" });
    expect(out.entered).toMatchObject({ status: "written", value: "In Draft" });
    expect(await statusOf(post)).toBe("In Draft");
    expect(await movesOf(post)).toEqual([
      ["Scripted", session.id],
      ["In Draft", session.id],
    ]);
  });

  it("a subject already at the gated stage's status is not dragged back to the stage left's", async () => {
    const post = await seedPost("In Draft");
    const session = await runOn(post, "draft");
    const out = await writeGatePassStatuses({
      session,
      gatedStage: "draft",
      fromStage: "script",
      userId: USER,
    });
    expect(out.reached).toEqual({ status: "skipped", reason: "subject_ahead" });
    expect(out.entered).toEqual({ status: "skipped", reason: "already_set" });
    expect(await movesOf(post)).toEqual([]);
  });
});

describe("a humanOnly reached status (founder default c)", () => {
  it("a PERSON's approval WRITES it — never a second proposal", async () => {
    const post = await seedPost("In Draft");
    const session = await runOn(post, "review");
    const out = await writeStageReachedStatus({
      session,
      stageKey: "review",
      signal: "gate_passed",
      approver: { kind: "person", userId: USER },
    });
    expect(out).toMatchObject({ status: "written", value: "approved" });
    expect(await statusOf(post)).toBe("approved");
  });

  it("NEGATIVE: the same reach by an AGENT's approval is PROPOSED to the person", async () => {
    const post = await seedPost("In Draft");
    const session = await runOn(post, "review");
    const out = await writeStageReachedStatus({
      session,
      stageKey: "review",
      signal: "output_approved",
      approver: { kind: "agent", userId: USER, agentUserId: AGENT },
    });
    expect(out).toMatchObject({ status: "proposed", value: "approved" });
    expect(await statusOf(post)).toBe("In Draft");
  });
});

describe("no signal, no write (the rule's third case)", () => {
  it("an UNGATED advance out of a stage with no outputs reaches nothing", async () => {
    const post = await seedPost("Idea");
    const session = await runOn(post, "brief");
    const res = await updateFocusSession({
      sessionId: session.id,
      userId: USER,
      currentStage: "script",
    });
    expect(res.status).toBe("updated");
    // brief's onApproved (Briefed) is never written by entering script, and
    // script enters no status of its own.
    expect(await statusOf(post)).toBe("Idea");
    expect(await movesOf(post)).toEqual([]);
  });
});

/**
 * Fix a finding's `merged` stage, its D2 shape (with a post status standing in
 * for `fixed`): a REQUIRED pull request output, reached when that pull request
 * merges (or a claim with its own url is evidenced).
 */
const PR_URL = "https://github.com/Synap-core/backend/pull/4242";
const MERGE_STAGES = [
  { key: "fix", name: "Fix it", subjectStatus: "Briefed" },
  {
    key: "merged",
    name: "Fix merged",
    onApproved: "Scripted",
    expectedOutputs: [{ kind: "pull_request", label: "Merged fix" }],
  },
  { key: "verified", name: "Live and verified" },
];
const prSlot = (extra: Record<string, unknown> = {}) => ({
  kind: "pull_request",
  label: "Merged fix",
  status: "pending",
  ref: { url: PR_URL },
  ...extra,
});

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
  const out = { applied: 0, proposed: 0, skipped: 0 };
  for (const r of rows) {
    const one = await handleReactions({ transitionId: r.id });
    out.applied += one.applied;
    out.proposed += one.proposed;
    out.skipped += one.skipped;
  }
  return out;
}

/** The cause on each move of `id`: the reaction that made it. */
const causesOf = async (id: string) =>
  (
    await q<{ rid: string | null }>(
      `select transition->'cause'->>'reactionId' as rid
         from lifecycle_transition_outbox
        where coalesce(transition->>'subjectId', transition->>'entityId') = $1
        order by created_at`,
      [id]
    )
  ).rows.map((r) => r.rid);

describe("approval signal 1 is ONE built-in reaction: the doors owe the slot's move, the reactor reaches the stage", () => {
  it("a recorded MERGE of the slot's pull request reaches it, the move naming the rule", async () => {
    const post = await seedPost("Briefed");
    const session = await runOn(post, "merged", [prSlot()], MERGE_STAGES);
    const out = await satisfyPullRequestByMerge({
      sessionId: session.id,
      userId: USER,
      pr: parsePullRequestRef(PR_URL)!,
    });
    expect(out.satisfied.map((x) => x.label)).toEqual(["Merged fix"]);
    // The door itself moves nothing on the subject: the reactor does.
    expect(await statusOf(post)).toBe("Briefed");
    expect(await react(session.id)).toMatchObject({ applied: 1 });
    expect(await statusOf(post)).toBe("Scripted");
    expect(await movesOf(post)).toEqual([["Scripted", session.id]]);
    expect(await causesOf(post)).toEqual([REACH]);
  });

  it("the run already moved on to the next stage: the merge still reaches the stage whose work it was", async () => {
    const post = await seedPost("Briefed");
    const session = await runOn(post, "verified", [prSlot()], MERGE_STAGES);
    await satisfyPullRequestByMerge({
      sessionId: session.id,
      userId: USER,
      pr: parsePullRequestRef(PR_URL)!,
    });
    await react(session.id);
    expect(await statusOf(post)).toBe("Scripted");
    expect(await movesOf(post)).toEqual([["Scripted", session.id]]);
  });

  it("claim EVIDENCE (the slot claimed done with its own url) reaches it", async () => {
    const post = await seedPost("Briefed");
    const session = await runOn(
      post,
      "merged",
      [prSlot({ claimedDone: true })],
      MERGE_STAGES
    );
    const out = await satisfyClaimsByEvidence({
      sessionId: session.id,
      userId: USER,
    });
    expect(out.satisfied.map((x) => x.label)).toEqual(["Merged fix"]);
    await react(session.id);
    expect(await statusOf(post)).toBe("Scripted");
  });

  it("M2b: an outcome DEFAULT 3 meets by its ref reaches its stage (the move it made chains)", async () => {
    const post = await seedPost("Briefed");
    const doc = randomUUID();
    const session = await runOn(
      post,
      "merged",
      [
        {
          kind: "document",
          label: "Merged fix",
          status: "pending",
          ref: { kind: "document", id: doc },
        },
      ],
      [
        MERGE_STAGES[0]!,
        {
          ...MERGE_STAGES[1]!,
          expectedOutputs: [{ kind: "document", label: "Merged fix" }],
        },
        MERGE_STAGES[2]!,
      ]
    );
    const fired = randomUUID();
    const out = await satisfyOutputsByRef({
      sessionId: session.id,
      userId: USER,
      ref: { kind: "document", id: doc },
      proposalId: randomUUID(),
      cause: {
        reactionId: OUTCOME_MET_REACTION_ID,
        transitionId: fired,
        chainId: fired,
        depth: 1,
      },
    });
    expect(out.satisfied.map((x) => x.label)).toEqual(["Merged fix"]);
    await react(session.id);
    expect(await statusOf(post)).toBe("Scripted");
    expect(await causesOf(post)).toEqual([REACH]);
  });

  it("a humanOnly status: written as the PERSON whose attestation approved the work", async () => {
    const post = await seedPost("In Draft");
    const session = await runOn(
      post,
      "review",
      [
        {
          kind: "document",
          label: "Final cut",
          status: "pending",
          owner: "human",
        },
      ],
      [
        {
          key: "review",
          name: "Review",
          onApproved: "approved",
          expectedOutputs: [{ kind: "document", label: "Final cut" }],
        },
        { key: "publish", name: "Publish" },
      ]
    );
    const att = await attestExpectedOutput({
      sessionId: session.id,
      userId: USER,
      expectedLabel: "Final cut",
    });
    expect(att.status).toBe("attested");
    expect(await react(session.id)).toMatchObject({ applied: 1, proposed: 0 });
    expect(await statusOf(post)).toBe("approved");
  });

  it("NEGATIVE: the same humanOnly status reached by EVIDENCE (no person) is proposed, not written", async () => {
    const post = await seedPost("In Draft");
    const session = await runOn(
      post,
      "review",
      [
        {
          kind: "document",
          label: "Final cut",
          status: "pending",
          claimedDone: true,
          ref: { url: "https://example.com/cut" },
        },
      ],
      [
        {
          key: "review",
          name: "Review",
          onApproved: "approved",
          expectedOutputs: [{ kind: "document", label: "Final cut" }],
        },
        { key: "publish", name: "Publish" },
      ]
    );
    await satisfyClaimsByEvidence({ sessionId: session.id, userId: USER });
    expect(await react(session.id)).toMatchObject({ applied: 0, proposed: 1 });
    expect(await statusOf(post)).toBe("In Draft");
  });

  it("NEGATIVE: a stage still owed another output reaches nothing", async () => {
    const post = await seedPost("Briefed");
    const stages = [
      MERGE_STAGES[0]!,
      {
        ...MERGE_STAGES[1]!,
        expectedOutputs: [
          { kind: "pull_request", label: "Merged fix" },
          { kind: "document", label: "Release note" },
        ],
      },
      MERGE_STAGES[2]!,
    ];
    const session = await runOn(
      post,
      "merged",
      [
        prSlot(),
        { kind: "document", label: "Release note", status: "pending" },
      ],
      stages
    );
    await satisfyPullRequestByMerge({
      sessionId: session.id,
      userId: USER,
      pr: parsePullRequestRef(PR_URL)!,
    });
    expect(await react(session.id)).toMatchObject({ applied: 0, proposed: 0 });
    expect(await statusOf(post)).toBe("Briefed");
  });

  it("NEGATIVE: a merge of ANOTHER pull request closes nothing and reaches nothing", async () => {
    const post = await seedPost("Briefed");
    const session = await runOn(post, "merged", [prSlot()], MERGE_STAGES);
    const out = await satisfyPullRequestByMerge({
      sessionId: session.id,
      userId: USER,
      pr: parsePullRequestRef(
        "https://github.com/Synap-core/backend/pull/4243"
      )!,
    });
    expect(out.satisfied).toEqual([]);
    await react(session.id);
    expect(await statusOf(post)).toBe("Briefed");
    expect(await movesOf(post)).toEqual([]);
  });

  it("NEGATIVE: a subject already past the stage is never moved back by a late merge", async () => {
    const post = await seedPost("In Draft");
    const stages = [
      ...MERGE_STAGES.slice(0, 2),
      { key: "verified", name: "Live and verified", subjectStatus: "In Draft" },
    ];
    const session = await runOn(post, "verified", [prSlot()], stages);
    await satisfyPullRequestByMerge({
      sessionId: session.id,
      userId: USER,
      pr: parsePullRequestRef(PR_URL)!,
    });
    await react(session.id);
    expect(await statusOf(post)).toBe("In Draft");
    expect(await movesOf(post)).toEqual([]);
  });
});
