/**
 * U4 — tell the pod owner when an update did not land.
 *
 * The host-side engine (`synap update`) records every outcome in
 * deploy/state/last-update.json, which the backend reads through its read-only
 * deploy mount (`apps/api/src/pod-updates`). A rollback RECREATES the backend,
 * so the boot that follows is the natural moment to read it: apps/api calls
 * this once per boot with the projected outcome.
 *
 * ONE door: `NotificationService.create` (preferences, routing, the bell), to
 * the pod owner + admins (`resolvePodAdminUserIds`) — the same audience as a
 * pod-wide proposal. Pod-wide (`workspaceId: null`), `sourceType: "system"`.
 *
 * IDEMPOTENT per update id and recipient: `(sourceType='system',
 * sourceId='pod-update:<updateId>', type, userId)` is durable state, so every
 * later boot that re-reads the same file is a no-op, and an admin added later
 * still gets told. The Control Plane emails the same outcome separately (it
 * dedupes on its own `pod_updates` row) — the two channels are independent on
 * purpose: a self-hosted pod has no CP, and a CP email must not depend on the
 * pod being healthy enough to boot.
 */

import { createLogger } from "@synap-core/core";
import { db, and, eq, notifications } from "@synap/database";
import { NotificationService } from "./NotificationService.js";
import { resolvePodAdminUserIds } from "../services/capabilities/pod-owner.js";

const logger = createLogger({ module: "pod-update-outcome" });

const notificationType = "pod.update_failed";
export const POD_UPDATE_FAILED_NOTIFICATION_TYPE = notificationType;

export interface PodUpdateOutcomeInput {
  updateId: string;
  status: string;
  from: string | null;
  to: string | null;
  reason: string | null;
  dbRestored: boolean;
}

const NOTIFY = new Set(["rolled_back", "rollback_failed", "failed"]);

/** The headline + detail copy for one outcome. Pure. Null ⇒ no notification. */
export function describePodUpdateOutcome(
  o: PodUpdateOutcomeInput
): { headline: string; detail: string } | null {
  if (!NOTIFY.has(o.status)) return null;
  const why = o.reason ? ` (${o.reason})` : "";
  const previous = o.from ?? "the previous version";
  if (o.status === "rolled_back") {
    return {
      headline: "was rolled back",
      detail: `The update failed${why}. Your pod is running ${previous} again${
        o.dbRestored ? ", with its data restored from the pre-update backup" : ""
      }.`,
    };
  }
  if (o.status === "rollback_failed") {
    return {
      headline: "failed and needs attention",
      detail: `The update failed${why} and the automatic rollback did not complete. Run \`synap doctor\` on the pod host.`,
    };
  }
  return {
    headline: "failed",
    detail: `The update failed${why}. Your pod is still on ${previous}.`,
  };
}

export interface PodUpdateOutcomeDeps {
  recipients(): Promise<string[]>;
  alreadyNotified(sourceId: string): Promise<Set<string>>;
  create(input: Parameters<typeof NotificationService.create>[0]): Promise<
    string | undefined
  >;
}

const defaultDeps: PodUpdateOutcomeDeps = {
  recipients: resolvePodAdminUserIds,
  alreadyNotified: async (sourceId) => {
    const rows = await db.query.notifications.findMany({
      where: and(
        eq(notifications.sourceType, "system"),
        eq(notifications.sourceId, sourceId),
        eq(notifications.type, POD_UPDATE_FAILED_NOTIFICATION_TYPE)
      ),
      columns: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  },
  create: (input) => NotificationService.create(input),
};

/** Returns how many recipients were newly notified. Never throws. */
export async function notifyPodUpdateOutcome(
  outcome: PodUpdateOutcomeInput,
  deps: PodUpdateOutcomeDeps = defaultDeps
): Promise<number> {
  const copy = describePodUpdateOutcome(outcome);
  if (!copy) return 0;
  const sourceId = `pod-update:${outcome.updateId}`;
  try {
    const recipients = await deps.recipients();
    if (recipients.length === 0) return 0;
    const already = await deps.alreadyNotified(sourceId);
    let sent = 0;
    for (const userId of recipients) {
      if (already.has(userId)) continue;
      const id = await deps.create({
        type: POD_UPDATE_FAILED_NOTIFICATION_TYPE,
        userId,
        workspaceId: null,
        sourceType: "system",
        sourceId,
        data: {
          version: outcome.to ?? "the new release",
          headline: copy.headline,
          detail: copy.detail,
          status: outcome.status,
        },
      });
      if (id) sent++;
    }
    return sent;
  } catch (err) {
    logger.warn(
      { err, updateId: outcome.updateId, status: outcome.status },
      "Pod update outcome notification failed (non-fatal)"
    );
    return 0;
  }
}
