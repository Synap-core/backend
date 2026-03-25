/**
 * Vault Grant Expiry Worker
 *
 * Runs every hour. Finds approved vault.request proposals where:
 *   data->>'approvedAt' + (data->>'ttl')::int minutes < now
 *
 * Marks them as 'rejected' with a rejectionReason of 'expired' so the
 * vault resolver stops granting new access via these proposals.
 *
 * NOTE: The proposals status column is a text field; 'rejected' is the
 * closest semantic match in the existing ProposalStatus enum for an
 * elapsed grant. The rejectionReason distinguishes these from user rejections.
 */

import { db, eq, and, isNotNull } from "@synap/database";
import { sql } from "drizzle-orm";
import { proposals, ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "vault-grant-expiry-worker" });

export const VAULT_GRANT_EXPIRY_QUEUE = "vault-grant-expiry";

/**
 * Called by the cron scheduler every hour.
 * Expires approved vault.request proposals whose TTL has elapsed.
 */
export async function handleVaultGrantExpiry(): Promise<void> {
  // Find approved vault.request proposals where ttl has elapsed.
  // TTL and approvedAt are stored in the proposal's data JSONB field.
  // Only process proposals where data->>'ttl' is set (> 0) to avoid
  // accidentally expiring indefinite grants.
  const expired = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, ProposalStatus.APPROVED),
        eq(proposals.proposalType, "vault.request"),
        isNotNull(proposals.data),
        sql`
          (data->>'ttl') IS NOT NULL
          AND (data->>'ttl')::int > 0
          AND (data->>'approvedAt') IS NOT NULL
          AND (data->>'approvedAt')::timestamptz
            + ((data->>'ttl')::int || ' minutes')::interval
            < now()
        `
      )
    );

  if (expired.length === 0) {
    logger.debug("No expired vault grants found");
    return;
  }

  logger.info({ count: expired.length }, "Expiring vault grants");

  for (const proposal of expired) {
    await db
      .update(proposals)
      .set({
        status: ProposalStatus.REJECTED,
        rejectionReason: "expired",
        updatedAt: new Date(),
      })
      .where(eq(proposals.id, proposal.id));
  }

  logger.info({ count: expired.length }, "Vault grants expired");
}
