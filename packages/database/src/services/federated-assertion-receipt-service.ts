/**
 * Durable replay protection for generic trusted-issuer assertions.
 *
 * Retry-safe federated mutation routes defer JTI consumption to this service.
 * Its issuer-scoped primary key makes an assertion single-use across processes
 * and after restarts without turning a transient database failure into a
 * permanent local replay rejection.
 */
import { db } from "../client-pg.js";
import { federatedAssertionReceipts } from "../schema/federation.js";

export type ConsumeFederatedAssertionReceiptResult =
  | "consumed"
  | "replayed"
  | "expired";

export async function consumeFederatedAssertionReceipt(input: {
  issuerId: string;
  jti: string;
  expiresAt: Date;
}): Promise<ConsumeFederatedAssertionReceiptResult> {
  const issuerId = input.issuerId.trim();
  const jti = input.jti.trim();
  if (!issuerId || !jti) {
    throw new Error(
      "consumeFederatedAssertionReceipt: issuerId and jti are required"
    );
  }
  if (Number.isNaN(input.expiresAt.getTime())) {
    throw new Error("consumeFederatedAssertionReceipt: expiresAt is invalid");
  }
  if (input.expiresAt <= new Date()) return "expired";

  const [receipt] = await db
    .insert(federatedAssertionReceipts)
    .values({ issuerId, jti, expiresAt: input.expiresAt })
    .onConflictDoNothing()
    .returning({ issuerId: federatedAssertionReceipts.issuerId });
  return receipt ? "consumed" : "replayed";
}
