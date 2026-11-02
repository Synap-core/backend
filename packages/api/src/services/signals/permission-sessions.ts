/**
 * SESSIONS WAITING FOR YOU AT THE TERMINAL (decision D-R1, founder
 * 2026-11-01) — the needs-you population a runner's terminal wait makes: one
 * row per session one of whose LIVE runners (0384, `session-runners.ts`) says
 * it waits on the person — a permission dialog (`needs_permission`) or a
 * question / a plan to accept (`needs_answer`; the cockpit plan's named
 * default, extending D-R1 which was worded "permission"). Which words count
 * is THE rule's (`classifyRunnerWait`, `@synap-core/types/needs-you/rule`),
 * derived here from the one runner order, never listed; counted through the
 * same rows as every other item (`countNeedsYou`), never a second counter.
 * A session whose runners say both reads the more urgent word
 * (`RUNNER_STATE_ORDER`), as the session-level fold does.
 *
 * The population is the needs-you owner floor (`sessionListConditions`, the
 * same space / project / track / subject lenses): the person's own sessions,
 * work and runs alike. Unlike the review half, agent DRAFTS stay in (triage
 * lens `all`): a coding agent opens its own session (origin `agent`, never
 * accepted), and its dialog blocks it whether or not the person adopted the
 * work. Drafts out would hide every such session.
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
import {
  RUNNER_STATE_ORDER,
  runnerStateRank,
  type LiveRunnerState,
} from "@synap-core/types/units";
import { RUNNER_LIVE_WINDOW_SECONDS } from "../focus-sessions/session-runners.js";
import { OPEN_SESSION_STATUSES } from "../focus-sessions/session-statuses.js";
import { sessionListConditions } from "../focus-sessions/session-list-conditions.js";
import type { SessionSubject } from "../focus-sessions/session-subject-where.js";
import type { PermissionSessionSignalInput } from "./needs-you-union.js";

/** Sessions read at most; past it the count is a floor (`truncated`). */
export const PERMISSION_SCAN_LIMIT = 200;

/**
 * The runner words that put a session in needs-you: THE rule asked of each
 * word of the one order (an open session), never a hand-written list.
 */
export const TERMINAL_WAIT_STATES: readonly LiveRunnerState[] =
  RUNNER_STATE_ORDER.filter(
    (state) =>
      classifyRunnerWait({ status: "active", runnerState: state }) ===
      "needs_you"
  );

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
  // FROM the runners, not the sessions: the live terminal-wait rows are few,
  // so the read starts there (one grouped scan) and joins the sessions that
  // pass the floor, instead of one correlated subquery per open session.
  // Grouped by (session, word): a session whose runners say both comes back
  // once per word and is folded below. `since`: when its longest-waiting live
  // runner entered that word, the row's age.
  const waiting = database
    .select({
      sessionId: sessionRunners.sessionId,
      state: sessionRunners.state,
      since: drizzleSql<
        Date | string
      >`min(coalesce(${sessionRunners.stateSince}, ${sessionRunners.lastSeenAt}))`.as(
        "since"
      ),
    })
    .from(sessionRunners)
    .where(
      and(
        inArray(sessionRunners.state, [...TERMINAL_WAIT_STATES]),
        drizzleSql`${sessionRunners.lastSeenAt} > now() - make_interval(secs => ${RUNNER_LIVE_WINDOW_SECONDS})`
      )
    )
    .groupBy(sessionRunners.sessionId, sessionRunners.state)
    .as("waiting");
  const rows = await database
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      status: focusSessions.status,
      projectId: focusSessions.projectId,
      workspaceId: focusSessions.workspaceId,
      state: waiting.state,
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
    // At most one row per word per session: enough rows for one more
    // session than the scan keeps.
    .limit((PERMISSION_SCAN_LIMIT + 1) * TERMINAL_WAIT_STATES.length);
  // One row per session, its most urgent word (the order rows came in kept).
  const bySession = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const held = bySession.get(r.id);
    if (!held || runnerStateRank(r.state) < runnerStateRank(held.state)) {
      bySession.set(r.id, r);
    }
  }
  const folded = [...bySession.values()];
  const truncated = folded.length > PERMISSION_SCAN_LIMIT;
  const sessions = folded
    .slice(0, PERMISSION_SCAN_LIMIT)
    // THE rule decides; the SQL only found the candidates.
    .flatMap((r) => {
      const state = TERMINAL_WAIT_STATES.find((s) => s === r.state);
      if (
        !state ||
        classifyRunnerWait({ status: r.status, runnerState: state }) !==
          "needs_you"
      ) {
        return [];
      }
      return [
        {
          id: r.id,
          title: r.title ?? null,
          goal: r.goal ?? null,
          runnerState: state,
          since: new Date(r.since as Date | string),
          projectId: r.projectId ?? null,
          workspaceId: r.workspaceId ?? null,
        },
      ];
    });
  return { sessions, truncated };
}
