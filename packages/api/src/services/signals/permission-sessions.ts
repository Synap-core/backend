/**
 * SESSIONS WAITING FOR YOUR PERMISSION (decision D-R1, founder 2026-11-01) —
 * the needs-you population a runner's `needs_permission` makes: one row per
 * session one of whose LIVE runners (0384, `session-runners.ts`) says it
 * waits on a permission dialog, classified by THE rule
 * (`classifyRunnerWait`, `@synap-core/types/needs-you/rule`) and counted
 * through the same rows as every other item (`countNeedsYou`), never a
 * second counter.
 *
 * The population is the needs-you owner floor (`sessionListConditions`, the
 * same space / project / track / subject lenses): the person's own sessions,
 * work and runs alike. Unlike the review half, agent DRAFTS stay in (triage
 * lens `all`): a coding agent opens its own session (origin `agent`, never
 * accepted), and its permission dialog blocks it whether or not the person
 * adopted the work. Drafts out would hide every such session.
 * "Live" is the runner read's own window (`RUNNER_LIVE_WINDOW_SECONDS`): a
 * runner gone quiet says nothing about now. A failed read THROWS (an empty
 * list would read as "nobody waits on you").
 *
 * SESSION-KIND-LENS-EXEMPT: returns `session-permission` SIGNAL inputs (id, title, goal, since, project, space), never a session row; the population is sessionListConditions, with lens `all` + kind `all` on purpose (above).
 */
import {
  and,
  db,
  desc,
  drizzleSql,
  eq,
  focusSessions,
  inArray,
  sessionRunners,
} from "@synap/database";
import { classifyRunnerWait } from "@synap-core/types/needs-you/rule";
import { RUNNER_LIVE_WINDOW_SECONDS } from "../focus-sessions/session-runners.js";
import { OPEN_SESSION_STATUSES } from "../focus-sessions/session-statuses.js";
import { sessionListConditions } from "../focus-sessions/session-list-conditions.js";
import type { SessionSubject } from "../focus-sessions/session-subject-where.js";
import type { PermissionSessionSignalInput } from "./needs-you-union.js";

/** Sessions read at most; past it the count is a floor (`truncated`). */
export const PERMISSION_SCAN_LIMIT = 200;

export async function listSessionsWaitingForPermission(q: {
  userId: string;
  workspaceId?: string | null;
  projectId?: string;
  trackId?: string;
  sessionId?: string;
  subject?: SessionSubject;
  database?: typeof db;
}): Promise<{ sessions: PermissionSessionSignalInput[]; truncated: boolean }> {
  const database = q.database ?? db;
  const conditions = sessionListConditions({
    userId: q.userId,
    scope: { workspaceLens: q.workspaceId, projectLens: q.projectId },
    status: "all",
    lens: "all",
    kind: "all",
    ...(q.trackId ? { trackId: q.trackId } : {}),
    ...(q.subject ? { subject: q.subject } : {}),
  });
  if (q.sessionId)
    conditions.push(drizzleSql`${focusSessions.id} = ${q.sessionId}`);
  // FROM the runners, not the sessions: the live `needs_permission` rows are
  // few, so the read starts there (one grouped scan) and joins the sessions
  // that pass the floor, instead of one correlated subquery per open session.
  // `since`: when its longest-waiting live runner entered the state, the
  // row's age.
  const waiting = database
    .select({
      sessionId: sessionRunners.sessionId,
      since: drizzleSql<
        Date | string
      >`min(coalesce(${sessionRunners.stateSince}, ${sessionRunners.lastSeenAt}))`.as(
        "since"
      ),
    })
    .from(sessionRunners)
    .where(
      and(
        eq(sessionRunners.state, "needs_permission"),
        drizzleSql`${sessionRunners.lastSeenAt} > now() - make_interval(secs => ${RUNNER_LIVE_WINDOW_SECONDS})`
      )
    )
    .groupBy(sessionRunners.sessionId)
    .as("waiting");
  const rows = await database
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      status: focusSessions.status,
      projectId: focusSessions.projectId,
      workspaceId: focusSessions.workspaceId,
      since: waiting.since,
    })
    .from(waiting)
    .innerJoin(focusSessions, eq(focusSessions.id, waiting.sessionId))
    .where(
      and(
        ...conditions,
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
      )
    )
    .orderBy(desc(focusSessions.updatedAt), desc(focusSessions.id))
    .limit(PERMISSION_SCAN_LIMIT + 1);
  const truncated = rows.length > PERMISSION_SCAN_LIMIT;
  const sessions = rows
    .slice(0, PERMISSION_SCAN_LIMIT)
    // THE rule decides; the SQL only found the candidates.
    .filter(
      (r) =>
        classifyRunnerWait({
          status: r.status,
          runnerState: "needs_permission",
        }) === "needs_you"
    )
    .map((r) => ({
      id: r.id,
      title: r.title ?? null,
      goal: r.goal ?? null,
      since: new Date(r.since as Date | string),
      projectId: r.projectId ?? null,
      workspaceId: r.workspaceId ?? null,
    }));
  return { sessions, truncated };
}
