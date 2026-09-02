import { inArray, and, eq } from "drizzle-orm";
import { db } from "@synap/database";
import { notifications } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "proposal-notifications" });

/**
 * A proposal's notification rows leave the bell the moment the proposal stops
 * being decidable — approved, rejected, or expired. ONE door for all three:
 * the approve path had this and reject did not, so a rejected proposal's
 * "Approve / Reject" notification stayed unread forever and the bell count
 * drifted from the decisions count.
 *
 * Fire-and-forget: notifications must never break the proposal flow.
 */
export function markProposalNotificationsActioned(
  proposalIds: readonly string[]
): void {
  if (proposalIds.length === 0) return;
  db.update(notifications)
    .set({ status: "actioned", readAt: new Date() })
    .where(
      and(
        eq(notifications.sourceType, "proposal"),
        inArray(notifications.sourceId, [...proposalIds])
      )
    )
    .then(() => {
      logger.debug(
        { count: proposalIds.length },
        "Proposal notifications marked as actioned"
      );
    })
    .catch((err) => {
      logger.warn(
        { err, count: proposalIds.length },
        "Failed to mark proposal notifications as actioned (non-fatal)"
      );
    });
}
