/**
 * orient's `startHere.openGoals` — the open goals an agent's work can serve.
 * Its own module so `buildStartHere`'s shape test stubs it as a door; the read
 * itself is pinned on PGlite (`open-goals.pglite.test.ts`).
 */

import { createLogger } from "@synap-core/core";
import type { StartHere } from "./discover.js";

/** Open goals read before reporting "at least N". */
export const OPEN_GOALS_READ_CAP = 20;
/** Open goals listed by name. */
export const OPEN_GOALS_LISTED = 5;

const logger = createLogger({ module: "discover/open-goals" });

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
): Promise<StartHere["openGoals"]> {
  try {
    const [
      { AccessContext, scopedDb },
      { projectTracks, LIVE_PROJECT_TRACK_STATUSES },
      { and, eq, inArray, desc },
      { readEndState, readGoalCriteria },
    ] = await Promise.all([
      import("../../access/index.js"),
      import("@synap/database/schema"),
      import("@synap/database"),
      import("../tracks/goal-content.js"),
    ]);
    const rows = await scopedDb(AccessContext.from({ userId })).findMany<{
      id: string;
      projectId: string;
      name: string;
      status: string;
      endState: string | null;
      criteria: unknown;
    }>(projectTracks, {
      where: and(
        projectId ? eq(projectTracks.projectId, projectId) : undefined,
        inArray(projectTracks.status, [...LIVE_PROJECT_TRACK_STATUSES])
      ),
      orderBy: [desc(projectTracks.updatedAt), desc(projectTracks.id)],
      limit: OPEN_GOALS_READ_CAP,
    });
    return {
      count: rows.length,
      countIsLowerBound: rows.length >= OPEN_GOALS_READ_CAP,
      lens: projectId ? "project" : "pod",
      items: rows.slice(0, OPEN_GOALS_LISTED).map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        projectId: r.projectId,
        endState: readEndState(r.endState),
        criteria: readGoalCriteria(r.criteria).length,
      })),
      howTo:
        "Work that serves one of these goals is filed into it: start_session with its trackId (or update_session trackId on a session already open). list_tracks reads a goal in full.",
    };
  } catch (err) {
    logger.warn({ err }, "orient: open goals NOT read — unavailable");
    return { status: "unavailable" };
  }
}
