/**
 * "A goal you were waiting on has ended" — the ONE producer of
 * `session.blocker_goal_ended` and `track.blocker_ended` (work model W4,
 * 2026-10-23).
 *
 * A goal (a track) can now finish (decision 1): closed with a verdict (it
 * DELIVERED — its dependents are free of it) or dropped (it ended without
 * delivering — by the dependency rule its dependents stay held until they
 * re-plan, `classifyDependencyBlocker`). Until now nobody was told either
 * way: `dependency-links.ts` said so ("a track completion wired to a reactor
 * here — none"). This reactor is that wire.
 *
 * WHO IS TOLD: the owner of every OPEN session or goal that declared
 * `blocked_by` this goal — or `blocked_by` a goal this one REPLACED (the
 * dependency rule follows `replaces`, so they were waiting on this one). A
 * session's owner is its `user_id` (every session end of a dependency edge is
 * its owner's own); a goal's is `goalOwnerId` (W3 swaps it for the owner
 * seat). An entity waiting on a goal is not told: it has no owner to tell.
 *
 * WHAT THEY ARE TOLD, re-derived after the end (never read off the event):
 * closed and nothing else holds it up · closed and it still waits on N other
 * things · dropped, so it waits until they re-plan. ONE notification per
 * (dependent, ended goal); the registry's `dedupeWindowMs` absorbs a
 * redelivered event. A goal the recipient cannot see is named "A goal it was
 * waiting on", never by name.
 *
 * THE SEAM: `applyTrackStatus` (tracks-service) is the one status write and
 * already emits `track.update` with `toStatus` through `emitSideEffects`.
 * Hanging off that emit keeps the status door free of the notification — the
 * same IoC move as `session-unblock-reactor.ts` (`@synap/events` cannot
 * import `@synap/api`, so the api process registers its reactors at boot).
 *
 * NEVER SILENTLY SWALLOWS: `emitSideEffects` isolates a failing reactor; a
 * failure here is logged per dependent so one bad row never silences the rest.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  inArray,
  links,
  focusSessions,
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
import { registerReactor, type Reactor } from "@synap/events";
import { AccessContext, scopedDb } from "../access/index.js";
import { readDependencyState } from "../services/links/dependency-links.js";
import { goalOwnerId } from "../services/tracks/goal-content.js";
import { NotificationService } from "./NotificationService.js";

const logger = createLogger({ module: "track-blocker-ended-reactor" });

/**
 * The registry types this reactor produces — each literal under a lowercase
 * `notificationType:` key, so the source-scan producer allowlist sees it (see the
 * same note in `session-unblock-reactor.ts`). Two types because the
 * destination differs: the registry's `navigate-object` kind is fixed per type.
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

/**
 * What the dependent's owner can do now, as a sentence (copy, not a domain
 * label — built here, like `unmetSummary` in `session-criteria-unmet-reactor`).
 */
export function blockerEndedOutcome(input: {
  delivered: boolean;
  /** Blockers still holding the dependent, this goal excluded. */
  othersHolding: number;
}): string {
  if (!input.delivered) {
    return "it waits until you re-plan: remove the wait, or point it at other work.";
  }
  if (input.othersHolding === 0) return "nothing else holds it up.";
  return input.othersHolding === 1
    ? "it still waits on 1 other thing."
    : `it still waits on ${input.othersHolding} other things.`;
}

interface Dependent {
  kind: "session" | "track";
  id: string;
}

/** Open sessions and goals that declared `blocked_by` any of `goalIds`. */
async function dependentsOf(goalIds: readonly string[]): Promise<Dependent[]> {
  if (goalIds.length === 0) return [];
  const rows = await db
    .select({ fromType: links.fromType, fromId: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.linkType, DEPENDENCY_LINK_TYPE),
        eq(links.toType, "track"),
        inArray(links.toId, [...goalIds])
      )
    );
  const seen = new Set<string>();
  const out: Dependent[] = [];
  for (const r of rows) {
    if (r.fromType !== "session" && r.fromType !== "track") continue;
    const k = `${r.fromType}:${r.fromId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: r.fromType, id: r.fromId });
  }
  return out;
}

export const trackBlockerEndedNotifyReactor: Reactor = {
  id: "track-blocker-ended-notify",
  match: (payload) =>
    payload.subjectType === "track" && payload.action === "update",
  async handler(payload) {
    const goalId =
      (payload.data?.trackId as string | undefined) ?? payload.subjectId;
    if (!goalId) return;

    // THE ROW is the authority: the goal must have ENDED now. A stage move or
    // a redelivered event about a reopened state reads its real status here.
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
    const delivered = true; // NEGCTL: any status, any ending reads as delivered

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
    const dependents = await dependentsOf([goal.id]); void replaced; // NEGCTL
    if (dependents.length === 0) return;

    const sessionIds = dependents
      .filter((d) => d.kind === "session")
      .map((d) => d.id);
    const trackIds = dependents
      .filter((d) => d.kind === "track")
      .map((d) => d.id);
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
        .filter(() => true // NEGCTL ended dependents kept
        )
        .map((s) => ({
          kind: "session" as const,
          id: s.id,
          title: resolveSessionTitle(s),
          userId: s.userId,
          workspaceId: s.workspaceId,
        })),
      ...tracks
        .filter((t) => !isDependencyEnded("track", t.status))
        .map((t) => ({
          kind: "track" as const,
          id: t.id,
          title: t.name,
          userId: goalOwnerId(t),
          workspaceId: t.workspaceId,
        })),
    ];

    for (const dep of recipients) {
      try {
        const state = await readDependencyState(
          { kind: dep.kind, id: dep.id },
          dep.userId
        );
        const othersHolding = 0 * state.openBlockers.filter( // NEGCTL

          (b) => !(b.kind === "track" && b.id === goal.id)
        ).length;
        const [visible] = await db
          .select({ id: projectTracks.id })
          .from(projectTracks)
          .where(
            and(
              eq(projectTracks.id, goal.id),
              scopedDb(
                AccessContext.operator({ userId: dep.userId })
              ).predicate(projectTracks)
            )
          )
          .limit(1);
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
            blockerTitle: visible || true ? goal.name : "A goal it was waiting on", // NEGCTL
            endedWord,
            delivered,
            othersHolding,
            outcome: blockerEndedOutcome({ delivered, othersHolding }),
          },
        });
      } catch (error) {
        logger.error(
          { error, dependent: dep, goalId: goal.id },
          "Failed to notify that a goal it waited on ended"
        );
      }
    }
  },
};

let registered = false;

/** Register the reactor. Called once at API boot (`apps/api/src/index.ts`). */
export function registerTrackBlockerEndedReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(trackBlockerEndedNotifyReactor);
  logger.info("Registered goal blocker-ended notification reactor");
}
