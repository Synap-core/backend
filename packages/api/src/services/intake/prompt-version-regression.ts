/**
 * Tell the pod admins, ONCE, when a newer prompt version is clearly worse.
 *
 * The trigger is `detectPromptVersionRegressions` over the POD-WIDE quality
 * report (`quality-by-prompt-version.ts` — thresholds and their rationale live
 * there). Run daily by the `intake.prompt-quality-scan` cron via the jobs IoC
 * slot.
 *
 * ── A NOTIFICATION, NOT A PROPOSAL (the choice, stated) ─────────────────────
 * There is nothing for approval to DO: the prompt lives in the IS, and no pod
 * write reverts it. The one acknowledgement-only proposal kind that exists,
 * `governance.advisory`, validates an agent/motif payload in
 * `apply-approval.ts`; reusing it would mean a new payload shape through a
 * governance executor for a finding with no executor. A registry notification
 * (`intake.prompt_version_regression`) is the existing store for "a human
 * should know this" and needs no executor.
 *
 * ── ONCE ────────────────────────────────────────────────────────────────────
 * Idempotency key: `(type, sourceId = regressionSourceId(r), userId)` on the
 * durable `notifications` rows — the same shape `notify-pod-wide-proposal.ts`
 * uses for `proposal.created`. A daily tick re-detecting the same regression
 * tells no one twice; an admin added later is still told. A notification the
 * recipient muted is not persisted, so it is re-attempted (and re-muted) —
 * never counted as `notified`.
 *
 * A FAILED quality read THROWS: the job fails visibly instead of reporting
 * "no regression" off a read that never happened.
 */

import { createLogger } from "@synap-core/core";
import { db, and, eq, notifications } from "@synap/database";
import { NotificationService } from "../../notifications/NotificationService.js";
import { resolvePodAdminUserIds } from "../capabilities/pod-owner.js";
import {
  gatherQualityByPromptVersion,
  type PromptVersionRegression,
} from "./quality-by-prompt-version.js";

const logger = createLogger({ module: "prompt-version-regression" });

export const PROMPT_VERSION_REGRESSION_NOTIFICATION =
  "intake.prompt_version_regression";

/** Stable identity of one regression — the notification's `sourceId`. */
export function regressionSourceId(r: PromptVersionRegression): string {
  return `prompt-regression:${JSON.stringify([
    r.engine,
    r.model,
    r.previous.promptVersion,
    r.newer.promptVersion,
  ])}`;
}

export async function notifyPromptVersionRegressions(
  opts: { now?: Date } = {}
): Promise<{
  regressions: number;
  notified: number;
  recipients: number;
  /** Set when a scan hit its cap: the verdict covers a partial window. */
  skipped?: "truncated";
}> {
  const report = await gatherQualityByPromptVersion({
    userId: null,
    now: opts.now,
  });
  // A capped scan compares the most recent rows only — a "regression" there
  // can be an artefact of where the cut fell. Say so in the log; tell no one.
  if (report.truncated.sessions || report.truncated.proposals) {
    logger.warn(
      {
        truncated: report.truncated,
        regressions: report.regressions.length,
      },
      "prompt-version regression scan truncated — not notifying off a partial scan"
    );
    return {
      regressions: report.regressions.length,
      notified: 0,
      recipients: 0,
      skipped: "truncated",
    };
  }
  if (report.regressions.length === 0) {
    return { regressions: 0, notified: 0, recipients: 0 };
  }

  const recipients = await resolvePodAdminUserIds();
  let notified = 0;

  for (const r of report.regressions) {
    const sourceId = regressionSourceId(r);
    const already = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, PROMPT_VERSION_REGRESSION_NOTIFICATION),
          eq(notifications.sourceId, sourceId)
        )
      );
    const told = new Set(already.map((row) => row.userId));
    for (const userId of recipients) {
      if (told.has(userId)) continue;
      const id = await NotificationService.create({
        type: "intake.prompt_version_regression",
        sourceType: "system",
        sourceId,
        userId,
        workspaceId: null,
        data: {
          promptVersion: r.newer.promptVersion,
          previousPromptVersion: r.previous.promptVersion,
          newerRejectPct: Math.round(r.newer.rejectRate * 100),
          previousRejectPct: Math.round(r.previous.rejectRate * 100),
          newerDecided: r.newer.decided,
          previousDecided: r.previous.decided,
          engine: r.engine,
          model: r.model ?? "no model",
        },
      });
      if (id) notified += 1;
    }
    logger.warn(
      { regression: r, recipients: recipients.length },
      "prompt-version regression detected"
    );
  }

  return {
    regressions: report.regressions.length,
    notified,
    recipients: recipients.length,
  };
}
