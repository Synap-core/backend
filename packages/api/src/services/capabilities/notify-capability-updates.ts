/**
 * notifyCapabilityUpdatesAvailable
 * ================================
 *
 * Surfaces the BOOT reconcile's `updatesAvailable[]` — capabilities whose CP
 * template drifted but carry `updatePolicy:"notify"` (a human should apply the
 * update, so the engine deferred rather than auto-applying) — into the
 * first-class notifications system as ONE grouped bell item.
 *
 * The reconcile ENGINE stays pure: it only computes + returns the report. This
 * caller-side write belongs to the apps/api boot hook, which invokes this after
 * the boot reconcile pass.
 *
 * IDEMPOTENT: the boot runs on every restart. NotificationService.create() does
 * NOT de-dupe by groupKey — it always inserts. So we guard here with a STABLE
 * groupKey: skip creating a duplicate when an OPEN (unread) notification for that
 * group already exists. The bell must NOT gain a new item on every boot when
 * nothing changed.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  notifications,
  eq,
  and,
  NotificationStatus,
} from "@synap/database";
import { NotificationService } from "../../notifications/NotificationService.js";
import { resolvePodOwnerUserId } from "./pod-owner.js";
import type { CapabilityReconcileReport } from "./reconcile-capabilities-to-templates.js";

const logger = createLogger({ module: "notify-capability-updates" });

/**
 * Stable, deterministic group key — both the bell-collapse key AND the boot
 * idempotency key. No Date.now/random: a restart with unchanged drift resolves
 * to the exact same key, so the "already-open?" guard fires.
 */
export const CAPABILITY_UPDATE_GROUP_KEY = "system:capability_update_available";

/**
 * Emit ONE grouped "capability updates available" notification for the boot
 * reconcile report. No-op when there is nothing to notify, no pod owner yet, or
 * an open notification for the same drift already exists.
 */
export async function notifyCapabilityUpdatesAvailable(
  report: CapabilityReconcileReport
): Promise<void> {
  const updates = report.updatesAvailable;
  if (updates.length === 0) return;

  const ownerUserId = await resolvePodOwnerUserId();
  if (!ownerUserId) {
    logger.debug(
      "No pod owner yet (pre-bootstrap) — skipping capability-update notification"
    );
    return;
  }

  // IDEMPOTENCY GUARD: skip if an OPEN (unread) notification for this stable
  // group already exists, so a restart with unchanged drift adds nothing.
  const [existing] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, ownerUserId),
        eq(notifications.groupKey, CAPABILITY_UPDATE_GROUP_KEY),
        eq(notifications.status, NotificationStatus.UNREAD)
      )
    )
    .limit(1);

  if (existing) {
    logger.debug(
      { count: updates.length },
      "Capability-update notification already open — skipping (idempotent)"
    );
    return;
  }

  await NotificationService.create({
    type: "system.capability_update_available",
    workspaceId: null, // pod-wide (system) notification
    userId: ownerUserId,
    sourceType: "system",
    groupKey: CAPABILITY_UPDATE_GROUP_KEY,
    data: {
      count: updates.length,
      names: updates.map((u) => u.name).join(", "),
    },
  });

  logger.info(
    { count: updates.length },
    "Capability updates available — grouped bell notification emitted"
  );
}
