/**
 * TRACK STAGES on PGlite (0274, wave A1) — the REAL tracks service, the REAL
 * `createFocusSession`, the REAL `focus_session/create` + `track/*` executors,
 * the REAL gate core with the track adapter's measurement. Rows are read back
 * from PGlite (reachability, not shape).
 *
 *   M1 a session records the track stage it was filed at (default / explicit /
 *      refused / re-validated at approval);
 *   M2 `startStageSession` — idempotent, governed (an agent proposes), and the
 *      advance result's `offer`;
 *   M3 dedup includes track + stage;
 *   M4 track params (start, update, replay) and the owed slot for a missing
 *      required method param;
 *   M5 stage history (birth seed, append, re-entry);
 *   M6 the track check gate over the sessions filed at the stage being left.
 *
 * Stubbed, only at infrastructure seams: `checkPermissionOrPropose` (proposes
 * for an agent, grants a human), the stage-gate proposal insert, `createLinks`,
 * `emitSideEffects`, the EventRepository append, `ensureSessionChannel`,
 * realtime, `resolveSessionProjectPlacement` (echoes the pin), the blocked-slot
 * guidance read.
 *
 * NOT covered: the tRPC / Hub / MCP wrappers (typecheck only); visibility for
 * a workspace-scoped project (covered by tracks.pglite.test.ts' registry).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  permCalls: [] as Array<Record<string, unknown>>,
  emits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client, {
    schema: {
      focusSessions: actual.focusSessions as never,
      projectTracks: actual.projectTracks as never,
      playbooks: actual.playbooks as never,
      projects: actual.projects as never,
    },
  });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    EventRepository: class {
      async append() {}
    },
    recordSessionSpawn: async () => ({
      linked: true,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async (
      _db: unknown,
      input: { explicitProjectId?: string | null }
    ) => ({ projectId: input.explicitProjectId ?? null }),
  };
});

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.permCalls.push(opts);
    if (opts.agentUserId) {
      return {
        granted: false,
        proposalId: randomUUID(),
        proposalType: `${opts.subjectType}.${opts.action}`,
        summary: "",
        reasoning: "",
        reviewPath: "/open/x",
        reviewUrl: "https://pod/open/x",
      };
    }
    return { granted: true };
  },
  proposedMessageFor: (_t: string, fallback: string) => fallback,
}));

vi.mock("../../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async () => ({
    proposal: { id: randomUUID(), status: "pending" },
  }),
}));
vi.mock("../../links/links-service.js", () => ({
  createLinks: async () => [],
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: async (p: Record<string, unknown>) => {
    h.emits.push(p);
  },
}));
vi.mock("../../focus-sessions/ensure-session-channel.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureSessionChannel: async () => null,
}));
vi.mock("../../../utils/domain-event-bridge.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../focus-sessions/block-guidelines.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  guidanceForBlockedSlots: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  playbooks,
  projects,
  proposals,
  workspaces,
  workspaceMembers,
  users,
  links,
  sessionEvaluations,
} from "@synap/database";
import {
  advanceTrackStage,
  applyTrackParams,
  getTrack,
  loadTrackView,
  loadWrittenTrackView,
  setTrackParams,
  startStageSession,
  startTrack,
} from "../tracks-service.js";
import { createFocusSession } from "../../focus-sessions/create-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { registerTrackExecutors } from "../../../routers/proposals/executors/track.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import type { ProposalExecutorArgs } from "../../../routers/proposals/execution-registry.js";
import { PARAM_SLOT_KIND } from "@synap-core/types/focus-sessions";

const USER = "user-1";
const AGENT = "agent-1";
const PROJECT = randomUUID();
const GATE_PROJECT = randomUUID();
const STAGE_PROJECT = randomUUID();
const METHOD = randomUUID();
const CHECK_METHOD = randomUUID();

const METHOD_PARAMS = [
  { name: "audience", label: "Audience", type: "text", required: true },
  { name: "budget", type: "number" },
];
const STAGES = [
  {
    key: "discover",
    name: "Discover",
    category: "planned",
    goal: "Interview five customers",
    suggestedTasks: ["List prospects"],
    expectedOutputs: [{ kind: "document", label: "Interview notes" }],
    indefinite: false,
  },
  { key: "build", name: "Build", category: "started", goal: "Build the MVP" },
  { key: "ship", name: "Ship", category: "completed" },
];
const CHECK_STAGES = [
  { key: "draft", name: "Draft", category: "planned", goal: "Draft it" },
  {
    key: "audit",
    name: "Audit",
    category: "completed",
    gate: { kind: "check" },
  },
];

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "id"
        ? " default gen_random_uuid()"
        : c.name === "started_at" || c.name === "created_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const human = { userId: USER };
const agent = { userId: USER, agentUserId: AGENT, isHubProtocol: true };

async function execute(
  key: string,
  data: Record<string, unknown>,
  opts: { targetId: string; projectId: string; targetType: string }
) {
  const proposalId = randomUUID();
  await q(
    `insert into proposals (id, status, target_type, target_id, proposal_type, data) values ($1, 'pending', $2, $3, 'create', $4::jsonb)`,
    [proposalId, opts.targetType, opts.targetId, JSON.stringify({ data })]
  );
  const executor = proposalExecRegistry.resolveExact(key);
  if (!executor) throw new Error(`no executor ${key}`);
  return executor.execute({
    proposal: {
      id: proposalId,
      targetType: opts.targetType,
      targetId: opts.targetId,
      proposalType: "create",
      workspaceId: null,
      sessionId: null,
      projectId: opts.projectId,
      subjectUserId: USER,
      correlationId: null,
      agentUserId: AGENT,
      data: { data },
    },
    payload: null,
    userId: USER,
    input: { proposalId },
    ctx: {},
    deps: {
      reportProposalOutcome: () => {},
      emitProposalReviewed: () => {},
    },
  } as unknown as ProposalExecutorArgs);
}

async function sessionRow(id: string) {
  const [row] = (
    await q<{
      track_id: string | null;
      track_stage: string | null;
      goal: string;
      expected_outputs: Array<Record<string, unknown>>;
      status: string;
    }>(
      `select track_id, track_stage, goal, expected_outputs, status from focus_sessions where id = $1`,
      [id]
    )
  ).rows;
  return row!;
}

let trackId: string;
/** A fresh track for M2/M5 (M1/M3 file sessions at every stage of `trackId`). */
let stageTrack: string;

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    users,
    workspaces,
    workspaceMembers,
    links,
    playbooks,
    projects,
    sessionEvaluations,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  // The REAL 0272 + 0274 shape — defaults are what the repo relies on.
  await h.client!.exec(`
    create table project_tracks (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      user_id text not null,
      playbook_id uuid references playbooks(id) on delete set null,
      name text not null,
      definition_snapshot jsonb not null default '{}'::jsonb,
      method_version text not null default '1',
      current_stage text,
      status text not null default 'active',
      params jsonb not null default '{}'::jsonb,
      stage_history jsonb not null default '[]'::jsonb,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index uniq_project_tracks_live_method
      on project_tracks (project_id, playbook_id)
      where status <> 'archived' and playbook_id is not null;
  `);
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values
      ($1, $2, null, 'Launch', 'active'), ($3, $2, null, 'Gated', 'active'),
      ($4, $2, null, 'Staged', 'active')`,
    [PROJECT, USER, GATE_PROJECT, STAGE_PROJECT]
  );
  for (const [id, name, stages] of [
    [METHOD, "Business model", STAGES],
    [CHECK_METHOD, "Audited", CHECK_STAGES],
  ] as const) {
    await q(
      `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, version, executor, status, scope, metadata, created_at, updated_at)
       values ($1, null, $2, $3, 'Do it', $4::jsonb, '{"kind":"none"}', '{}', '[]', $5::jsonb, '[]', 1, 'is-agent', 'active', 'project', '{}', now(), now())`,
      [id, USER, name, JSON.stringify(METHOD_PARAMS), JSON.stringify(stages)]
    );
  }
  registerTrackExecutors();
  registerFocusSessionExecutors();
}, 120_000);

beforeEach(() => {
  h.permCalls.length = 0;
  h.emits.length = 0;
});

describe("M4 params + M5 history at birth", () => {
  it("refuses a mistyped param and an undeclared key before anything is written", async () => {
    await expect(
      startTrack({
        projectId: PROJECT,
        playbookId: METHOD,
        params: { budget: "lots" },
        actor: human,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      startTrack({
        projectId: PROJECT,
        playbookId: METHOD,
        params: { colour: "red" },
        actor: human,
      })
    ).rejects.toThrow(/Unknown param "colour"/);
    const { rows } = await q(`select id from project_tracks`);
    expect(rows).toHaveLength(0);
  });

  it("an agent start carries params on the proposal; the replay stores them", async () => {
    const res = await startTrack({
      projectId: GATE_PROJECT,
      playbookId: CHECK_METHOD,
      params: { budget: "12" },
      actor: agent,
    });
    expect(res.status).toBe("proposed");
    const data = h.permCalls[0]!.data as Record<string, unknown>;
    expect(data.params).toEqual({ budget: 12 });
    await execute("track/create", data, {
      targetId: data.id as string,
      projectId: GATE_PROJECT,
      targetType: "track",
    });
    const [row] = (
      await q<{ params: unknown }>(
        `select params from project_tracks where id = $1`,
        [data.id]
      )
    ).rows;
    expect(row!.params).toEqual({ budget: 12 });
  });

  it("stores coerced answers and seeds the stage history with the first stage", async () => {
    const res = await startTrack({
      projectId: PROJECT,
      playbookId: METHOD,
      params: { budget: "500" },
      actor: human,
    });
    if (res.status === "proposed") throw new Error("unexpected proposal");
    trackId = res.track.id;
    expect(res.track.params).toEqual({ budget: 500 });
    const view = await loadTrackView(res.track, human);
    expect(view.stageHistory).toEqual([
      expect.objectContaining({
        stageKey: "discover",
        fromStage: null,
        actor: USER,
      }),
    ]);
    // Full stage projection (what the snapshot pins) + counted sessions.
    expect(view.stages[0]).toMatchObject({
      key: "discover",
      goal: "Interview five customers",
      suggestedTasks: ["List prospects"],
      expectedOutputs: [{ kind: "document", label: "Interview notes" }],
      indefinite: false,
      sessionCount: 0,
    });
    expect(view.params).toEqual({ budget: 500 });
    // The onboarding form reads the PINNED declaration, not the live method.
    expect(view.declaredParams).toEqual(METHOD_PARAMS);
    await q(`update playbooks set params = '[]'::jsonb where id = $1`, [
      METHOD,
    ]);
    const after = await loadTrackView(res.track, human);
    expect(after.declaredParams).toEqual(METHOD_PARAMS);
    await q(`update playbooks set params = $2::jsonb where id = $1`, [
      METHOD,
      JSON.stringify(METHOD_PARAMS),
    ]);
  });
});

describe("M1 stage stamping + M3 dedup by stage", () => {
  it("defaults to the track's current stage, accepts a pinned stage, refuses an unknown one", async () => {
    const a = await createFocusSession({
      userId: USER,
      trackId,
      goal: "Sketch the pitch",
    });
    if (a.status === "proposed") throw new Error("unexpected proposal");
    expect((await sessionRow(a.session.id)).track_stage).toBe("discover");

    const b = await createFocusSession({
      userId: USER,
      trackId,
      trackStage: "ship",
      goal: "Plan the launch post",
    });
    if (b.status === "proposed") throw new Error("unexpected proposal");
    expect((await sessionRow(b.session.id)).track_stage).toBe("ship");

    await expect(
      createFocusSession({
        userId: USER,
        trackId,
        trackStage: "nope",
        goal: "Anything",
      })
    ).rejects.toThrow(/"nope" is not a stage/);
    await expect(
      createFocusSession({ userId: USER, trackStage: "ship", goal: "x" })
    ).rejects.toThrow(/needs trackId/);
  });

  it("the same goal at two stages is two sessions; at one stage it dedups", async () => {
    const goal = "Review the numbers";
    const first = await createFocusSession({ userId: USER, trackId, goal });
    const again = await createFocusSession({ userId: USER, trackId, goal });
    expect(first.status).toBe("created");
    expect(again.status).toBe("deduped");
    const other = await createFocusSession({
      userId: USER,
      trackId,
      trackStage: "build",
      goal,
    });
    expect(other.status).toBe("created");
    if (other.status === "proposed") throw new Error("unexpected");
    // The other stage's twin is surfaced, never merged.
    expect(
      (other as { candidates?: Array<{ score: number }> }).candidates?.[0]
        ?.score
    ).toBe(1);
  });

  it("the approval replay re-validates the stage: a stage the track does not pin is dropped and reported", async () => {
    const sessionId = randomUUID();
    const out = await execute(
      "focus_session/create",
      { id: sessionId, goal: "Tampered", trackId, trackStage: "bogus" },
      { targetId: sessionId, projectId: PROJECT, targetType: "focus_session" }
    );
    const row = await sessionRow(sessionId);
    expect(row.track_id).toBe(trackId);
    expect(row.track_stage).toBeNull();
    expect(JSON.stringify(out), JSON.stringify(out)).toMatch(
      /Track stage \\"bogus\\" was not applied/
    );
  });
});

describe("the param error sentence is ONE wording on every door", () => {
  it("the approval replay reports a mistyped track param with the same sentence the create door refuses with", async () => {
    await expect(
      createFocusSession({
        userId: USER,
        trackId,
        goal: "Typed answers",
        templateId: null,
        params: { budget: "lots" },
      })
    ).rejects.toThrow('"budget" must be a number — got "lots".');
    const sessionId = randomUUID();
    const out = await execute(
      "focus_session/create",
      {
        id: sessionId,
        goal: "Mistyped",
        trackId,
        trackParams: { budget: "lots" },
      },
      { targetId: sessionId, projectId: PROJECT, targetType: "focus_session" }
    );
    expect(JSON.stringify(out)).toContain(
      'Track params were not applied: \\"budget\\" must be a number — got \\"lots\\".'
    );
  });
});

describe("M2 startStageSession + offer", () => {
  beforeAll(async () => {
    // A FRESH track: M1/M3 above filed sessions at every stage of `trackId`.
    const res = await startTrack({
      projectId: STAGE_PROJECT,
      playbookId: METHOD,
      params: { budget: 500 },
      actor: human,
    });
    if (res.status === "proposed") throw new Error("unexpected proposal");
    stageTrack = res.track.id;
  });

  it("an AGENT proposes focus_session/create carrying the stage and the track's params; approval mints the owed param slot", async () => {
    const res = await startStageSession({ trackId: stageTrack, actor: agent });
    expect(res.status).toBe("proposed");
    const call = h.permCalls.find((c) => c.subjectType === "focus_session")!;
    const data = call.data as Record<string, unknown>;
    expect(data).toMatchObject({
      goal: "Interview five customers",
      trackId: stageTrack,
      trackStage: "discover",
      trackParams: { budget: 500 },
    });
    await execute("focus_session/create", data, {
      targetId: data.id as string,
      projectId: STAGE_PROJECT,
      targetType: "focus_session",
    });
    const row = await sessionRow(data.id as string);
    expect(row.track_stage).toBe("discover");
    expect(
      row.expected_outputs.find((o) => o.kind === PARAM_SLOT_KIND)
    ).toMatchObject({ label: "Answer: Audience", owner: "human" });
  });

  it("is IDEMPOTENT: the open session filed at the stage comes back as `existing`", async () => {
    const again = await startStageSession({
      trackId: stageTrack,
      actor: human,
    });
    expect(again.status).toBe("existing");
    expect(h.permCalls).toHaveLength(0);
  });

  it("RACE: the check is re-run under the stage lock inside the insert — a different goal at an occupied stage is not a second open session", async () => {
    // What a racing second start sees once it holds the lock: the first
    // start's open session at (user, track, stage), with a DIFFERENT goal
    // (so the goal-keyed twin dedup would not catch it). PGlite is one
    // connection, so true concurrency is not reproducible here; this pins the
    // re-check that the lock serializes.
    const res = await createFocusSession({
      userId: USER,
      trackId: stageTrack,
      trackStage: "discover",
      goal: "A completely different goal",
      templateId: null,
      oneOpenPerStage: true,
    });
    expect(res.status).toBe("deduped");
    if (res.status === "proposed") return;
    expect((await sessionRow(res.session.id)).track_stage).toBe("discover");
  });

  it("a human start uses the stage goal, copies its outputs and owes the missing required param", async () => {
    const res = await startStageSession({
      trackId: stageTrack,
      stageKey: "build",
      actor: human,
    });
    expect(res.status).toBe("created");
    if (res.status !== "created") return;
    const row = await sessionRow(res.session.id);
    expect(row).toMatchObject({ track_stage: "build", goal: "Build the MVP" });
    expect(row.expected_outputs.map((o) => o.kind)).toContain(PARAM_SLOT_KIND);
  });

  it("advancing OFFERS the entered stage's session and never starts one", async () => {
    const before = (await q(`select id from focus_sessions`)).rows.length;
    const moved = await advanceTrackStage({
      trackId: stageTrack,
      toStage: "ship",
      actor: human,
    });
    if (moved.status === "proposed") throw new Error("unexpected");
    expect(moved.offer).toEqual({
      stageKey: "ship",
      name: "Ship",
      goal: null,
      suggestedTasks: [],
    });
    expect((await q(`select id from focus_sessions`)).rows.length).toBe(before);
    // An open session already filed at the entered stage ⇒ nothing to offer.
    const back = await advanceTrackStage({
      trackId: stageTrack,
      toStage: "build",
      actor: human,
    });
    if (back.status === "proposed") throw new Error("unexpected");
    expect(back.offer).toBeNull();
  });
});

describe("M5 stage history", () => {
  it("appends every entered stage, re-entries included, in the stage writer's UPDATE", async () => {
    const track = (await getTrack(stageTrack, human))!;
    const keys = (track.stageHistory as Array<{ stageKey: string }>).map(
      (e) => e.stageKey
    );
    expect(keys).toEqual(["discover", "ship", "build"]);
    await advanceTrackStage({
      trackId: stageTrack,
      toStage: "ship",
      actor: human,
    });
    const after = (await getTrack(stageTrack, human))!;
    const history = after.stageHistory as Array<{
      stageKey: string;
      fromStage: string | null;
    }>;
    expect(history.map((e) => e.stageKey)).toEqual([
      "discover",
      "ship",
      "build",
      "ship",
    ]);
    expect(history[3]!.fromStage).toBe("build");
  });

  it("an APPROVED agent advance records the proposing agent as the history actor", async () => {
    const res = await advanceTrackStage({
      trackId: stageTrack,
      toStage: "build",
      actor: agent,
    });
    expect(res.status).toBe("proposed");
    const data = h.permCalls.at(-1)!.data as Record<string, unknown>;
    await execute("track/update", data, {
      targetId: stageTrack,
      projectId: STAGE_PROJECT,
      targetType: "track",
    });
    const history = (await getTrack(stageTrack, human))!.stageHistory as Array<{
      stageKey: string;
      actor: string;
    }>;
    expect(history.at(-1)).toMatchObject({ stageKey: "build", actor: AGENT });
    // Back to where M5 left it, so the counts below read the same stage.
    await advanceTrackStage({
      trackId: stageTrack,
      toStage: "ship",
      actor: human,
    });
  });

  it("a failed stage-count read after a write returns the view WITHOUT counts, never a 500 and never 0", async () => {
    const track = (await getTrack(stageTrack, human))!;
    // A project id Postgres cannot parse makes the count query throw.
    const broken = { ...track, projectId: "not-a-uuid" };
    await expect(loadTrackView(broken, human)).rejects.toThrow();
    const view = await loadWrittenTrackView(broken, human);
    expect(view.id).toBe(stageTrack);
    expect(view.stages.length).toBeGreaterThan(0);
    for (const s of view.stages) expect("sessionCount" in s).toBe(false);
  });

  it("counts sessions per stage on the track view", async () => {
    const view = await loadTrackView(
      (await getTrack(stageTrack, human))!,
      human
    );
    const counts = Object.fromEntries(
      view.stages.map((s) => [s.key, s.sessionCount])
    );
    // One human session at build. The agent-started session at discover is
    // still an undecided agent DRAFT (origin agent, no triage receipt): the
    // project path's default lens hides it, so its stage does not count it.
    expect(counts).toEqual({ discover: 0, build: 1, ship: 0 });
  });

  it("counts the PROJECT PATH's set: my session counts; another member's session and an undecided agent draft are not listed there, so not counted", async () => {
    await q(
      `insert into focus_sessions (id, user_id, goal, status, origin, project_id, track_id, track_stage, criteria, expected_outputs, agent_ids, metadata) values
        ($1, 'user-2', 'Theirs', 'active', 'user', $3, $4, 'discover', '[]'::jsonb, '[]'::jsonb, '{}', '{}'::jsonb),
        ($2, $5, 'Agent draft', 'active', 'agent', $3, $4, 'discover', '[]'::jsonb, '[]'::jsonb, '{}', '{}'::jsonb),
        ($6, $5, 'Mine', 'active', 'human', $3, $4, 'discover', '[]'::jsonb, '[]'::jsonb, '{}', '{}'::jsonb)`,
      [
        randomUUID(),
        randomUUID(),
        STAGE_PROJECT,
        stageTrack,
        USER,
        randomUUID(),
      ]
    );
    const view = await loadTrackView(
      (await getTrack(stageTrack, human))!,
      human
    );
    expect(view.stages.find((s) => s.key === "discover")!.sessionCount).toBe(1);
  });
});

describe("M4 params update", () => {
  it("a human merges answers; an agent proposes track/update and the replay applies it", async () => {
    const done = await setTrackParams({
      trackId,
      params: { audience: "founders" },
      actor: human,
    });
    if (done.status === "proposed") throw new Error("unexpected");
    expect(done.track.params).toEqual({ budget: 500, audience: "founders" });

    const res = await setTrackParams({
      trackId,
      params: { budget: null, audience: "indie devs" },
      actor: agent,
    });
    expect(res.status).toBe("proposed");
    const data = h.permCalls.at(-1)!.data as Record<string, unknown>;
    expect(data.params).toEqual({ budget: null, audience: "indie devs" });
    await execute("track/update", data, {
      targetId: trackId,
      projectId: PROJECT,
      targetType: "track",
    });
    expect((await getTrack(trackId, human))!.params).toEqual({
      audience: "indie devs",
    });
  });
});

describe("M4 params write is a SQL merge, not a whole-bag overwrite", () => {
  it("a write from a STALE read keeps the answer another writer landed in between", async () => {
    const stale = (await getTrack(trackId, human))!;
    // Another writer answers `audience` after `stale` was read…
    await applyTrackParams(stale, { audience: "agencies" }, USER);
    // …then this writer, still holding `stale`, answers `budget` only.
    await applyTrackParams(stale, { budget: "900" }, USER);
    expect((await getTrack(trackId, human))!.params).toEqual({
      audience: "agencies",
      budget: 900,
    });
    // A null clears exactly that key.
    await applyTrackParams(stale, { budget: null }, USER);
    expect((await getTrack(trackId, human))!.params).toEqual({
      audience: "agencies",
    });
  });
});

describe("M6 the track check gate measures the sessions filed at the stage being left", () => {
  let gated: string;

  async function newGatedTrack() {
    await q(
      `update project_tracks set status = 'archived' where project_id = $1`,
      [GATE_PROJECT]
    );
    const res = await startTrack({
      projectId: GATE_PROJECT,
      playbookId: CHECK_METHOD,
      actor: human,
    });
    if (res.status === "proposed") throw new Error("unexpected");
    gated = res.track.id;
  }

  async function fileClosed(criteria: unknown[] = []) {
    const id = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, goal, status, project_id, track_id, track_stage, criteria, expected_outputs, agent_ids, metadata)
       values ($1, $2, 'Drafted', 'closed', $3, $4, 'draft', $5::jsonb, '[]'::jsonb, '{}', '{}'::jsonb)`,
      [id, USER, GATE_PROJECT, gated, JSON.stringify(criteria)]
    );
    return id;
  }

  const CRITERION = {
    key: "reviewed",
    statement: "A peer reviewed it",
    check: { kind: "human" },
  };

  it("HOLDS with a readable reason when no session at the stage is closed", async () => {
    await newGatedTrack();
    const r = await advanceTrackStage({
      trackId: gated,
      toStage: "audit",
      actor: human,
    });
    if (r.status === "proposed") throw new Error("unexpected");
    expect(r).toMatchObject({ paused: true, check: { passed: false } });
    expect(r.check!.reason).toMatch(/No session was filed at stage "draft"/);
  });

  it("HOLDS on a closed session whose criteria do not pass, naming the criterion", async () => {
    await newGatedTrack();
    await fileClosed([CRITERION]);
    const r = await advanceTrackStage({
      trackId: gated,
      toStage: "audit",
      actor: human,
    });
    if (r.status === "proposed") throw new Error("unexpected");
    expect(r.check).toMatchObject({ passed: false, failing: ["reviewed"] });
    expect(r.track.status).toBe("paused");
  });

  it("never names another member's session: the reason is a COUNT, in the result and in the stored metadata", async () => {
    await newGatedTrack();
    // User B shares the project; B's session holds the gate. User A advances.
    const SECRET = "B private: salary negotiation with Dana";
    await q(
      `insert into focus_sessions (id, user_id, title, goal, status, project_id, track_id, track_stage, criteria, expected_outputs, agent_ids, metadata)
       values ($1, 'user-2', $2, $3, 'closed', $4, $5, 'draft', $6::jsonb, '[]'::jsonb, '{}', '{}'::jsonb)`,
      [
        randomUUID(),
        SECRET,
        `${SECRET} (goal)`,
        GATE_PROJECT,
        gated,
        JSON.stringify([CRITERION]),
      ]
    );
    const r = await advanceTrackStage({
      trackId: gated,
      toStage: "audit",
      actor: human,
    });
    if (r.status === "proposed") throw new Error("unexpected");
    // B's session is still COUNTED: it holds the gate for A.
    expect(r.check).toMatchObject({ passed: false, failing: ["reviewed"] });
    expect(r.check!.reason).toBe(
      '1 session at stage "draft" closed without meeting its criteria.'
    );
    const [row] = (
      await q<{ metadata: unknown }>(
        `select metadata from project_tracks where id = $1`,
        [gated]
      )
    ).rows;
    const stored = JSON.stringify(row!.metadata);
    expect(stored).toContain("closed without meeting");
    expect(stored).not.toContain("salary");
    expect(JSON.stringify(r)).not.toContain("salary");
  });

  it("PASSES once every closed session there passes its criteria", async () => {
    await newGatedTrack();
    const id = await fileClosed([CRITERION]);
    await q(
      `insert into session_evaluations (id, session_id, user_id, criterion_key, attempt, verdict, evaluator_kind, evidence, created_at)
       values (gen_random_uuid(), $1, $2, 'reviewed', 1, 'pass', 'human', '{}'::jsonb, now())`,
      [id, USER]
    );
    await fileClosed([]); // no criteria: passes on being closed
    const r = await advanceTrackStage({
      trackId: gated,
      toStage: "audit",
      actor: human,
    });
    if (r.status === "proposed") throw new Error("unexpected");
    expect(r).toMatchObject({ paused: false, check: { passed: true } });
    expect(r.track.status).toBe("active");
  });
});
