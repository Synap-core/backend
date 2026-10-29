/**
 * STATUS ROLLUPS (status-flow plan W0b) — where a goal, a project or a space
 * stands, in a few numbers: counts per category, what moved this week, what
 * is stuck, what waits. Served by orient: every open goal it lists carries
 * its `rollup` (goals first, the founder's altitude); a pinned space or
 * project adds `statusRollup`. Detail stays behind the ids (`statusOf`).
 *
 * Every number comes from an existing reader: the session population of a
 * goal (`workAndTrackedRunsWhere`), the goal's waiting-on (`loadTrackGoalFacts`),
 * the board's status grouping and stuck count (`status-groups.ts`), the
 * transition log and the owed-slot / dependency reads (`status-facts.ts`).
 */
import {
  and,
  db,
  declaredLifecycleProfilesStatement,
  drizzleSql,
  entities,
  eq,
  focusSessions,
  inArray,
  profiles,
  projects,
  projectTracks,
  ProfileResolutionService,
} from "@synap/database";
import type { ProjectTrack } from "@synap/database/schema";
import {
  findLifecycleOption,
  type LifecycleCategory,
} from "@synap-core/types/lifecycle";
import {
  OPEN_SESSION_STATUSES,
  sessionStatusCategory,
} from "@synap-core/types/focus-sessions";
import type { WaitingOnMark } from "@synap-core/types/units";
import { createLogger } from "@synap-core/core";
import { AccessContext, scopedDb } from "../../access/index.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";
import { projectLensWhere } from "../../utils/project-scope.js";
import type { ResolvedScope } from "../../utils/scope-filter.js";
import type { StartHere } from "../discover/discover.js";
import type { OpenGoalsRead } from "../discover/open-goals.js";
import { sessionScopeConditions } from "../focus-sessions/session-scope.js";
import { workAndTrackedRunsWhere } from "../focus-sessions/session-list-conditions.js";
import {
  countStuckThings,
  countThingsByProfileAndStatus,
  groupThingsByStatus,
  kindVisibilityConditions,
  stuckAfterDaysOf,
  stuckForDays,
} from "../lifecycle/status-groups.js";
import {
  addCount,
  countMovesSince,
  lastTransitionAt,
  movesOf,
  readWaitingOn,
  type CategoryCounts,
} from "./status-facts.js";

const logger = createLogger({ module: "status-rollup" });

/** "What moved" looks back this many days. */
export const ROLLUP_WINDOW_DAYS = 7;
/** Stuck things named in a space or project rollup; the count is whole. */
export const STUCK_LISTED = 5;
/** Open sessions of a scope read for what they wait on. */
const OPEN_WORK_READ_CAP = 200;

const UNAVAILABLE = { status: "unavailable" } as const;

export interface GoalRollup {
  /** When the goal entered its status (ISO); `sinceMeasured` false = created. */
  since: string | null;
  sinceMeasured: boolean;
  /** Its work sessions per category; absent when it has none. */
  work?: CategoryCounts;
  /** Status moves of the goal and its sessions in the window; absent when 0. */
  moved?: number;
  /** Absent when it waits on nothing. */
  waitingOn?: WaitingOnMark[];
}

export interface ScopeRollup {
  lens: "workspace" | "project";
  id: string;
  windowDays: number;
  /** Things with a declared lifecycle (kinds; roles are not counted here). */
  things: CategoryCounts;
  /** Work sessions per category. */
  work: CategoryCounts;
  moved: number;
  stuck: {
    count: number;
    items: Array<{
      id: string;
      name: string | null;
      kind: string;
      status: string;
      forDays: number;
    }>;
  };
  waitingOn: WaitingOnMark[];
}

const windowStart = () =>
  new Date(Date.now() - ROLLUP_WINDOW_DAYS * 86_400_000);

/** Sessions per (key, category) — the key is the goal, or one bucket. */
async function countWork(
  where: ReturnType<typeof and>,
  byTrack: boolean
): Promise<Map<string, CategoryCounts>> {
  const rows = await db
    .select({
      trackId: focusSessions.trackId,
      status: focusSessions.status,
      n: drizzleSql<number>`cast(count(*) as integer)`,
    })
    .from(focusSessions)
    .where(and(where, workAndTrackedRunsWhere()))
    .groupBy(focusSessions.trackId, focusSessions.status);
  const out = new Map<string, CategoryCounts>();
  for (const r of rows) {
    const key = byTrack ? (r.trackId ?? "") : "all";
    const counts = out.get(key) ?? {};
    addCount(counts, sessionStatusCategory(r.status), Number(r.n));
    out.set(key, counts);
  }
  return out;
}

/**
 * The rollup of each goal in `tracks` (rows the caller already read through
 * the goal visibility rule). Counts only: a goal's work and moves count every
 * member's runs, as the goal page does. Empty parts are left out, so a quiet
 * goal costs one line. THROWS on a failed read.
 */
export async function readGoalRollups(
  userId: string,
  tracks: ProjectTrack[]
): Promise<Map<string, GoalRollup>> {
  const out = new Map<string, GoalRollup>();
  if (tracks.length === 0) return out;
  const ids = tracks.map((t) => t.id);
  const inGoals = and(
    inArray(focusSessions.trackId, ids),
    workAndTrackedRunsWhere()
  );
  const { loadTrackGoalFacts } = await import("../tracks/goal-content.js");
  const [work, moved, entered, facts] = await Promise.all([
    countWork(inArray(focusSessions.trackId, ids), true),
    countMovesSince(windowStart(), [
      movesOf(
        "track",
        drizzleSql`SELECT ${projectTracks.id} AS id, ${projectTracks.id} AS key FROM ${projectTracks} WHERE ${inArray(projectTracks.id, ids)}`
      ),
      movesOf(
        "focus_session",
        drizzleSql`SELECT ${focusSessions.id} AS id, ${focusSessions.trackId} AS key FROM ${focusSessions} WHERE ${inGoals}`
      ),
    ]),
    lastTransitionAt(ids.map((id) => ({ type: "track" as const, id }))),
    loadTrackGoalFacts(tracks, userId),
  ]);
  for (const t of tracks) {
    const at = entered.get(`track:${t.id}`);
    const w = work.get(t.id);
    const m = moved.get(t.id);
    const waits = facts.get(t.id)?.waitingOn;
    out.set(t.id, {
      since: new Date(at ?? t.createdAt).toISOString(),
      sinceMeasured: at !== undefined,
      ...(w && Object.keys(w).length ? { work: w } : {}),
      ...(m ? { moved: m } : {}),
      ...(waits?.length ? { waitingOn: waits } : {}),
    });
  }
  return out;
}

/**
 * orient's open goals, each with its rollup. A failed rollup read leaves the
 * goals listed and marks each rollup `unavailable`, never zero.
 */
export async function withGoalRollups(
  userId: string,
  goals: OpenGoalsRead
): Promise<StartHere["openGoals"]> {
  if (!("items" in goals)) return goals;
  const { tracks = [], ...listed } = goals;
  let rollups: Map<string, GoalRollup> | null = null;
  try {
    rollups = await readGoalRollups(userId, tracks);
  } catch (err) {
    logger.warn({ err }, "orient: goal rollups NOT read — unavailable");
  }
  return {
    ...listed,
    rollupWindowDays: ROLLUP_WINDOW_DAYS,
    items: listed.items.map((g) => ({
      ...g,
      rollup: rollups?.get(g.id) ?? UNAVAILABLE,
    })),
  };
}

/** Things with a declared lifecycle in the lens, per category, and the stuck ones. */
async function readThings(input: {
  userId: string;
  workspaceId?: string;
  projectId?: string;
}): Promise<{ things: CategoryCounts; stuck: ScopeRollup["stuck"] }> {
  const res = (await db.execute(declaredLifecycleProfilesStatement())) as
    Array<{ profile_id: string }> | { rows: Array<{ profile_id: string }> };
  const declaredIds = (Array.isArray(res) ? res : res.rows).map(
    (r) => r.profile_id
  );
  const things: CategoryCounts = {};
  const stuck: ScopeRollup["stuck"] = { count: 0, items: [] };
  if (declaredIds.length === 0) return { things, stuck };
  const kinds = await db
    .select({ id: profiles.id, slug: profiles.slug })
    .from(profiles)
    .where(
      and(inArray(profiles.id, declaredIds), eq(profiles.profileKind, "kind"))
    );
  const slugOf = new Map(kinds.map((k) => [k.id, k.slug]));
  // A space's own things (pod-wide rows live in every space, so they belong
  // to none); a project's things, through the board's own lens.
  const conditions = kindVisibilityConditions({
    userId: input.userId,
    lensWorkspaceId: input.workspaceId,
    explicitWorkspace: input.workspaceId !== undefined,
    projectId: input.projectId,
    podScopeKind: false,
  });
  const counts = await countThingsByProfileAndStatus({
    kind: "kind",
    profileIds: [...slugOf.keys()],
    conditions,
  });
  const byProfile = new Map<string, Map<string, number>>();
  for (const c of counts) {
    if (c.status === null || c.count === 0) continue;
    const m = byProfile.get(c.profileId) ?? new Map<string, number>();
    m.set(c.status, c.count);
    byProfile.set(c.profileId, m);
  }
  const resolver = new ProfileResolutionService(db);
  const candidates: ScopeRollup["stuck"]["items"] = [];
  await Promise.all(
    [...byProfile].map(async ([profileId, statuses]) => {
      const lifecycle = await resolver.getEffectiveLifecycle(
        profileId,
        input.workspaceId ?? null
      );
      if (!lifecycle) return;
      for (const [status, n] of statuses) {
        addCount(
          things,
          (findLifecycleOption(lifecycle, status)?.category ??
            null) as LifecycleCategory | null,
          n
        );
      }
      const rules = [...stuckAfterDaysOf(lifecycle.options)].filter(([s]) =>
        statuses.has(s)
      );
      if (rules.length === 0) return;
      const subject = { kind: "kind" as const, profileIds: [profileId] };
      const [stuckCounts, groups] = await Promise.all([
        countStuckThings({
          subject,
          conditions,
          rules: rules.map(([status, days]) => ({ status, days })),
        }),
        groupThingsByStatus({
          subject,
          conditions: [
            ...conditions,
            inArray(
              entities.status,
              rules.map(([s]) => s)
            ),
          ],
          firstN: STUCK_LISTED,
          order: "time_in_column",
        }),
      ]);
      for (const n of stuckCounts.values()) stuck.count += n;
      const days = new Map(rules);
      for (const g of groups) {
        for (const i of g.items) {
          const forDays = g.status
            ? stuckForDays(i.since, days.get(g.status))
            : null;
          if (forDays === null || !g.status) continue;
          candidates.push({
            id: i.id,
            name: i.name,
            kind: slugOf.get(profileId) ?? "",
            status: g.status,
            forDays,
          });
        }
      }
    })
  );
  stuck.items = candidates
    .sort((a, b) => b.forDays - a.forDays)
    .slice(0, STUCK_LISTED);
  return { things, stuck };
}

/**
 * Where one space or one project stands. A space pin was already checked by
 * the caller (orient refuses an inaccessible `workspaceId`); a project the
 * caller cannot see is `null`, never a rollup of zeros. THROWS.
 */
export async function readScopeRollup(input: {
  userId: string;
  workspaceId?: string;
  projectId?: string;
}): Promise<ScopeRollup | null> {
  const { userId, workspaceId, projectId } = input;
  if (projectId) {
    const [visible] = await scopedDb(AccessContext.from({ userId })).findMany<{
      id: string;
    }>(projects, {
      where: eq(projects.id, projectId),
      limit: 1,
    });
    if (!visible) return null;
  }
  const lens = projectId ? "project" : "workspace";
  const id = (projectId ?? workspaceId)!;
  const scope: ResolvedScope = projectId
    ? { workspaceLens: undefined, projectLens: projectId }
    : { workspaceLens: workspaceId, projectLens: undefined };
  const sessionsInScope = and(
    sessionReadableWhere({ userId }),
    ...sessionScopeConditions(scope)
  );
  const openWork = db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      and(
        sessionsInScope,
        workAndTrackedRunsWhere(),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
      )
    )
    .limit(OPEN_WORK_READ_CAP);
  const [{ things, stuck }, work, moved, open] = await Promise.all([
    readThings({
      userId,
      ...(projectId ? { projectId } : { workspaceId }),
    }),
    countWork(sessionsInScope, false),
    // Moves of what the caller can see in the scope: its things (the entity
    // read floor), its sessions (THE session read rule) and, for a project,
    // the project's goals (the project was checked visible above).
    countMovesSince(windowStart(), [
      movesOf(
        "entity",
        drizzleSql`SELECT ${entities.id} AS id, 'all' AS key FROM ${entities} WHERE ${and(
          entityReadVisibleWhere(userId),
          projectId
            ? projectLensWhere(entities.id, projectId)
            : eq(entities.workspaceId, workspaceId!)
        )}`
      ),
      movesOf(
        "focus_session",
        drizzleSql`SELECT ${focusSessions.id} AS id, 'all' AS key FROM ${focusSessions} WHERE ${and(sessionsInScope, workAndTrackedRunsWhere())}`
      ),
      ...(projectId
        ? [
            movesOf(
              "track",
              drizzleSql`SELECT ${projectTracks.id} AS id, 'all' AS key FROM ${projectTracks} WHERE ${eq(projectTracks.projectId, projectId)}`
            ),
          ]
        : []),
    ]),
    openWork,
  ]);
  const openIds = open.map((s) => s.id);
  const waitingOn = await readWaitingOn({
    userId,
    owed: { scope },
    proposals: { sessionIds: openIds },
    blockedNodes: openIds.map((sid) => ({ kind: "session" as const, id: sid })),
  });
  return {
    lens,
    id,
    windowDays: ROLLUP_WINDOW_DAYS,
    things,
    work: work.get("all") ?? {},
    moved: moved.get("all") ?? 0,
    stuck,
    waitingOn,
  };
}
