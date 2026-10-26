/**
 * "The last thing you were waiting on is done" — the ONE producer of
 * `session.unblocked`.
 *
 * THE RULE (Asana's, and the reason this is a reactor and not a line inside the
 * close door): a session waiting on three blockers is NOT unblocked when the
 * first one closes. The notification fires exactly once, when the set of
 * blockers that are still OPEN becomes empty. So this reactor never reasons
 * from the close event alone — it re-derives `openBlockerIds(dependent)` after
 * the close and stays silent unless that set is empty.
 *
 * A DROPPED blocker is not an unblocking (founder decision, 2026-10-22). The
 * close door emits the same event for `cancelled` and `failed` as for
 * `closed`, but only a `closed` blocker DELIVERED: one that ended without
 * delivering stays in `openBlockerIds` (marked dropped) until the dependent
 * re-plans, so the derivation above keeps this reactor silent for it.
 *
 * THE SEAM: `complete-session.ts` is the only close door, and it already emits
 * `focus_session.closed` through `emitSideEffects`. Registering a reactor off
 * that emit means the close door does not have to remember the notification —
 * the same IoC move `pod-wide-proposal-reactor.ts` makes, and for the same
 * reason (`@synap/events` cannot import `@synap/api`, so the api process
 * registers its own reactors at boot).
 *
 * TWO KINDS OF WAIT, ONE NOTIFICATION. A session can be waiting on another
 * either because someone DECLARED it (`blocked_by`) or because it targets an
 * object another open session is producing (`session-output-edges.ts`, derived
 * — no edge of its own). Both are the same news to the person waiting, so the
 * dependent set is the UNION and the "last open blocker" rule spans BOTH: a
 * dependent still waiting on an output is not unblocked by a declared blocker
 * closing, and vice versa. Splitting this into a second reactor would send two
 * notifications for one unblocking and give each half a blind spot.
 *
 * A GOAL ENDING IS ONE MORE BLOCKER ENDING (code-core F6, 2026-10-24). A
 * session or goal can wait on a goal (`blocked_by` a track, or a track that
 * goal REPLACED). The status door's `track.update` carries the move
 * (`toStatus`); when it ends a goal, the same rule runs: a CLOSED goal
 * delivered, so a dependent is told only when nothing else holds it — a
 * session through `session.unblocked`, a waiting goal through
 * `track.blocker_ended`; a DROPPED goal did not deliver, and that is the one
 * new piece of news: the dependent waits until its owner re-plans
 * (`session.blocker_goal_ended` / `track.blocker_ended`). A goal the
 * recipient cannot see is named "A goal it was waiting on", never by name.
 * A `track.update` with no status move (direction, loop, a stage) never
 * matches.
 *
 * IDEMPOTENT on `(dependent, closed blocker)`, keyed on the durable
 * notification row's `groupKey` rather than on ordering — a re-delivered or
 * replayed close event is a no-op. Deliberately NOT keyed on the dependent
 * alone: a session can legitimately be blocked again later and unblocked again,
 * and that second unblocking is real news.
 *
 * NEVER THROWS: `emitSideEffects` isolates a failing reactor, but a swallowed
 * failure here would leave no evidence that nobody was told their work can
 * resume — so failures are logged.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  inArray,
  focusSessions,
  links,
  notifications,
  projectTracks,
  projects,
} from "@synap/database";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  DEPENDENCY_LINK_TYPE,
  REPLACES_LINK_TYPE,
  classifyDependencyBlocker,
  isDependencyEnded,
} from "@synap-core/types/connections";
import { resolveTrackStatusLabel } from "@synap-core/types/vocabulary";
import {
  registerReactor,
  type Reactor,
  type SideEffectPayload,
} from "@synap/events";
import { AccessContext, scopedDb } from "../access/index.js";
import { readDependencyState } from "../services/links/dependency-links.js";
import { goalOwnerToAsk } from "../services/tracks/goal-content.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_CLOSE_ACTION,
} from "../services/focus-sessions/close-event.js";
import {
  getSessionEdgesFor,
  openBlockerIds,
  replacedBlockerDependents,
} from "../services/focus-sessions/session-blocked-by.js";
import {
  outputDependentsOf,
  openOutputBlockerIds,
} from "../services/focus-sessions/session-output-edges.js";
import { NotificationService } from "./NotificationService.js";

const logger = createLogger({ module: "session-unblock-reactor" });

/**
 * The registry type this reactor produces — declared under the lowercase name
 * first on purpose. `notification-producer-allowlist.test.ts` proves a registry
 * row has a producer by scanning source for the literal next to a
 * case-SENSITIVE `(type|notificationType)\s*[:=?]`, so a SCREAMING_SNAKE
 * declaration is invisible to it and a real producer reads as a dead row.
 */
const notificationType = "session.unblocked" as const;

const SESSION_UNBLOCKED_NOTIFICATION_TYPE = notificationType;

/** `(dependent, blocker)` — the natural identity of "this unblocking". */
function unblockGroupKey(sessionId: string, blockerId: string): string {
  return `${SESSION_UNBLOCKED_NOTIFICATION_TYPE}:${sessionId}:${blockerId}`;
}

/**
 * The types a GOAL ending produces besides `session.unblocked` — each literal
 * under a lowercase `notificationType:` key, so the source-scan producer
 * allowlist sees it. Two because the destination differs: the registry's
 * `navigate-object` kind is fixed per type.
 */
export const BLOCKER_ENDED_TYPES = {
  session: { notificationType: "session.blocker_goal_ended" },
  track: { notificationType: "track.blocker_ended" },
} as const;
export const SESSION_BLOCKER_GOAL_ENDED_TYPE =
  BLOCKER_ENDED_TYPES.session.notificationType;
export const TRACK_BLOCKER_ENDED_TYPE =
  BLOCKER_ENDED_TYPES.track.notificationType;

/** `(dependent, ended goal)` — the natural identity of this news. */
export function blockerEndedGroupKey(
  type: string,
  dependentId: string,
  goalId: string
): string {
  return `${type}:${dependentId}:${goalId}`;
}

/** What the dependent's owner can do now, as a sentence (copy). */
export function blockerEndedOutcome(delivered: boolean): string {
  return delivered
    ? "nothing else holds it up."
    : "it waits until you re-plan: remove the wait, or point it at other work.";
}

/** A status move that ENDS a goal — the only `track.update` this reacts to. */
function endsGoal(payload: SideEffectPayload): boolean {
  if (payload.subjectType !== "track" || payload.action !== "update") {
    return false;
  }
  const to = payload.data?.toStatus;
  return (
    typeof to === "string" && classifyDependencyBlocker("track", to) !== "open"
  );
}

export const sessionUnblockNotifyReactor: Reactor = {
  id: "session-unblock-notify",
  match: (payload) =>
    (payload.subjectType === FOCUS_SESSION_SUBJECT_TYPE &&
      payload.action === FOCUS_SESSION_CLOSE_ACTION) ||
    endsGoal(payload),
  async handler(payload) {
    if (payload.subjectType === "track") {
      await goalEnded(payload);
      return;
    }
    const closedId =
      (payload.data?.sessionId as string | undefined) ?? payload.subjectId;
    if (!closedId) return;

    // Inbound `blocked_by` edges — the sessions that DECLARED they were
    // waiting on this one.
    const { unblocks } = await getSessionEdgesFor(closedId);

    // The closed session's goal, for the body. `complete-session.ts` DOES put
    // `goal` on the payload, but this reads the row anyway: the payload shape
    // is the close door's contract with the automation matcher, not with this
    // reactor, and the row is the one authority on what the session is called.
    // It is also the owner floor for the output-dependent read below, which is
    // why it now runs on EVERY close rather than only on one with declared
    // dependents — the derived half cannot be looked up without a userId.
    const [closedRow] = await db
      .select({
        id: focusSessions.id,
        title: focusSessions.title,
        goal: focusSessions.goal,
        userId: focusSessions.userId,
      })
      .from(focusSessions)
      .where(eq(focusSessions.id, closedId))
      .limit(1);
    if (!closedRow) return;
    // The session's NAME (title, else the goal's first line) — never the goal
    // paragraph, which is what a notification used to quote.
    const closed = { ...closedRow, title: resolveSessionTitle(closedRow) };

    // Sessions waiting on an OUTPUT of this one. Read AFTER the close, which
    // is why this uses `outputDependentsOf` and not the open-only reader: to
    // the latter a closed producer is history and reports nothing. This is the
    // set that WAS waiting a moment ago. Nothing is announced early — each
    // dependent's own remaining waits are re-derived below.
    const outputsWaitedOnBy = await outputDependentsOf(closedId, closed.userId);

    // Sessions waiting on a step this one REPLACED (`closed --replaces--> X`):
    // by the dependency rule they were waiting on THIS session, though no
    // edge names it. Their remaining waits are re-derived below like any
    // other dependent's.
    const waitingOnReplaced = await replacedBlockerDependents(closedId);

    const dependentIds = [
      ...new Set([
        ...unblocks,
        ...waitingOnReplaced,
        ...outputsWaitedOnBy.map((o) => o.dependentSessionId),
      ]),
    ];
    if (dependentIds.length === 0) return;

    const dependents = (
      await db
        .select({
          id: focusSessions.id,
          title: focusSessions.title,
          goal: focusSessions.goal,
          userId: focusSessions.userId,
          workspaceId: focusSessions.workspaceId,
        })
        .from(focusSessions)
        .where(inArray(focusSessions.id, dependentIds))
    ).map((d) => ({ ...d, title: resolveSessionTitle(d) }));

    for (const dependent of dependents) {
      try {
        // THE DERIVATION, across BOTH kinds of wait. Anything still open ⇒
        // still blocked ⇒ stay silent. `openBlockerIds` is the ONE dependency
        // rule (`deriveOpenBlockers`): it spans cross-kind blockers (an entity
        // or track this session waits on) and follows `replaces`.
        const stillOpen = await openBlockerIds(dependent.id);
        if (stillOpen.length > 0) continue;
        const stillWaitingOnOutputs = await openOutputBlockerIds(
          dependent.id,
          dependent.userId
        );
        if (stillWaitingOnOutputs.length > 0) continue;

        const groupKey = unblockGroupKey(dependent.id, closedId);
        const [already] = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, dependent.userId),
              eq(notifications.type, SESSION_UNBLOCKED_NOTIFICATION_TYPE),
              eq(notifications.groupKey, groupKey)
            )
          )
          .limit(1);
        if (already) continue;

        await NotificationService.create({
          type: SESSION_UNBLOCKED_NOTIFICATION_TYPE,
          userId: dependent.userId,
          workspaceId: dependent.workspaceId,
          sourceType: "system",
          // The UNBLOCKED session is the destination — the registry's
          // `navigate-object` action reads this as its object id.
          sourceId: dependent.id,
          groupKey,
          data: {
            sessionId: dependent.id,
            sessionTitle: dependent.title,
            blockerSessionId: closedId,
            blockerTitle: closed?.title ?? "A blocking session",
          },
        });
      } catch (error) {
        logger.error(
          { error, sessionId: dependent.id, blockerSessionId: closedId },
          "Failed to notify session unblocked"
        );
      }
    }
  },
};

/**
 * A goal ENDED (closed or dropped): the same "last open blocker" rule for
 * everything that waited on it (see the file header).
 */
async function goalEnded(payload: SideEffectPayload): Promise<void> {
  const goalId =
    (payload.data?.trackId as string | undefined) ?? payload.subjectId;
  if (!goalId) return;

  // THE ROW is the authority: the goal must have ended NOW (a redelivered
  // event about a goal reopened since reads its real status here).
  const [goal] = await db
    .select({
      id: projectTracks.id,
      name: projectTracks.name,
      status: projectTracks.status,
    })
    .from(projectTracks)
    .where(eq(projectTracks.id, goalId))
    .limit(1);
  if (!goal) return;
  const outcome = classifyDependencyBlocker("track", goal.status);
  if (outcome === "open") return;
  const delivered = outcome === "delivered";

  // Waiting on this goal: directly, or on a goal it replaced.
  const replaced = (
    await db
      .select({ id: links.toId })
      .from(links)
      .where(
        and(
          eq(links.linkType, REPLACES_LINK_TYPE),
          eq(links.fromType, "track"),
          eq(links.fromId, goal.id),
          eq(links.toType, "track")
        )
      )
  ).map((r) => r.id);
  const waiting = await db
    .select({ fromType: links.fromType, fromId: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.linkType, DEPENDENCY_LINK_TYPE),
        eq(links.toType, "track"),
        inArray(links.toId, [goal.id, ...replaced])
      )
    );
  const sessionIds = [
    ...new Set(
      waiting.filter((w) => w.fromType === "session").map((w) => w.fromId)
    ),
  ];
  const trackIds = [
    ...new Set(
      waiting.filter((w) => w.fromType === "track").map((w) => w.fromId)
    ),
  ];
  if (sessionIds.length === 0 && trackIds.length === 0) return;

  const [sessions, tracks] = await Promise.all([
    sessionIds.length > 0
      ? db
          .select({
            id: focusSessions.id,
            title: focusSessions.title,
            goal: focusSessions.goal,
            status: focusSessions.status,
            userId: focusSessions.userId,
            workspaceId: focusSessions.workspaceId,
          })
          .from(focusSessions)
          .where(inArray(focusSessions.id, sessionIds))
      : Promise.resolve([]),
    trackIds.length > 0
      ? db
          .select({
            id: projectTracks.id,
            name: projectTracks.name,
            status: projectTracks.status,
            userId: projectTracks.userId,
            workspaceId: projects.workspaceId,
          })
          .from(projectTracks)
          .innerJoin(projects, eq(projects.id, projectTracks.projectId))
          .where(inArray(projectTracks.id, trackIds))
      : Promise.resolve([]),
  ]);

  const endedWord = resolveTrackStatusLabel(goal.status).toLowerCase();
  const recipients = [
    ...sessions
      .filter((s) => !isDependencyEnded("session", s.status))
      .map((s) => ({
        kind: "session" as const,
        id: s.id,
        title: resolveSessionTitle(s),
        userId: s.userId,
        workspaceId: s.workspaceId,
      })),
    ...(await Promise.all(
      tracks
        .filter((t) => !isDependencyEnded("track", t.status))
        .map(async (t) => ({
          kind: "track" as const,
          id: t.id,
          title: t.name,
          userId: await goalOwnerToAsk(t),
          workspaceId: t.workspaceId,
        }))
    )),
  ];

  for (const dep of recipients) {
    try {
      // A delivered goal frees the dependent only when NOTHING else holds it
      // — the rule every blocker follows (a dropped one is still open: it
      // holds until a re-plan, and that IS the news).
      if (delivered) {
        if (dep.kind === "session") {
          if ((await openBlockerIds(dep.id)).length > 0) continue;
          if ((await openOutputBlockerIds(dep.id, dep.userId)).length > 0) {
            continue;
          }
        } else {
          const state = await readDependencyState(
            { kind: "track", id: dep.id },
            dep.userId
          );
          if (state.openBlockers.length > 0) continue;
        }
      }
      const [visible] = await db
        .select({ id: projectTracks.id })
        .from(projectTracks)
        .where(
          and(
            eq(projectTracks.id, goal.id),
            scopedDb(AccessContext.operator({ userId: dep.userId })).predicate(
              projectTracks
            )
          )
        )
        .limit(1);
      const blockerTitle = visible ? goal.name : "A goal it was waiting on";

      if (delivered && dep.kind === "session") {
        const groupKey = unblockGroupKey(dep.id, goal.id);
        const [already] = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, dep.userId),
              eq(notifications.type, SESSION_UNBLOCKED_NOTIFICATION_TYPE),
              eq(notifications.groupKey, groupKey)
            )
          )
          .limit(1);
        if (already) continue;
        await NotificationService.create({
          type: SESSION_UNBLOCKED_NOTIFICATION_TYPE,
          userId: dep.userId,
          workspaceId: dep.workspaceId,
          sourceType: "system",
          sourceId: dep.id,
          groupKey,
          data: {
            sessionId: dep.id,
            sessionTitle: dep.title,
            blockerGoalId: goal.id,
            blockerTitle,
          },
        });
        continue;
      }

      const type =
        dep.kind === "session"
          ? SESSION_BLOCKER_GOAL_ENDED_TYPE
          : TRACK_BLOCKER_ENDED_TYPE;
      await NotificationService.create({
        type,
        userId: dep.userId,
        workspaceId: dep.workspaceId,
        sourceType: dep.kind,
        // The DEPENDENT is the destination — where the person acts (resume
        // or re-plan); the registry's `navigate-object` reads this id.
        sourceId: dep.id,
        groupKey: blockerEndedGroupKey(type, dep.id, goal.id),
        data: {
          dependentId: dep.id,
          dependentTitle: dep.title,
          blockerGoalId: goal.id,
          blockerTitle,
          endedWord,
          delivered,
          outcome: blockerEndedOutcome(delivered),
        },
      });
    } catch (error) {
      logger.error(
        { error, dependent: dep, goalId: goal.id },
        "Failed to notify that a goal it waited on ended"
      );
    }
  }
}

let registered = false;

/** Register the reactor. Called once at API boot (`apps/api/src/index.ts`). */
export function registerSessionUnblockReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(sessionUnblockNotifyReactor);
  logger.info("Registered session unblock notification reactor");
}
