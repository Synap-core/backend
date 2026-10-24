/**
 * R10 — the duty to report has a timer (work model W3, 2026-10-23).
 *
 * A delegate who reports their commitment on a goal IMPOSSIBLE has refused
 * it (never the goal's verdict — R1). The owner or judge acknowledges the
 * report. When nobody has after {@link TRACK_REPORT_ESCALATE_AFTER_HOURS}
 * (48 h), the goal's OWNER is told — ONE notification per report, through the
 * one notification door (`createNotificationViaService` →
 * `NotificationService.create`), type `track.report_unacknowledged`. Unread,
 * it is an item in the owner's Needs you (registry `needsYou` default);
 * acknowledging the report marks it actioned
 * (`services/tracks/track-participants.ts`).
 *
 * Runs on the focus-session reaper's hourly tick (`focus-session-reaper.ts`)
 * rather than a cron of its own. ONCE per report: the row is CLAIMED
 * (`escalated_at = now()`) in the same statement that selects it, so two ticks
 * can never both notify; a new report (after the owner asks again) clears the
 * stamp and starts a new clock. The door never throws (`createNotificationViaService`
 * logs its own failures and returns nothing): a row it did not write — a muted
 * type, or a slot unfilled at boot (logged as an ERROR there) — stays claimed.
 * Once per report means at most once, never a retry loop.
 */

import {
  db,
  and,
  eq,
  inArray,
  isNull,
  drizzleSql,
  trackParticipants,
  projectTracks,
  projects,
  users,
  LIVE_PROJECT_TRACK_STATUSES,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  TRACK_REPORT_ESCALATE_AFTER_HOURS,
  goalOwner,
  trackReportGroupKey,
} from "@synap-core/types/units";
import { createNotificationViaService } from "../utils/notification-creator.js";

const logger = createLogger({ module: "track-report-escalation" });

/**
 * A report that is due: impossible, unacknowledged, not yet escalated, older
 * than the timer, on a goal that is still LIVE — a closed or dropped goal
 * asks nobody for anything (code.md, 2026-10-24). Exported so a test can lock
 * its shape. The cutoff is computed in SQL (no Date bind — postgres.js 3.4.8
 * on the pod image, see the reaper).
 */
export const TRACK_REPORT_IS_DUE = and(
  eq(trackParticipants.commitmentState, "reported_impossible"),
  isNull(trackParticipants.acknowledgedAt),
  isNull(trackParticipants.escalatedAt),
  drizzleSql`${trackParticipants.reportedAt} < now() - (${TRACK_REPORT_ESCALATE_AFTER_HOURS}::int * interval '1 hour')`,
  // No `drizzleSql.join` here: this is built at module load, and suites that
  // stub `@synap/database` import it through the cron graph.
  drizzleSql`EXISTS (SELECT 1 FROM ${projectTracks} WHERE ${projectTracks.id} = ${trackParticipants.trackId} AND ${projectTracks.status} IN ${[...LIVE_PROJECT_TRACK_STATUSES]})`
);

/** Tell each due report's goal owner, once. Returns how many were told. */
export async function escalateUnacknowledgedReports(): Promise<number> {
  const claimed = await db
    .update(trackParticipants)
    .set({ escalatedAt: drizzleSql`now()` })
    .where(TRACK_REPORT_IS_DUE)
    .returning({
      id: trackParticipants.id,
      trackId: trackParticipants.trackId,
      principalId: trackParticipants.principalId,
      commitment: trackParticipants.commitment,
      reportedReason: trackParticipants.reportedReason,
      reportedAt: trackParticipants.reportedAt,
    });
  if (claimed.length === 0) return 0;

  const trackIds = [...new Set(claimed.map((r) => r.trackId))];
  const [goals, roles, people] = await Promise.all([
    db
      .select({
        id: projectTracks.id,
        name: projectTracks.name,
        userId: projectTracks.userId,
        workspaceId: projects.workspaceId,
      })
      .from(projectTracks)
      .innerJoin(projects, eq(projects.id, projectTracks.projectId))
      .where(inArray(projectTracks.id, trackIds)),
    db
      .select({
        trackId: trackParticipants.trackId,
        role: trackParticipants.role,
        principalId: trackParticipants.principalId,
      })
      .from(trackParticipants)
      .where(
        and(
          inArray(trackParticipants.trackId, trackIds),
          eq(trackParticipants.role, "owner")
        )
      ),
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(
        inArray(users.id, [...new Set(claimed.map((r) => r.principalId))])
      ),
  ]);

  let told = 0;
  for (const report of claimed) {
    const goal = goals.find((g) => g.id === report.trackId);
    if (!goal) continue; // deleted between the claim and the read
    const owner = goalOwner(
      roles.filter((r) => r.trackId === goal.id),
      goal
    );
    const delegate =
      people.find((p) => p.id === report.principalId)?.name?.trim() ||
      "A delegate";
    const written = await createNotificationViaService({
      type: "track.report_unacknowledged",
      userId: owner,
      workspaceId: goal.workspaceId,
      sourceType: "track",
      sourceId: goal.id,
      groupKey: trackReportGroupKey(report.id, report.reportedAt!),
      data: {
        trackId: goal.id,
        trackName: goal.name,
        participantId: report.id,
        delegateName: delegate,
        commitment: report.commitment ?? "their part",
        reason: report.reportedReason ?? "",
        hours: TRACK_REPORT_ESCALATE_AFTER_HOURS,
      },
    });
    if (written) told++;
    else {
      logger.warn(
        { participantId: report.id, trackId: goal.id },
        "R10 escalation not written by the notification door (muted, or the slot is unfilled)"
      );
    }
  }
  return told;
}
