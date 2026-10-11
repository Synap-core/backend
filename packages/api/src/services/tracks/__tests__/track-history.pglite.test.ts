/**
 * TRACK HISTORY on PGlite (U5 BE5) — the REAL tracks service, the REAL gate
 * core (check measurement over filed sessions), the REAL `tracks.history`
 * read (`readTrackHistory`) and the REAL track view projection.
 *
 * The EventRepository append is the one seam: it writes the receipt into this
 * suite's `events` table — the very rows the history reads pause/resume from.
 *
 * Asserts the VALUE arrives (reachability): the check verdict a gate measured
 * reaches the timeline, a mover's NAME reaches the view and the history, the
 * hold's reason reaches `TrackView.checkGate`, a reviewer's note reaches the
 * decision.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  permCalls: [] as Array<Record<string, unknown>>,
  emits: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
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
    // The receipt every track write emits — persisted, as in production.
    EventRepository: class {
      async append(e: {
        id: string;
        type: string;
        subjectId: string;
        subjectType: string;
        data: unknown;
        userId: string;
        timestamp: Date;
      }) {
        await client.query(
          `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            e.id,
            e.timestamp,
            e.type,
            e.subjectId,
            e.subjectType,
            JSON.stringify(e.data),
            e.userId,
          ]
        );
      }
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
vi.mock("../../../notifications/NotificationService.js", () => ({
  NotificationService: {
    create: async (input: Record<string, unknown>) => {
      h.notifications.push(input);
      return randomUUID();
    },
  },
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
// Pass-through spy: the adoption probe reads the database package's own
// handle, not this suite's PGlite, so the step door's choice is asserted at
// the seam (the arguments it hands createFocusSession).
vi.mock("../../focus-sessions/create-session.js", async (orig) => {
  const m =
    await orig<typeof import("../../focus-sessions/create-session.js")>();
  return { ...m, createFocusSession: vi.fn(m.createFocusSession) };
});
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
  events,
  focusSessions,
  playbooks,
  projects,
  proposals,
  workspaces,
  workspaceMembers,
  users,
  links,
  sessionEvaluations,
  podMembers,
  projectMembers,
  channels,
  channelMembers,
} from "@synap/database";
import {
  applyTrackStageAdvance,
  getTrack,
  loadTrackView,
  setTrackStatus,
  startTrack,
  advanceTrackStage,
} from "../tracks-service.js";
import { readTrackHistory } from "../track-history.js";
import type { TrackHistoryEvent } from "@synap-core/types/units";

const USER = "user-1";
const AGENT = "agent-1";
const PROJECT = randomUUID();
const METHOD = randomUUID();
const STAGES = [
  { key: "draft", name: "Draft", category: "planned" },
  {
    key: "review",
    name: "Review",
    category: "started",
    gate: { kind: "check" },
  },
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
const tick = () => new Promise((r) => setTimeout(r, 5));

let trackId: string;
let sessionId: string;
let gateProposal: string;
let askProposal: string;
let history: TrackHistoryEvent[];
const of = <K extends TrackHistoryEvent["kind"]>(kind: K) =>
  history.filter((e) => e.kind === kind) as Array<
    Extract<TrackHistoryEvent, { kind: K }>
  >;

beforeAll(async () => {
  for (const t of [
    events,
    focusSessions,
    proposals,
    users,
    workspaces,
    workspaceMembers,
    links,
    playbooks,
    projects,
    sessionEvaluations,
    podMembers,
    projectMembers,
    channels,
    channelMembers,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into users (id, email, name, user_type, agent_metadata) values
      ($1, 'ana@example.test', 'Ana', 'human', null),
      ($2, 'agent@example.test', null, 'agent', '{"agentType":"Claude Code"}'::jsonb)`,
    [USER, AGENT]
  );
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
      direction text,
      kpi jsonb,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Launch', 'active')`,
    [PROJECT, USER]
  );
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, version, executor, status, scope, metadata, created_at, updated_at)
     values ($1, null, $2, 'Content', 'Do it', '[]', '{"kind":"none"}', '{}', '[]', $3::jsonb, '[]', 2, 'is-agent', 'active', 'project', '{}', now(), now())`,
    [METHOD, USER, JSON.stringify(STAGES)]
  );

  // 1. Start (birth entry at "draft").
  const started = await startTrack({
    projectId: PROJECT,
    playbookId: METHOD,
    actor: human,
  });
  if (started.status === "proposed") throw new Error("unexpected");
  trackId = started.track.id;
  await tick();

  // 2. draft → review: nothing closed at "draft" ⇒ the check HOLDS.
  const held = await advanceTrackStage({
    trackId,
    toStage: "review",
    actor: human,
  });
  if (held.status === "proposed") throw new Error("unexpected");
  expect(held.track.status).toBe("paused");
  await tick();
});

describe("TrackView carries the hold and the mover (U5 items 2+3)", () => {
  it("checkGate: the step measured, the step entered, what failed — while paused by it", async () => {
    const view = await loadTrackView((await getTrack(trackId, human))!, human);
    expect(view.pausedBy).toBe("check");
    expect(view.checkGate).toMatchObject({
      stageKey: "review",
      fromStage: "draft",
    });
    expect(view.checkGate!.failing.length).toBeGreaterThan(0);
  });

  it("stageHistory names who entered each step, server-side", async () => {
    const view = await loadTrackView((await getTrack(trackId, human))!, human);
    expect(view.stageHistory.map((e) => e.enteredBy)).toEqual([
      { kind: "human", id: USER, name: "Ana", isViewer: true },
      { kind: "human", id: USER, name: "Ana", isViewer: true },
    ]);
    // the move's check verdict is stamped on its entry
    expect(view.stageHistory[1]!.check).toMatchObject({ passed: false });
  });
});

describe("tracks.history (U5 item 1)", () => {
  beforeAll(async () => {
    // 3. A person resumes; the marker clears.
    const resumed = await setTrackStatus({
      trackId,
      status: "active",
      actor: human,
    });
    if (resumed.status === "proposed") throw new Error("unexpected");
    await tick();
    // 4. A session filed at "review", closed (no required outcome ⇒ met).
    sessionId = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, title, goal, status, project_id, track_id, track_stage, criteria, expected_outputs, agent_ids, metadata, started_at, closed_at, created_at, updated_at)
       values ($1, $2, 'Review pass', 'Review it', 'closed', $3, $4, 'review', '[]'::jsonb, '[]'::jsonb, '{}', '{}'::jsonb, now() - interval '1 second', now(), now(), now())`,
      [sessionId, USER, PROJECT, trackId]
    );
    await tick();
    // 5. An AGENT moves review → audit (the approval re-apply path carries
    //    its id as the mover); the check measures "review": met.
    const track = (await getTrack(trackId, human))!;
    const moved = await applyTrackStageAdvance({
      track,
      project: { id: PROJECT, workspaceId: null, userId: USER },
      toStage: "audit",
      userId: USER,
      agentUserId: AGENT,
      gate: true,
    });
    expect(moved.check).toMatchObject({ passed: true });
    // 6. Decisions: a stage gate answered WITH a note; an open ask in the session.
    gateProposal = randomUUID();
    askProposal = randomUUID();
    await q(
      `insert into proposals (id, status, proposal_type, target_type, target_id, data, comments, reviewed_by, reviewed_at, created_at, updated_at)
       values ($1, 'approved', 'playbook.stage_gate', 'track', $2, $3::jsonb, $4::jsonb, $5, now(), now(), now())`,
      [
        gateProposal,
        trackId,
        JSON.stringify({ stageKey: "review", stageName: "Review" }),
        JSON.stringify([
          {
            kind: "approval",
            text: "Go, but tighten the brief",
            by: USER,
            at: new Date().toISOString(),
          },
        ]),
        USER,
      ]
    );
    await q(
      `insert into proposals (id, status, proposal_type, target_type, target_id, session_id, agent_user_id, created_by, data, created_at, updated_at)
       values ($1, 'pending', 'create', 'entity', $2, $3, $4, $4, $5::jsonb, now(), now())`,
      [
        askProposal,
        randomUUID(),
        sessionId,
        AGENT,
        JSON.stringify({ summary: "Create the brief" }),
      ]
    );
    history = (await readTrackHistory(trackId, human))!.events;
  });

  it("returns newest first", () => {
    const times = history.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("the start and every move, with from-step and a NAMED mover (agent included)", () => {
    expect(of("track_started")).toEqual([
      expect.objectContaining({
        stageKey: "draft",
        actor: { kind: "human", id: USER, name: "Ana", isViewer: true },
      }),
    ]);
    const moves = of("step_moved");
    expect(moves.map((m) => [m.fromStage, m.stageKey])).toEqual([
      ["review", "audit"],
      ["draft", "review"],
    ]);
    expect(moves[0]!.actor).toEqual({
      kind: "agent",
      id: AGENT,
      name: "Claude Code",
    });
  });

  it("the check verdicts reach the timeline: held at draft→review, passed at review→audit", () => {
    expect(of("check_held")).toEqual([
      expect.objectContaining({
        stageKey: "review",
        fromStage: "draft",
        actor: { kind: "system", id: null, name: null },
      }),
    ]);
    expect(of("check_held")[0]!.failing.length).toBeGreaterThan(0);
    expect(of("check_passed")).toEqual([
      expect.objectContaining({ stageKey: "audit", fromStage: "review" }),
    ]);
  });

  it("the check's pause is the hold, not a person's pause; the resume is the person's", () => {
    expect(of("paused")).toEqual([]);
    expect(of("resumed")).toEqual([
      expect.objectContaining({
        stageKey: "review",
        actor: { kind: "human", id: USER, name: "Ana", isViewer: true },
      }),
    ]);
  });

  it("the session's start and close, with its graded contract", () => {
    expect(of("session_started")).toEqual([
      expect.objectContaining({
        stageKey: "review",
        title: "Review pass",
        refs: { sessionId },
      }),
    ]);
    expect(of("session_closed")).toEqual([
      expect.objectContaining({
        sessionStatus: "closed",
        verdict: "none",
        refs: { sessionId },
      }),
    ]);
  });

  it("decisions: the answered gate with the reviewer's note, and the open ask by the agent", () => {
    expect(of("decision_answered")).toEqual([
      expect.objectContaining({
        stageKey: "review",
        decision: "approved",
        note: "Go, but tighten the brief",
        title: "Review",
        refs: { proposalId: gateProposal },
        actor: { kind: "human", id: USER, name: "Ana", isViewer: true },
      }),
    ]);
    expect(of("decision_asked")).toEqual([
      expect.objectContaining({
        stageKey: "review",
        title: "Create the brief",
        refs: { proposalId: askProposal, sessionId },
        actor: { kind: "agent", id: AGENT, name: "Claude Code" },
      }),
    ]);
  });

  it("an invisible track reads null (NOT_FOUND upstream), never an empty history", async () => {
    expect(await readTrackHistory(trackId, { userId: "stranger" })).toBeNull();
  });
});
