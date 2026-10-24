/**
 * THE SHARED READS THE GOAL PAGES NEED (work model W5, 2026-10-23), on PGlite
 * — the REAL tracks service, the REAL evaluation door
 * (`recordSessionEvaluation`), the REAL goal derivation (`loadTrackGoalFacts`),
 * the REAL participants (0348) and the REAL access registry.
 *
 *   1. A GOAL IN REVIEW REACHES ITS JUDGE. The seam is the evaluation door: a
 *      claim on a run filed into a goal → the goal's facts → a
 *      `track.review_ready` notice to the JUDGE (not the owner, once a judge
 *      is named — the input where "notify the owner" and "notify the judge"
 *      disagree). Only when EVERY required criterion is claimed (one claim of
 *      two writes nothing). The judge's decision settles it.
 *   2. THE POD-WIDE GOALS LIST. `listTracksPage` with no project lists every
 *      goal the caller can see across projects, newest first, paged by an
 *      opaque cursor — and never a goal of a project the caller cannot see.
 *
 * Stubbed, only at infrastructure seams: `NotificationService.create` (the
 * call is what is asserted — the door's own dedupe is its suite's),
 * `checkPermissionOrPropose` (a person is granted), `createLinks`,
 * `emitSideEffects`, the EventRepository append.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
// The rest of the goal row as a pod holds it (W4 loop, R6 verdict): every
// track read selects the whole row.
const M0349 = migration("0349_track_verdict_retired.sql");
const M0350 = migration("0350_track_goal_loop.sql");

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  notices: [] as Array<Record<string, unknown>>,
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
    create: async (input: Record<string, unknown>) => {
      h.notices.push(input);
      return { id: randomUUID() };
    },
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
  focusSessions,
  links,
  notifications,
  playbooks,
  podMembers,
  projectMembers,
  projects,
  proposals,
  sessionEvaluations,
  users,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import {
  acceptGoalCriterion,
  decodeTrackListCursor,
  listTracksPage,
  reopenTrack,
  setTrackStatus,
  startTrack,
  type TrackActor,
} from "../tracks-service.js";
import { changeTrackParticipants } from "../track-participants.js";
import { recordSessionEvaluation } from "../../focus-sessions/evaluations/record.js";
import {
  GOAL_REVIEW_NOTIFICATION_TYPE,
  goalReviewGroupKey,
} from "../goal-review-notice.js";

const OWNER = "owner-1";
const JUDGE = "judge-1";
const STRANGER = "stranger-1";
const STAFFER = "staffer-1"; // an editor of the space, on no goal
const DELEGATE = "delegate-1"; // a viewer of the space
const WS = randomUUID();
const PROJECT = randomUUID();
const OTHER_PROJECT = randomUUID();
const STRANGERS_PROJECT = randomUUID();

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
const crit = (key: string) => ({
  key,
  statement: `Criterion ${key}`,
  check: { kind: "judge" },
});

async function goal(
  name: string,
  projectId = PROJECT,
  actor = person(OWNER),
  extra: object = {}
): Promise<string> {
  const res = await startTrack({ projectId, name, actor, ...extra });
  if (res.status === "proposed") throw new Error("unexpected proposal");
  return res.track.id;
}

/** A run filed into the goal, owned by OWNER, carrying `keys`. */
async function fileRun(trackId: string, keys: string[]): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, track_id, project_id, status, goal, criteria, expected_outputs, agent_ids, metadata, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'active', 'work', $6::jsonb, '[]'::jsonb, '{}', '{}'::jsonb, now(), now())`,
    [id, OWNER, WS, trackId, PROJECT, JSON.stringify(keys.map(crit))]
  );
  return id;
}

/** An AI judge passes one criterion through THE evaluation door. */
async function claim(sessionId: string, key: string) {
  const r = await recordSessionEvaluation({
    sessionId,
    userId: OWNER,
    criterionKey: key,
    verdict: "pass",
    evaluatorKind: "judge",
    evaluatorId: "model-x",
  });
  expect(r.status).toBe("recorded");
}

const reviewNotices = () =>
  h.notices.filter((n) => n.type === GOAL_REVIEW_NOTIFICATION_TYPE);

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
  await h.client!.exec(M0317);
  await h.client!.exec(M0344);
  await h.client!.exec(M0345);
  await h.client!.exec(M0348);
  await h.client!.exec(M0349);
  await h.client!.exec(M0350);
  // The edge-uniqueness index the dependency door's insert conflicts on
  // (`idx_links_unique_edge`) — a reopen writes `new --replaces--> old`.
  await h.client!.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type)`
  );

  for (const id of [OWNER, JUDGE, STRANGER, STAFFER, DELEGATE]) {
    await q(
      `insert into users (id, email, name, user_type) values ($1, $2, $1, 'human')`,
      [id, `${id}@example.test`]
    );
  }
  await q(
    `insert into workspaces (id, name, workspace_type, owner_id) values ($1, 'Builder', 'personal', $2)`,
    [WS, OWNER]
  );
  for (const [userId, role] of [
    [OWNER, "owner"],
    [JUDGE, "editor"],
    [STAFFER, "editor"],
    [DELEGATE, "viewer"],
  ]) {
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)`,
      [WS, userId, role]
    );
  }
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values
      ($1, $2, $3, 'Launch', 'active'),
      ($4, $2, null, 'Other', 'active'),
      ($5, $6, null, 'Theirs', 'active')`,
    [PROJECT, OWNER, WS, OTHER_PROJECT, STRANGERS_PROJECT, STRANGER]
  );
});

beforeEach(() => {
  h.notices.length = 0;
});

describe("a goal in review reaches its judge (W5)", () => {
  it("one claim of two: nothing; the last claim: a notice to the NAMED judge, not the owner", async () => {
    const id = await goal("Ship pricing", PROJECT, person(OWNER), {
      criteria: [crit("copy"), crit("legal")],
    });
    const named = await changeTrackParticipants({
      trackId: id,
      actor: person(OWNER),
      change: { op: "add", principalId: JUDGE, role: "judge" },
    });
    expect(named.status).not.toBe("proposed");
    const run = await fileRun(id, ["copy", "legal"]);

    await claim(run, "copy");
    expect(reviewNotices()).toEqual([]);

    await claim(run, "legal");
    expect(reviewNotices()).toEqual([
      expect.objectContaining({
        type: "track.review_ready",
        userId: JUDGE,
        workspaceId: WS,
        sourceType: "track",
        sourceId: id,
        groupKey: goalReviewGroupKey(id),
        data: { trackId: id, trackName: "Ship pricing" },
      }),
    ]);
  });

  it("a goal with no judge named: its owner judges, and is told", async () => {
    const id = await goal("Grow the list", PROJECT, person(OWNER), {
      criteria: [crit("a"), crit("b")],
    });
    const run = await fileRun(id, ["a", "b"]);
    await claim(run, "a");
    await claim(run, "b");
    expect(reviewNotices().map((n) => n.userId)).toEqual([OWNER]);
  });

  it("a pass on a run filed into NO goal tells no one", async () => {
    const id = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, project_id, status, goal, criteria, expected_outputs, agent_ids, metadata, created_at, updated_at)
       values ($1, $2, $3, $4, 'active', 'work', $5::jsonb, '[]'::jsonb, '{}', '{}'::jsonb, now(), now())`,
      [id, OWNER, WS, PROJECT, JSON.stringify([crit("x")])]
    );
    await claim(id, "x");
    expect(reviewNotices()).toEqual([]);
  });

  it("the judge's decision settles the open notice", async () => {
    const id = await goal("Settle me", PROJECT, person(OWNER), {
      criteria: [crit("a"), crit("b")],
    });
    await q(
      `insert into notifications (id, user_id, type, category, title, status, group_key, source_type, source_id, created_at)
       values (gen_random_uuid(), $1, $2, 'data', 'Settle me is ready for your verdict', 'unread', $3, 'track', $4, now())`,
      [OWNER, GOAL_REVIEW_NOTIFICATION_TYPE, goalReviewGroupKey(id), id]
    );
    const run = await fileRun(id, ["a", "b"]);
    await claim(run, "a");
    await claim(run, "b");
    const r = await acceptGoalCriterion({
      trackId: id,
      criterionKey: "a",
      decision: "accepted",
      actor: person(OWNER),
    });
    expect(r.status).toBe("updated");
    const [row] = (
      await q<{ status: string }>(
        `select status from notifications where group_key = $1`,
        [goalReviewGroupKey(id)]
      )
    ).rows;
    expect(row?.status).toBe("actioned");
  });
});

describe("the pod-wide goals list (W5)", () => {
  it("lists every goal the caller can see across projects, newest first — never a hidden project's", async () => {
    const before = await listTracksPage({
      actor: person(OWNER),
      limit: 100,
    });
    const known = new Set(before!.rows.map((r) => r.id));
    const mine = await goal("Second project goal", OTHER_PROJECT);
    const theirs = await goal("Not yours", STRANGERS_PROJECT, person(STRANGER));
    const page = await listTracksPage({ actor: person(OWNER), limit: 100 });
    const ids = page!.rows.map((r) => r.id);
    expect(ids[0]).toBe(mine); // newest first
    expect(ids).not.toContain(theirs);
    // Pod-wide: goals of BOTH of the owner's projects.
    expect(new Set(page!.rows.map((r) => r.projectId))).toEqual(
      new Set([PROJECT, OTHER_PROJECT])
    );
    expect(ids.filter((i) => !known.has(i))).toEqual([mine]);
    expect(page!.nextCursor).toBeNull();
  });

  it("pages by an opaque cursor: no row twice, none skipped, null at the end", async () => {
    const all = (await listTracksPage({ actor: person(OWNER), limit: 100 }))!
      .rows;
    expect(all.length).toBeGreaterThanOrEqual(3); // non-vacuity
    const seen: string[] = [];
    let cursor = null as ReturnType<typeof decodeTrackListCursor>;
    for (let i = 0; i < all.length + 1; i++) {
      const page = (await listTracksPage({
        actor: person(OWNER),
        limit: 2,
        cursor,
      }))!;
      seen.push(...page.rows.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = decodeTrackListCursor(page.nextCursor);
      expect(cursor).not.toBeNull();
    }
    expect(seen).toEqual(all.map((r) => r.id));
  });

  it("a project the caller cannot see is null, not an empty page", async () => {
    expect(
      await listTracksPage({
        projectId: STRANGERS_PROJECT,
        actor: person(OWNER),
        limit: 10,
      })
    ).toBeNull();
  });

  it("a cursor this read never returned does not decode", () => {
    expect(decodeTrackListCursor("not-a-cursor")).toBeNull();
    expect(decodeTrackListCursor(undefined)).toBeNull();
  });
});

describe("a reopened goal keeps its people (R8, W5)", () => {
  type Row = {
    principal_id: string;
    role: string;
    commitment: string | null;
    commitment_state: string | null;
  };
  const people = async (trackId: string) =>
    (
      await q<Row>(
        `select principal_id, role, commitment, commitment_state
           from track_participants where track_id = $1 order by role, principal_id`,
        [trackId]
      )
    ).rows;

  async function closedGoalWithPeople(name: string): Promise<string> {
    const id = await goal(name);
    const change = (
      actor: TrackActor,
      c: Parameters<typeof changeTrackParticipants>[0]["change"]
    ) => changeTrackParticipants({ trackId: id, actor, change: c });
    await change(person(OWNER), {
      op: "add",
      principalId: JUDGE,
      role: "judge",
    });
    await change(person(OWNER), {
      op: "add",
      principalId: DELEGATE,
      role: "delegate",
      commitment: "Draft the copy",
    });
    await change(person(OWNER), {
      op: "add",
      principalId: STAFFER,
      role: "integrator",
    });
    const asked = (await people(id)).find((r) => r.role === "delegate")!;
    expect(asked.commitment_state).toBe("proposed");
    const [row] = (
      await q<{ id: string }>(
        `select id from track_participants where track_id = $1 and role = 'delegate'`,
        [id]
      )
    ).rows;
    await change(person(DELEGATE), {
      op: "move",
      participantId: row!.id,
      move: "accept",
    });
    const dropped = await setTrackStatus({
      trackId: id,
      status: "archived",
      verdict: "no_longer_needed",
      actor: person(OWNER),
    });
    expect(dropped.status).toBe("updated");
    return id;
  }

  it("the judge reopens: owner and judge carried, the delegate asked again with the same commitment", async () => {
    const old = await closedGoalWithPeople("Carry me");
    expect(
      (await people(old)).find((r) => r.role === "delegate")?.commitment_state
    ).toBe("accepted");
    const res = await reopenTrack({ trackId: old, actor: person(JUDGE) });
    if (res.status === "proposed") throw new Error("unexpected proposal");
    expect(res.track.id).not.toBe(old);
    expect(await people(res.track.id)).toEqual(
      [
        {
          principal_id: DELEGATE,
          role: "delegate",
          commitment: "Draft the copy",
          commitment_state: "proposed",
        },
        {
          principal_id: STAFFER,
          role: "integrator",
          commitment: null,
          commitment_state: null,
        },
        // The OWNER stays the owner — not the judge who pressed reopen.
        {
          principal_id: JUDGE,
          role: "judge",
          commitment: null,
          commitment_state: null,
        },
        {
          principal_id: OWNER,
          role: "owner",
          commitment: null,
          commitment_state: null,
        },
      ].sort((a, b) =>
        a.role === b.role
          ? a.principal_id.localeCompare(b.principal_id)
          : a.role.localeCompare(b.role)
      )
    );
  });

  it("only the old owner or judge may reopen — an editor on no seat is refused", async () => {
    const old = await closedGoalWithPeople("Not yours to reopen");
    await expect(
      reopenTrack({ trackId: old, actor: person(STAFFER) })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/owner or the judge/),
    });
    const res = await reopenTrack({ trackId: old, actor: person(OWNER) });
    expect(res.status).not.toBe("proposed");
  });
});
