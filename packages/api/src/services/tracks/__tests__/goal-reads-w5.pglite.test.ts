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

// The link writer, kept to the rows a start writes (`spawned_from` is read
// back by "keep watching it"): inserted as is, nothing else of the door.
vi.mock("../../links/links-service.js", () => ({
  createLinks: async (
    inputs: Array<{
      workspaceId: string | null;
      fromType: string;
      fromId: string;
      toType: string;
      toId: string;
      linkType: string;
    }>
  ) => {
    for (const l of inputs) {
      await h.client!.query(
        `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, '{}'::jsonb, now())`,
        [l.workspaceId, l.fromType, l.fromId, l.toType, l.toId, l.linkType]
      );
    }
    return [];
  },
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
  links,
  messages,
  notifications,
  playbooks,
  podMembers,
  projectMembers,
  projects,
  lifecycleTransitionOutbox,
  proposals,
  sessionEvaluations,
  users,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import {
  acceptGoalCriterion,
  decodeTrackListCursor,
  getTrack,
  listTracksPage,
  loadTrackView,
  reopenTrack,
  setTrackStatus,
  startOperationFrom,
  startTrack,
  type TrackActor,
} from "../tracks-service.js";
import { changeTrackParticipants } from "../track-participants.js";
import {
  loadGoalRuns,
  loadGoalRunsForRead,
  readGoalCriteria,
} from "../goal-content.js";
import { deriveGoalCriteria } from "@synap-core/types/units";
import { recordSessionEvaluation } from "../../focus-sessions/evaluations/record.js";
import {
  GOAL_CLAIM_NOTIFICATION_TYPE,
  GOAL_REVIEW_NOTIFICATION_TYPE,
  goalClaimGroupKey,
  goalReviewGroupKey,
  refreshGoalJudgements,
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
    // A goal's status flip owes its transition here (status-flow W1).
    lifecycleTransitionOutbox,
    channels,
    channelMembers,
    notifications,
    sessionEvaluations,
    // The waiting-on collector reads owed slots through the needs-you lens
    // (a session's agent activity).
    chatTurns,
    messages,
    events,
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

  it("F1 — the judge's decision settles THAT claim's item; the review item stays while another claim waits", async () => {
    const id = await goal("Settle me", PROJECT, person(OWNER), {
      criteria: [crit("a"), crit("b")],
    });
    const run = await fileRun(id, ["a", "b"]);
    await claim(run, "a");
    await claim(run, "b");
    // The open rows the notification door would hold (it is stubbed here).
    for (const [type, groupKey] of [
      [GOAL_REVIEW_NOTIFICATION_TYPE, goalReviewGroupKey(id)],
      [GOAL_CLAIM_NOTIFICATION_TYPE, goalClaimGroupKey(id, "a")],
      [GOAL_CLAIM_NOTIFICATION_TYPE, goalClaimGroupKey(id, "b")],
    ]) {
      await q(
        `insert into notifications (id, user_id, type, category, title, status, group_key, source_type, source_id, created_at)
         values (gen_random_uuid(), $1, $2, 'data', 't', 'unread', $3, 'track', $4, now())`,
        [OWNER, type, groupKey, id]
      );
    }
    const statusOf = async (groupKey: string) =>
      (
        await q<{ status: string }>(
          `select status from notifications where group_key = $1`,
          [groupKey]
        )
      ).rows[0]?.status;
    const accept = (key: string) =>
      acceptGoalCriterion({
        trackId: id,
        criterionKey: key,
        decision: "accepted",
        actor: person(OWNER),
      });
    expect((await accept("a")).status).toBe("updated");
    expect(await statusOf(goalClaimGroupKey(id, "a"))).toBe("actioned");
    // Rules out "any decision settles the review": "b" still waits.
    expect(await statusOf(goalReviewGroupKey(id))).toBe("unread");
    expect(await statusOf(goalClaimGroupKey(id, "b"))).toBe("unread");
    await accept("b");
    expect(await statusOf(goalReviewGroupKey(id))).toBe("actioned");
    expect(await statusOf(goalClaimGroupKey(id, "b"))).toBe("actioned");
  });

  it("each claimed criterion is a judgement on its own, before the goal is in review", async () => {
    const id = await goal("One at a time", PROJECT, person(OWNER), {
      criteria: [crit("copy"), crit("legal")],
    });
    const run = await fileRun(id, ["copy", "legal"]);
    await claim(run, "copy");
    expect(reviewNotices()).toEqual([]);
    expect(
      h.notices.filter((n) => n.type === GOAL_CLAIM_NOTIFICATION_TYPE)
    ).toEqual([
      expect.objectContaining({
        userId: OWNER,
        sourceId: id,
        groupKey: goalClaimGroupKey(id, "copy"),
        data: expect.objectContaining({
          criterionKey: "copy",
          criterionStatement: "Criterion copy",
        }),
      }),
    ]);
  });

  it("F1 — a goal mixing a MET measured criterion and a claimed one is in review, and its judge told", async () => {
    const id = await goal("Mixed", PROJECT, person(OWNER), {
      criteria: [
        {
          ...crit("pages"),
          check: { kind: "evidence", evidenceKey: "pages_migrated" },
          checkKind: "measured",
        },
        crit("tone"),
      ],
    });
    const run = await fileRun(id, ["pages", "tone"]);
    // A machine check that is not the run's author passes "pages": met.
    await q(
      `insert into session_evaluations (id, session_id, user_id, criterion_key, attempt, verdict, evaluator_kind, evaluator_id, evidence, created_at)
       values (gen_random_uuid(), $1, $2, 'pages', 1, 'pass', 'evidence', 'ci-bot', '{"url":"https://ci/run/9"}'::jsonb, now())`,
      [run, OWNER]
    );
    await claim(run, "tone");
    const v = await loadTrackView(
      (await getTrack(id, person(OWNER)))!,
      person(OWNER)
    );
    expect(v.criteria.map((c) => [c.key, c.mark])).toEqual([
      ["pages", "met"],
      ["tone", "claimed"],
    ]);
    expect(v.inReview).toBe(true);
    expect(reviewNotices().map((n) => n.userId)).toEqual([OWNER]);
    // The claim names who, which run, what backs it.
    expect(v.criteria[0]!.claim).toMatchObject({
      by: "ci-bot",
      sessionId: run,
      evidence: { url: "https://ci/run/9" },
    });
    expect(v.criteria[1]!.claim).toMatchObject({
      by: OWNER,
      byName: OWNER,
      sessionId: run,
    });
  });

  it("a claim the judge already READ is not raised a second time by a later grade", async () => {
    const id = await goal("Read once", PROJECT, person(OWNER), {
      criteria: [crit("a"), crit("b")],
    });
    const run = await fileRun(id, ["a", "b"]);
    // The judge read "a"'s item (the door's dedupe only holds UNREAD rows).
    await q(
      `insert into notifications (id, user_id, type, category, title, status, group_key, source_type, source_id, created_at)
       values (gen_random_uuid(), $1, $2, 'data', 't', 'read', $3, 'track', $4, now())`,
      [OWNER, GOAL_CLAIM_NOTIFICATION_TYPE, goalClaimGroupKey(id, "a"), id]
    );
    await claim(run, "a");
    await claim(run, "b");
    expect(
      h.notices
        .filter(
          (n) => n.type === GOAL_CLAIM_NOTIFICATION_TYPE && n.sourceId === id
        )
        .map((n) => n.groupKey)
    ).toEqual([goalClaimGroupKey(id, "b")]);
  });

  it("an OPERATION is never 'ready for your verdict' — its claims still reach the judge", async () => {
    const id = await goal("Keep it running", PROJECT, person(OWNER), {
      criteria: [crit("a"), crit("b")],
      workKind: "operation",
    });
    const run = await fileRun(id, ["a", "b"]);
    await claim(run, "a");
    await claim(run, "b");
    const refreshed = await refreshGoalJudgements(id);
    expect(refreshed).toEqual({ claimed: ["a", "b"], inReview: false });
    expect(reviewNotices()).toEqual([]);
    expect(
      h.notices.filter((n) => n.type === GOAL_CLAIM_NOTIFICATION_TYPE).length
    ).toBeGreaterThan(0);
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

  it("rows started in the SAME millisecond page cleanly, in both orders (microseconds apart)", async () => {
    // Four goals one millisecond apart at most, a few microseconds apart —
    // the column keeps microseconds, the cursor carries milliseconds.
    const ids: string[] = [];
    for (const n of ["µ one", "µ two", "µ three", "µ four"]) {
      ids.push(await goal(n, OTHER_PROJECT));
    }
    await q(
      `update project_tracks
          set created_at = timestamptz '2030-01-01 00:00:00.123000+00'
                           + (array_position($1::uuid[], id) * interval '1 microsecond')
        where id = any($1::uuid[])`,
      [ids]
    );
    const walk = async (projectId: string | null) => {
      const seen: string[] = [];
      let cursor = null as ReturnType<typeof decodeTrackListCursor>;
      for (let i = 0; i < 50; i++) {
        const page = (await listTracksPage({
          ...(projectId ? { projectId } : {}),
          actor: person(OWNER),
          limit: 1,
          cursor,
        }))!;
        seen.push(...page.rows.map((r) => r.id));
        if (!page.nextCursor) break;
        cursor = decodeTrackListCursor(page.nextCursor);
      }
      return seen;
    };
    for (const projectId of [OTHER_PROJECT, null]) {
      const all = (await listTracksPage({
        ...(projectId ? { projectId } : {}),
        actor: person(OWNER),
        limit: 100,
      }))!.rows.map((r) => r.id);
      const seen = await walk(projectId);
      // Rules out the ms cursor against µs rows: a repeat or a skip here.
      expect(seen, String(projectId)).toEqual(all);
      expect(new Set(seen).size).toBe(seen.length);
      for (const id of ids) expect(seen).toContain(id);
    }
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

describe("F4 — the list read of a goal's runs is bounded, and derives the same marks", () => {
  /** A closed run carrying `keys`, at `minutesAgo`. */
  async function closedRun(trackId: string, keys: string[]): Promise<string> {
    const id = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, track_id, project_id, status, goal, criteria, expected_outputs, agent_ids, metadata, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'closed', 'work', $6::jsonb, '[]'::jsonb, '{agent-9}', '{"modelId":"model-x"}'::jsonb, now(), now())`,
      [id, OWNER, WS, trackId, PROJECT, JSON.stringify(keys.map(crit))]
    );
    return id;
  }
  async function grade(
    sessionId: string,
    key: string,
    verdict: "pass" | "fail",
    kind: string,
    by: string,
    minutesAgo: number,
    rationale: string | null = null
  ) {
    await q(
      `insert into session_evaluations (id, session_id, user_id, criterion_key, attempt, verdict, evaluator_kind, evaluator_id, rationale, evidence, created_at)
       values (gen_random_uuid(), $1, $2, $3, 1, $4, $5, $6, $7, '{}'::jsonb, now() - ($8::int * interval '1 minute'))`,
      [sessionId, OWNER, key, verdict, kind, by, rationale, minutesAgo]
    );
  }

  it("equal to the whole-history derivation, from fewer runs", async () => {
    const id = await goal("Bounded", PROJECT, person(OWNER), {
      criteria: [
        crit("tone"),
        {
          ...crit("pages"),
          check: { kind: "evidence", evidenceKey: "pages" },
          checkKind: "measured",
        },
        crit("legal"),
        crit("press"),
      ],
    });
    // Many closed attempts on "tone": only the latest of each kind matters.
    for (let i = 0; i < 5; i++) {
      const r = await closedRun(id, ["tone", "pages"]);
      await grade(r, "tone", "fail", "judge", "model-x", 100 - i);
      await grade(
        r,
        "pages",
        "pass",
        "evidence",
        "ci-bot",
        90 - i,
        `${i} of 9 pages`
      );
    }
    // An OLDER person's grade still wins over every later AI row.
    const human = await closedRun(id, ["tone"]);
    await grade(human, "tone", "pass", "human", "user-7", 200);
    // The latest measured row is a fail with its own value.
    const last = await closedRun(id, ["pages"]);
    await grade(
      last,
      "pages",
      "fail",
      "evidence",
      "ci-bot",
      10,
      "8 of 9 pages"
    );
    // "legal" was carried by a closed run that nobody graded: not met.
    await closedRun(id, ["legal"]);
    // An open run on "tone" with a newer AI pass — under way, not the winner.
    const open = await fileRun(id, ["tone"]);
    await grade(open, "tone", "pass", "judge", "model-x", 1);

    const track = (await getTrack(id, person(OWNER)))!;
    const criteria = readGoalCriteria(track.criteria);
    const ctx = { judgeId: OWNER };
    const full = (await loadGoalRuns([track])).runsOf.get(id)!;
    const bounded = (await loadGoalRunsForRead([track])).runsOf.get(id)!;
    const derived = (runs: typeof full) =>
      deriveGoalCriteria(criteria, runs, ctx);
    expect(derived(bounded)).toEqual(derived(full));
    // Non-vacuity: the fixture exercises each rule the bounded read keeps.
    expect(derived(full).map((c) => [c.key, c.mark, c.currentValue])).toEqual([
      ["tone", "claimed", null],
      ["pages", "not_met", "8 of 9 pages"],
      ["legal", "not_met", null],
      ["press", "not_started", null],
    ]);
    expect(derived(full)[0]!.claim).toMatchObject({
      by: "user-7",
      sessionId: human,
    });
    // …and it read fewer runs than the goal has.
    expect(full.length).toBe(9);
    expect(bounded.length).toBeLessThan(full.length);
  });
});

describe("R6 — keep watching it, and an operation's week", () => {
  it("a goal closed as met starts an OPERATION linked spawned_from it, read per week; a repeat hands it back", async () => {
    const id = await goal("Site is live", PROJECT, person(OWNER), {
      criteria: [crit("up"), crit("fast")],
    });
    const run = await fileRun(id, ["up", "fast"]);
    // The owner judges: their own grade is the acceptance.
    for (const key of ["up", "fast"]) {
      await recordSessionEvaluation({
        sessionId: run,
        userId: OWNER,
        criterionKey: key,
        verdict: "pass",
        evaluatorKind: "human",
        evaluatorId: OWNER,
      });
    }
    await setTrackStatus({
      trackId: id,
      status: "completed",
      verdict: "met",
      actor: person(OWNER),
    });

    const res = await startOperationFrom({ trackId: id, actor: person(OWNER) });
    if (res.status === "proposed") throw new Error("unexpected proposal");
    expect(res.status).toBe("started");
    expect(res.track).toMatchObject({
      name: "Site is live",
      workKind: "operation",
      status: "active",
    });
    const edges = await q<{ to_id: string }>(
      `select to_id from links where from_type = 'track' and from_id = $1 and link_type = 'spawned_from'`,
      [res.track.id]
    );
    expect(edges.rows).toEqual([{ to_id: id }]);

    // Its week: unmeasured until a run of it is graded this week, then met.
    const view = async () =>
      loadTrackView(
        (await getTrack(res.track.id, person(OWNER)))!,
        person(OWNER)
      );
    expect((await view()).periodReading).toMatchObject({ mark: "unmeasured" });
    const opRun = await fileRun(res.track.id, ["up", "fast"]);
    await claim(opRun, "up");
    // One required criterion still ungraded this week: not yet met.
    expect((await view()).periodReading).toMatchObject({ mark: "unmeasured" });
    await claim(opRun, "fast");
    expect((await view()).periodReading).toMatchObject({ mark: "met" });
    // Any other kind of work reads no period.
    expect(
      (await loadTrackView((await getTrack(id, person(OWNER)))!, person(OWNER)))
        .periodReading
    ).toBeNull();

    const again = await startOperationFrom({
      trackId: id,
      name: "Another name",
      actor: person(OWNER),
    });
    expect(again).toMatchObject({ status: "exists" });
    if (again.status !== "proposed") expect(again.track.id).toBe(res.track.id);
  });

  it("refuses a goal that was not closed as met", async () => {
    const id = await goal("Still running", PROJECT, person(OWNER));
    await expect(
      startOperationFrom({ trackId: id, actor: person(OWNER) })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
