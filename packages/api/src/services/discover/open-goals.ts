/**
 * orient's `startHere.openGoals` — the open goals an agent's work can serve.
 * Its own module so `buildStartHere`'s shape test stubs it as a door; the read
 * itself is pinned on PGlite (`open-goals.pglite.test.ts`).
 */

import { createLogger } from "@synap-core/core";
import type { ProjectTrack } from "@synap/database/schema";
import type { StartHereUnavailable } from "./discover.js";

/** Open goals read before reporting "at least N". */
export const OPEN_GOALS_READ_CAP = 20;
/** Open goals listed by name. */
export const OPEN_GOALS_LISTED = 5;

const logger = createLogger({ module: "discover/open-goals" });

/** One open goal row as both readers need it. */
export interface OpenGoalRow {
  id: string;
  projectId: string;
  name: string;
  status: string;
  endState: string | null;
  criteria: number;
}

/** The open goals as read, before orient adds each one's rollup. */
export type OpenGoalsRead =
  | {
      count: number;
      countIsLowerBound: boolean;
      lens: "project" | "pod";
      items: OpenGoalRow[];
      /** The listed goals' rows, for their rollups (never on the wire). */
      tracks: ProjectTrack[];
      howTo: string;
    }
  | StartHereUnavailable;

/**
 * The LIVE goals (open, active, paused) the caller can see, the caller's own
 * first, then newest activity — through the `project_tracks` VisibilityRule
 * (`scopedDb`, visible iff its project is), the floor every track read uses.
 * THROWS on a failed read: each caller says `unavailable` its own way. Shared
 * by orient's `openGoals` (whose rollups read these same rows) and the start
 * door's goal offer (`start-offers.ts`).
 */
export async function listOpenGoalTracks(p: {
  userId: string;
  projectId?: string | null;
  limit: number;
}): Promise<ProjectTrack[]> {
  const [
    { AccessContext, scopedDb },
    { projectTracks, LIVE_PROJECT_TRACK_STATUSES },
    { and, eq, inArray, desc, drizzleSql },
  ] = await Promise.all([
    import("../../access/index.js"),
    import("@synap/database/schema"),
    import("@synap/database"),
  ]);
  return scopedDb(
    AccessContext.from({ userId: p.userId })
  ).findMany<ProjectTrack>(projectTracks, {
    where: and(
      p.projectId ? eq(projectTracks.projectId, p.projectId) : undefined,
      inArray(projectTracks.status, [...LIVE_PROJECT_TRACK_STATUSES])
    ),
    orderBy: [
      drizzleSql`(${projectTracks.userId} = ${p.userId}) DESC`,
      desc(projectTracks.updatedAt),
      desc(projectTracks.id),
    ],
    limit: p.limit,
  });
}

/** One open goal as orient lists it and the start door offers it. */
export async function toOpenGoalRow(r: ProjectTrack): Promise<OpenGoalRow> {
  const { readEndState, readGoalCriteria } =
    await import("../tracks/goal-content.js");
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    status: r.status,
    endState: readEndState(r.endState),
    criteria: readGoalCriteria(r.criteria).length,
  };
}

/** {@link listOpenGoalTracks}, as rows. */
export async function listOpenGoalRows(p: {
  userId: string;
  projectId?: string | null;
  limit: number;
}): Promise<OpenGoalRow[]> {
  return Promise.all((await listOpenGoalTracks(p)).map(toOpenGoalRow));
}

/**
 * The OPEN GOALS in scope (plan v5 T1): the project's when orient is scoped to
 * one, else every goal the caller can see. Read through the `project_tracks`
 * VisibilityRule (`scopedDb`, visible iff its project is) — the floor every
 * track read uses — narrowed to the LIVE statuses (open, active, paused).
 * Before this, an agent learned about goals only if it knew to call
 * `list_tracks`, so 43 of 51 open work sessions served none.
 */
export async function readOpenGoals(
  userId: string,
  projectId?: string
): Promise<OpenGoalsRead> {
  try {
    const tracks = await listOpenGoalTracks({
      userId,
      projectId,
      limit: OPEN_GOALS_READ_CAP,
    });
    const listed = tracks.slice(0, OPEN_GOALS_LISTED);
    return {
      count: tracks.length,
      countIsLowerBound: tracks.length >= OPEN_GOALS_READ_CAP,
      lens: projectId ? "project" : "pod",
      items: await Promise.all(listed.map(toOpenGoalRow)),
      tracks: listed,
      howTo:
        "Work that serves one of these goals is filed into it: start_session with its trackId (or update_session trackId on a session already open). list_tracks reads a goal in full.",
    };
  } catch (err) {
    logger.warn({ err }, "orient: open goals NOT read — unavailable");
    return { status: "unavailable" };
  }
}
