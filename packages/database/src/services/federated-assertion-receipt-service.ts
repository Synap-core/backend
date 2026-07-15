/**
 * Durable replay protection for generic trusted-issuer assertions.
 *
 * Retry-safe federated mutation routes defer JTI consumption to this service.
 * Its issuer-scoped primary key makes an assertion single-use across processes
 * and after restarts without turning a transient database failure into a
 * permanent local replay rejection.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../client-pg.js";
import { federatedAssertionReceipts } from "../schema/federation.js";

export type ConsumeFederatedAssertionReceiptResult =
  | "consumed"
  /** The same request ceremony is recovering after a prior server failure. */
  | "recovered"
  | "replayed"
  | "expired";

export async function consumeFederatedAssertionReceipt(input: {
  issuerId: string;
  jti: string;
  expiresAt: Date;
  /**
   * Optional generic operation namespace. A matching prior context may
   * resume one interrupted request, while every different consumer still
   * receives a replay rejection for this issuer-qualified JTI.
   */
  replayContext?: string;
}): Promise<ConsumeFederatedAssertionReceiptResult> {
  const issuerId = input.issuerId.trim();
  const jti = input.jti.trim();
  const replayContext = input.replayContext?.trim() || null;
  if (!issuerId || !jti) {
    throw new Error(
      "consumeFederatedAssertionReceipt: issuerId and jti are required"
    );
  }
  if (Number.isNaN(input.expiresAt.getTime())) {
    throw new Error("consumeFederatedAssertionReceipt: expiresAt is invalid");
  }
  if (input.expiresAt <= new Date()) return "expired";
  if (replayContext && replayContext.length > 512) {
    throw new Error(
      "consumeFederatedAssertionReceipt: replayContext is too long"
    );
  }

  const [receipt] = await db
    .insert(federatedAssertionReceipts)
    .values({
      issuerId,
      jti,
      expiresAt: input.expiresAt,
      replayContext,
    })
    .onConflictDoNothing()
    .returning({ issuerId: federatedAssertionReceipts.issuerId });
  if (receipt) return "consumed";

  if (!replayContext) return "replayed";
  const existing = await db.query.federatedAssertionReceipts.findFirst({
    where: and(
      eq(federatedAssertionReceipts.issuerId, issuerId),
      eq(federatedAssertionReceipts.jti, jti),
      eq(federatedAssertionReceipts.replayContext, replayContext)
    ),
    columns: { expiresAt: true },
  });
  return existing && existing.expiresAt > new Date() ? "recovered" : "replayed";
}
