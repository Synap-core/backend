/**
 * D-6 (founder, 2026-10-26) — WHO SEES WHAT BACKS A GOAL'S CRITERIA, on
 * PGlite: the REAL tracks service read every door uses (`getTrack` +
 * `loadTrackView` → `loadTrackGoalFacts`), the REAL participants (0348), the
 * REAL access registry and session read rule (`sessionReadableWhere`), and a
 * REAL key grant (`runWithGrant`).
 *
 * What backs a criterion — its claim's run title, evidence and note, and its
 * measured value — is the RUN's content. It is shown to the goal's OWNER, its
 * JUDGE, and whoever may read the run (its owner; on a human door a human
 * seat on its own room). Everyone else who sees the goal reads the same MARK,
 * the content `null` and `evidenceWithheld: true`.
 *
 * Each viewer rules out one wrong rule:
 *   · TEAMMATE (sees the project, on nothing)   — "anyone who sees the goal"
 *   · OWNER / JUDGE (do not own the run)        — "only who may read the run"
 *   · RUNNER (owns the run, no seat)            — "only the owner and judge"
 *   · ROOMMATE human door vs agent door         — the door's session rule
 *   · OWNER's key granted `track` vs `session`  — the grant on the seat branch
 *
 * Stubbed, only at infrastructure seams: `NotificationService.create`,
 * `checkPermissionOrPropose` (a person is granted), `createLinks`,
 * `emitSideEffects`, the EventRepository append.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migration = (f: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../../database/migrations/${f}`, import.meta.url)
    ),
    "utf8"
  );
const M0317 = migration("0317_project_tracks_live_name_unique.sql");
const M0344 = migration("0344_track_lifecycle_and_verdict.sql");
const M0345 = migration("0345_track_goal_content.sql");
const M0348 = migration("0348_track_participants.sql");
const M0349 = migration("0349_track_verdict_retired.sql");
const M0350 = migration("0350_track_goal_loop.sql");

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
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
      workspaceMembers: actual.workspaceMembers as never,
      trackParticipants: actual.trackParticipants as never,
    },
  });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    EventRepository: class {
      async append() {}
    },
  };
});

vi.mock("../../../notifications/NotificationService.js", () => ({
  NotificationService: {
    create: async () => ({ id: randomUUID() }),
  },
}));

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async () => ({ granted: true }),
  proposedMessageFor: (_t: string, fallback: string) => fallback,
}));

vi.mock("../../links/links-service.js", () => ({
  createLinks: async () => [],
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: async () => {},
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  channels,
  channelMembers,
  chatTurns,
  events,
  focusSessions,
  grantOfScope,
  lifecycleTransitionOutbox,
  messages,
  links,
  notifications,
  playbooks,
  podMembers,
  projectMembers,
  projects,
  proposals,
  runWithGrant,
  sessionEvaluations,
  users,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import type { GoalCriterionView } from "@synap-core/types/units";
import {
  getTrack,
  loadTrackView,
  startTrack,
  type TrackActor,
} from "../tracks-service.js";
import { changeTrackParticipants } from "../track-participants.js";

const OWNER = "owner-1"; // owns the goal, not the run
const JUDGE = "judge-1"; // the goal's named judge, not the run's owner
const RUNNER = "runner-1"; // owns the run, no seat on the goal
const TEAMMATE = "teammate-1"; // an editor of the space, on nothing
const ROOMMATE = "roommate-1"; // a human seat on the run's own room
const AGENT = "agent-1"; // a key's agent, acting for its person
const WS = randomUUID();
const PROJECT = randomUUID();

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
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : c.name === "metadata" || c.name === "settings"
            ? " default '{}'::jsonb"
            : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const person = (userId: string): TrackActor => ({ userId });
const agentFor = (userId: string): TrackActor => ({
  userId,
  agentUserId: AGENT,
  isHubProtocol: true,
});

const JUDGED = {
  key: "copy",
  statement: "The copy reads well",
  check: { kind: "judge" },
};
const MEASURED = {
  key: "pages",
  statement: "Every page migrated",
  check: { kind: "evidence", evidenceKey: "pages" },
  checkKind: "measured",
};

const TITLE = "Draft the launch copy";
const EVIDENCE = { url: "https://example.test/draft", files: 2 };
const NOTE = "Reads well, warm tone";
const VALUE = "8 of 9 pages";

async function goal(name: string): Promise<string> {
  const res = await startTrack({
    projectId: PROJECT,
    name,
    actor: person(OWNER),
    criteria: [JUDGED, MEASURED],
  } as Parameters<typeof startTrack>[0]);
  if (res.status === "proposed") throw new Error("unexpected proposal");
  const named = await changeTrackParticipants({
    trackId: res.track.id,
    actor: person(OWNER),
    change: { op: "add", principalId: JUDGE, role: "judge" },
  });
  expect(named.status).not.toBe("proposed");
  return res.track.id;
}

/** A run filed into the goal, owned by `owner`, with its own minted room. */
async function fileRun(
  trackId: string,
  owner: string,
  keys: string[]
): Promise<string> {
  const id = randomUUID();
  const room = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, status, context_object_type, context_object_id)
     values ($1, $2, 'ai_thread', 'active', 'focus_session', $3)`,
    [room, owner, id]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, track_id, project_id, status, goal, title, channel_id, criteria, expected_outputs, agent_ids, metadata, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'active', 'work', $6, $7, $8::jsonb, '[]'::jsonb, '{}', '{}'::jsonb, now(), now())`,
    [
      id,
      owner,
      WS,
      trackId,
      PROJECT,
      TITLE,
      room,
      JSON.stringify([JUDGED, MEASURED].filter((c) => keys.includes(c.key))),
    ]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, role)
     values (gen_random_uuid(), $1, $2, 'human', 'member')`,
    [room, ROOMMATE]
  );
  return id;
}

async function grade(
  sessionId: string,
  owner: string,
  key: string,
  verdict: "pass" | "fail",
  kind: string,
  by: string,
  rationale: string,
  evidence: object = {}
) {
  await q(
    `insert into session_evaluations (id, session_id, user_id, workspace_id, criterion_key, attempt, verdict, evaluator_kind, evaluator_id, rationale, evidence, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, 1, $5, $6, $7, $8, $9::jsonb, now())`,
    [
      sessionId,
      owner,
      WS,
      key,
      verdict,
      kind,
      by,
      rationale,
      JSON.stringify(evidence),
    ]
  );
}

/** The goal as `actor` reads it through the door every track read uses. */
async function read(trackId: string, actor: TrackActor) {
  const track = await getTrack(trackId, actor);
  // Non-vacuity: every viewer here SEES the goal — only its backing differs.
  expect(track).not.toBeNull();
  const view = await loadTrackView(track!, actor);
  return Object.fromEntries(view.criteria.map((c) => [c.key, c])) as Record<
    string,
    GoalCriterionView
  >;
}

const SHOWN = {
  copy: {
    mark: "claimed",
    claim: expect.objectContaining({
      by: RUNNER,
      sessionTitle: TITLE,
      evidence: EVIDENCE,
      note: NOTE,
    }),
    evidenceWithheld: false,
  },
  pages: { mark: "under_way", currentValue: VALUE, evidenceWithheld: false },
};
const WITHHELD = {
  copy: {
    mark: "claimed",
    // Who claimed it stays — the mark says "claimed"; the run's content goes.
    claim: expect.objectContaining({
      by: RUNNER,
      sessionTitle: null,
      evidence: null,
      note: null,
    }),
    evidenceWithheld: true,
  },
  pages: { mark: "under_way", currentValue: null, evidenceWithheld: true },
};

let GOAL = "";
let RUN = "";

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    users,
    workspaces,
    workspaceMembers,
    podMembers,
    projectMembers,
    links,
    playbooks,
    projects,
    channels,
    channelMembers,
    notifications,
    sessionEvaluations,
    // The waiting-on collector reads owed slots through the needs-you lens
    // (a session's agent activity) and the current hold of each run.
    chatTurns,
    messages,
    events,
    lifecycleTransitionOutbox,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
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
      status text not null default 'active'
        check (status in ('active','paused','completed','archived')),
      params jsonb not null default '{}'::jsonb,
      stage_history jsonb not null default '[]'::jsonb,
      direction text,
      kpi jsonb,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  for (const m of [M0317, M0344, M0345, M0348, M0349, M0350]) {
    await h.client!.exec(m);
  }

  for (const id of [OWNER, JUDGE, RUNNER, TEAMMATE, ROOMMATE]) {
    await q(
      `insert into users (id, email, name, user_type) values ($1, $2, $1, 'human')`,
      [id, `${id}@example.test`]
    );
  }
  await q(
    `insert into users (id, email, name, user_type) values ($1, $2, $1, 'agent')`,
    [AGENT, `${AGENT}@example.test`]
  );
  await q(
    `insert into workspaces (id, name, workspace_type, owner_id) values ($1, 'Builder', 'personal', $2)`,
    [WS, OWNER]
  );
  for (const [userId, role] of [
    [OWNER, "owner"],
    [JUDGE, "editor"],
    [RUNNER, "editor"],
    [TEAMMATE, "editor"],
    [ROOMMATE, "editor"],
  ]) {
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)`,
      [WS, userId, role]
    );
  }
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, $3, 'Launch', 'active')`,
    [PROJECT, OWNER, WS]
  );

  GOAL = await goal("Launch the site");
  RUN = await fileRun(GOAL, RUNNER, ["copy", "pages"]);
  await grade(RUN, RUNNER, "copy", "pass", "judge", "model-x", NOTE, EVIDENCE);
  await grade(RUN, RUNNER, "pages", "fail", "evidence", "ci-bot", VALUE);
});

describe("D-6 — what backs a goal's criteria is the owner's, the judge's and the run's readers'", () => {
  it("a teammate who sees the goal but not the run reads the MARK only, told it is withheld", async () => {
    expect(await read(GOAL, person(TEAMMATE))).toMatchObject(WITHHELD);
  });

  it("the goal's owner and its judge see it, though neither owns the run", async () => {
    expect(await read(GOAL, person(OWNER))).toMatchObject(SHOWN);
    expect(await read(GOAL, person(JUDGE))).toMatchObject(SHOWN);
  });

  it("the run's owner sees it, with no seat on the goal", async () => {
    expect(await read(GOAL, person(RUNNER))).toMatchObject(SHOWN);
  });

  it("a human seat on the run's room sees it on a human door — not through an agent key", async () => {
    expect(await read(GOAL, person(ROOMMATE))).toMatchObject(SHOWN);
    expect(await read(GOAL, agentFor(ROOMMATE))).toMatchObject(WITHHELD);
  });

  it("a key reads as its person within its grant: granted only `track`, the owner's key reads the mark only", async () => {
    const asKey = (permissions: string[]) =>
      runWithGrant(grantOfScope({ permissions }), () =>
        read(GOAL, agentFor(OWNER))
      );
    expect(await asKey(["track.read"])).toMatchObject(WITHHELD);
    // Control: the same key granted `session` too reads what its person reads.
    expect(await asKey(["track.read", "session.read"])).toMatchObject(SHOWN);
  });

  it("per run: a teammate's OWN run shows its value, another's claim stays withheld", async () => {
    const id = await goal("Migrate the docs");
    const theirs = await fileRun(id, RUNNER, ["copy"]);
    await grade(
      theirs,
      RUNNER,
      "copy",
      "pass",
      "judge",
      "model-x",
      NOTE,
      EVIDENCE
    );
    const mine = await fileRun(id, TEAMMATE, ["pages"]);
    await grade(mine, TEAMMATE, "pages", "fail", "evidence", "ci-bot", VALUE);

    expect(await read(id, person(TEAMMATE))).toMatchObject({
      copy: WITHHELD.copy,
      pages: {
        mark: "under_way",
        currentValue: VALUE,
        evidenceWithheld: false,
      },
    });
    expect(await read(id, person(RUNNER))).toMatchObject({
      copy: SHOWN.copy,
      pages: { mark: "under_way", currentValue: null, evidenceWithheld: true },
    });
  });
});
