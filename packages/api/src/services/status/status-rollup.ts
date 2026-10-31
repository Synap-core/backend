/**
 * STATUS ROLLUPS (status-flow plan W0b) — where a goal, a project or a space
 * stands, in a few numbers: counts per category, what moved this week, what
 * is stuck, what waits. Served by orient: every open goal it lists carries
 * its `rollup` (goals first, the founder's altitude); a pinned space or
 * project adds `statusRollup`. Detail stays behind the ids (`statusOf`).
 *
 * Every number comes from an existing reader: the session population of a
 * goal (`workAndTrackedRunsWhere`, filed in it OR serving it — the `serves`
 * link, each session once per goal), the goal's waiting-on (`loadTrackGoalFacts`),
 * the board's status grouping and stuck count (`status-groups.ts`), the
 * transition log and the owed-slot / dependency reads (`status-facts.ts`).
 *
 * A goal's TREE (`statusOf`'s `include: ["rollup"]`, `readGoalTreeRollups`)
 * follows the same `serves` edges down: the goal, its sub-goals and theirs,
 * each node once however often it is reached, a loop walked once and named.
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
  links,
  listableEntityWhere,
  profiles,
  projects,
  projectTracks,
  ProfileResolutionService,
} from "@synap/database";
import type { ProjectTrack } from "@synap/database/schema";
import type { SQL } from "drizzle-orm";
import {
  findLifecycleOption,
  type LifecycleCategory,
} from "@synap-core/types/lifecycle";
import {
  OPEN_SESSION_STATUSES,
  sessionStatusCategory,
} from "@synap-core/types/focus-sessions";
import {
  countWaitKinds,
  resolveStatusTone,
  trackStatusCategory,
  type StatusOfRollup,
  type StatusOfRollupChild,
  type StatusOfRollupCounts,
  type WaitingOnMark,
  type WaitingOnSource,
} from "@synap-core/types/units";
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
  readWaitingOnSourcesFor,
  type CategoryCounts,
  type WaitingOnQuestion,
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
  /**
   * The goals that SERVE this one (`track --serves--> track`), direct only,
   * that the reader may see. Absent when none.
   */
  children?: string[];
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

/** A scope's work sessions per category. */
async function countWork(
  where: ReturnType<typeof and>
): Promise<CategoryCounts> {
  const rows = await db
    .select({
      status: focusSessions.status,
      n: drizzleSql<number>`cast(count(*) as integer)`,
    })
    .from(focusSessions)
    .where(and(where, workAndTrackedRunsWhere()))
    .groupBy(focusSessions.status);
  const counts: CategoryCounts = {};
  for (const r of rows) {
    addCount(counts, sessionStatusCategory(r.status), Number(r.n));
  }
  return counts;
}

/**
 * `(id, key, status)` = (session, goal, its status) for every work session
 * FILED in one of `goalIds` (`track_id`) or SERVING it
 * (`session --serves--> track`). `UNION`, not `UNION ALL`: a session filed in
 * AND serving the same goal is one row, so it counts once there. A session
 * filed in one goal and serving another counts in each — two goals, one row
 * each.
 */
function goalSessions(goalIds: string[]): SQL {
  const filed = and(
    inArray(focusSessions.trackId, goalIds),
    workAndTrackedRunsWhere()
  );
  // The literal (not the `SERVES_LINK_TYPE` constant) keeps this reader
  // visible to the `links-type-ssot` tripwire's typed-reader scan.
  const serving = and(
    eq(links.linkType, "serves"),
    eq(links.fromType, "session"),
    eq(links.toType, "track"),
    inArray(links.toId, goalIds),
    workAndTrackedRunsWhere()
  );
  return drizzleSql`SELECT ${focusSessions.id}::text AS id, ${focusSessions.trackId}::text AS key, ${focusSessions.status} AS status
      FROM ${focusSessions} WHERE ${filed}
    UNION
    SELECT ${focusSessions.id}::text AS id, ${links.toId} AS key, ${focusSessions.status} AS status
      FROM ${links} JOIN ${focusSessions} ON ${focusSessions.id}::text = ${links.fromId}
     WHERE ${serving}`;
}

/** Each goal's work sessions per category (filed or serving, each once). */
async function countGoalWork(
  sessions: SQL
): Promise<Map<string, CategoryCounts>> {
  const res = (await db.execute(drizzleSql`
    SELECT g.key AS k, g.status AS status, cast(count(*) as integer) AS n
      FROM (${sessions}) g
     GROUP BY g.key, g.status`)) as
    | Array<{ k: string; status: string | null; n: number }>
    | { rows: Array<{ k: string; status: string | null; n: number }> };
  const out = new Map<string, CategoryCounts>();
  for (const r of Array.isArray(res) ? res : res.rows) {
    const counts = out.get(r.k) ?? {};
    addCount(counts, sessionStatusCategory(r.status), Number(r.n));
    out.set(r.k, counts);
  }
  return out;
}

/**
 * Each goal's sub-goals: the tracks that SERVE it (`track --serves--> track`),
 * direct only, through the goal read rule — a sub-goal the reader may not see
 * is left out, never named.
 */
async function readChildGoals(
  userId: string,
  goalIds: string[]
): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ parent: links.toId, child: projectTracks.id })
    .from(links)
    .innerJoin(
      projectTracks,
      drizzleSql`${projectTracks.id}::text = ${links.fromId}`
    )
    .where(
      and(
        eq(links.linkType, "serves"),
        eq(links.fromType, "track"),
        eq(links.toType, "track"),
        inArray(links.toId, goalIds),
        scopedDb(AccessContext.operator({ userId })).predicate(projectTracks)
      )
    );
  const out = new Map<string, string[]>();
  for (const r of rows) {
    out.set(r.parent, [...(out.get(r.parent) ?? []), r.child]);
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
  // Filed in a goal OR serving it, each session once per goal — the work
  // counts and the session moves read the SAME rows, so they cannot disagree.
  const sessions = goalSessions(ids);
  const { loadTrackGoalFacts } = await import("../tracks/goal-content.js");
  const [work, moved, entered, facts, children] = await Promise.all([
    countGoalWork(sessions),
    countMovesSince(windowStart(), [
      movesOf(
        "track",
        drizzleSql`SELECT ${projectTracks.id} AS id, ${projectTracks.id} AS key FROM ${projectTracks} WHERE ${inArray(projectTracks.id, ids)}`
      ),
      movesOf(
        "focus_session",
        drizzleSql`SELECT g.id AS id, g.key AS key FROM (${sessions}) g`
      ),
    ]),
    lastTransitionAt(ids.map((id) => ({ type: "track" as const, id }))),
    loadTrackGoalFacts(tracks, userId),
    readChildGoals(userId, ids),
  ]);
  for (const t of tracks) {
    const at = entered.get(`track:${t.id}`);
    const w = work.get(t.id);
    const m = moved.get(t.id);
    const waits = facts.get(t.id)?.waitingOn;
    const kids = children.get(t.id);
    out.set(t.id, {
      since: new Date(at ?? t.createdAt).toISOString(),
      sinceMeasured: at !== undefined,
      ...(w && Object.keys(w).length ? { work: w } : {}),
      ...(m ? { moved: m } : {}),
      ...(waits?.length ? { waitingOn: waits } : {}),
      ...(kids?.length ? { children: kids } : {}),
    });
  }
  return out;
}

/** How deep a goal tree is followed down its `serves` edges. */
export const GOAL_TREE_MAX_DEPTH = 32;

/**
 * Each asked goal's TREE rollup (`include: ["rollup"]`): the goal and every
 * goal that serves it, down `serves` edges the reader may see
 * (`readChildGoals`), at most {@link GOAL_TREE_MAX_DEPTH} deep. Its work is
 * every session filed in or serving a goal of the tree (`goalSessions`),
 * each counted ONCE however many goals it reaches; a goal reached twice is
 * one node; a loop of `serves` edges (the door refuses one, an older row may
 * hold it) is cut where it closes and named (`cycle`). `stuck` = its sessions
 * the reaper found quiet (`stale`); `waits` = what its goals and open sessions
 * wait on, per wait kind — THE collector's sources (`readWaitingOnSourcesFor`,
 * the goal's container question), counted by `countWaitKinds`. Each direct
 * sub-goal gets the same numbers over its own subtree. `rootIds` are goals the
 * caller already read through the goal visibility rule. THROWS.
 */
export async function readGoalTreeRollups(
  userId: string,
  rootIds: readonly string[]
): Promise<Map<string, StatusOfRollup>> {
  const out = new Map<string, StatusOfRollup>();
  if (rootIds.length === 0) return out;
  // The graph, breadth-first: each goal expanded once.
  const childrenOf = new Map<string, string[]>();
  let frontier = [...new Set(rootIds)];
  const nodes = new Set(frontier);
  for (let depth = 0; depth < GOAL_TREE_MAX_DEPTH && frontier.length; depth++) {
    const kids = await readChildGoals(userId, frontier);
    const next: string[] = [];
    for (const parent of frontier) {
      const mine = [...new Set(kids.get(parent) ?? [])];
      childrenOf.set(parent, mine);
      for (const k of mine) {
        if (nodes.has(k)) continue;
        nodes.add(k);
        next.push(k);
      }
    }
    frontier = next;
  }

  // Each node's subtree, cycle-safe: a goal already on the path closes a loop.
  const subtree = (root: string) => {
    const seen = new Set<string>();
    let cycle = false;
    const walk = (id: string, path: Set<string>) => {
      if (path.has(id)) {
        cycle = true;
        return;
      }
      if (seen.has(id)) return;
      seen.add(id);
      path.add(id);
      for (const k of childrenOf.get(id) ?? []) walk(k, path);
      path.delete(id);
    };
    walk(root, new Set());
    return { goals: seen, cycle };
  };
  const counted = new Set<string>(rootIds);
  for (const r of rootIds) {
    for (const k of childrenOf.get(r) ?? []) counted.add(k);
  }
  const trees = new Map([...counted].map((id) => [id, subtree(id)]));

  const allIds = [...nodes];
  const [goalRows, sessionRows] = await Promise.all([
    db
      .select({
        id: projectTracks.id,
        name: projectTracks.name,
        status: projectTracks.status,
      })
      .from(projectTracks)
      .where(inArray(projectTracks.id, allIds)),
    db.execute(drizzleSql`SELECT g.id AS id, g.key AS key, g.status AS status
      FROM (${goalSessions(allIds)}) g`) as Promise<
      | Array<{ id: string; key: string; status: string | null }>
      | { rows: Array<{ id: string; key: string; status: string | null }> }
    >,
  ]);
  const goalOf = new Map(goalRows.map((g) => [g.id, g]));
  const sessionsOf = new Map<string, Set<string>>();
  const statusOf = new Map<string, string | null>();
  for (const r of Array.isArray(sessionRows) ? sessionRows : sessionRows.rows) {
    statusOf.set(r.id, r.status);
    sessionsOf.set(
      r.key,
      (sessionsOf.get(r.key) ?? new Set<string>()).add(r.id)
    );
  }
  const sessionsIn = (goals: ReadonlySet<string>) => {
    const ids = new Set<string>();
    for (const g of goals) for (const s of sessionsOf.get(g) ?? []) ids.add(s);
    return ids;
  };

  // ONE collector read: one container question per counted node.
  const open = new Set<string>(OPEN_SESSION_STATUSES);
  const questions = new Map<string, WaitingOnQuestion>();
  for (const [id, tree] of trees) {
    const goals = [...tree.goals];
    const runs = [...sessionsIn(tree.goals)].filter((s) =>
      open.has(statusOf.get(s) ?? "")
    );
    questions.set(id, {
      container: true,
      owed: { sessionIds: runs },
      proposals: { sessionIds: runs, targetIds: goals },
      blockedNodes: [
        ...goals.map((g) => ({ kind: "track" as const, id: g })),
        ...runs.map((s) => ({ kind: "session" as const, id: s })),
      ],
      holds: [
        ...goals.map((g) => ({ subjectType: "track" as const, subjectId: g })),
        ...runs.map((s) => ({
          subjectType: "focus_session" as const,
          subjectId: s,
        })),
      ],
      workUnitsOf: runs,
    });
  }
  const sources = await readWaitingOnSourcesFor({ userId }, questions);

  const countsOf = (id: string): StatusOfRollupCounts => {
    const byCategory: CategoryCounts = {};
    let stuck = 0;
    for (const s of sessionsIn(trees.get(id)!.goals)) {
      const status = statusOf.get(s) ?? null;
      addCount(byCategory, sessionStatusCategory(status), 1);
      if (status === "stale") stuck++;
    }
    return {
      byCategory,
      stuck,
      waits: countWaitKinds(sources.get(id) ?? ([] as WaitingOnSource[])),
    };
  };
  for (const r of new Set(rootIds)) {
    const tree = trees.get(r)!;
    const children: StatusOfRollupChild[] = (childrenOf.get(r) ?? [])
      .filter((k) => k !== r)
      .map((k) => {
        const g = goalOf.get(k);
        return {
          id: k,
          name: g?.name ?? null,
          status: g?.status ?? null,
          category: g ? trackStatusCategory(g.status) : null,
          tone: g?.status ? resolveStatusTone(g.status) : null,
          ...countsOf(k),
        };
      });
    out.set(r, {
      ...countsOf(r),
      goals: tree.goals.size,
      sessions: sessionsIn(tree.goals).size,
      children,
      ...(tree.cycle ? { cycle: true as const } : {}),
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
    countWork(sessionsInScope),
    // Moves of what the caller can see in the scope: its things (the entity
    // read floor), its sessions (THE session read rule) and, for a project,
    // the project's goals (the project was checked visible above).
    countMovesSince(windowStart(), [
      movesOf(
        "entity",
        drizzleSql`SELECT ${entities.id} AS id, 'all' AS key FROM ${entities} WHERE ${and(
          entityReadVisibleWhere(userId),
          // The rule `things` is counted under, so demo and probe rows never move it.
          listableEntityWhere({ projectLens: projectId }),
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
    holds: openIds.map((sid) => ({
      subjectType: "focus_session" as const,
      subjectId: sid,
    })),
    // One PR-state read for every open session of the scope.
    workUnitsOf: openIds,
  });
  return {
    lens,
    id,
    windowDays: ROLLUP_WINDOW_DAYS,
    things,
    work,
    moved: moved.get("all") ?? 0,
    stuck,
    waitingOn,
  };
}
