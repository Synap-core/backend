/**
 * Federation Receipt Cleanup Worker
 *
 * Federated assertions and identity-link proofs are intentionally single-use
 * and short-lived. Their expiry indexes keep this daily purge bounded while
 * preserving replay protection for the complete lifetime of each receipt.
 */

import {
  db,
  federatedAssertionReceipts,
  issuerIdentityLinkReceipts,
  lt,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "federation-receipt-cleanup" });

export const FEDERATION_RECEIPT_CLEANUP_QUEUE = "federation-receipt-cleanup";

/** Remove receipts that can no longer authorize a federated operation. */
export async function handleFederationReceiptCleanup(): Promise<void> {
  const now = new Date();

  try {
    const [assertions, identityLinks] = await Promise.all([
      db
        .delete(federatedAssertionReceipts)
        .where(lt(federatedAssertionReceipts.expiresAt, now))
        .returning({ jti: federatedAssertionReceipts.jti }),
      db
        .delete(issuerIdentityLinkReceipts)
        .where(lt(issuerIdentityLinkReceipts.expiresAt, now))
        .returning({ receiptId: issuerIdentityLinkReceipts.receiptId }),
    ]);

    if (assertions.length > 0 || identityLinks.length > 0) {
      logger.info(
        {
          assertionReceipts: assertions.length,
          identityLinkReceipts: identityLinks.length,
        },
        "Expired federation receipts deleted"
      );
    } else {
      logger.debug("No expired federation receipts to delete");
    }
  } catch (error) {
    logger.error({ error }, "Federation receipt cleanup failed");
    throw error;
  }
}
