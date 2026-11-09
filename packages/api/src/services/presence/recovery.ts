/**
 * "I lost my passkey" (the recovery ladder, founder, 6 Nov 2026; finding
 * 7bf25c2e: the founder lost his only passkey under `enforce` and needed an
 * agent with database access to get back in).
 *
 * The slow way back, for a person who can no longer prove presence with any
 * factor:
 *  1. `request`: a signed-in person asks. Every device of theirs is told
 *     (`security.presence_recovery`, in-app and push). An email is never a
 *     proof here (an AI reads mail): a session that came from one only STARTS
 *     the wait.
 *  2. For `PRESENCE_RECOVERY_DELAY_SECONDS` (24 h), any of their signed-in
 *     sessions can `cancel` it: cancelling only takes power away.
 *  3. Then the person `complete`s it, signed in AT the pod within
 *     `PRESENCE_ENROLL_FRESH_SECONDS` (the router checks it): their device
 *     keys and 2FA app are revoked, their recovery codes deleted, and their
 *     passkeys disowned (Kratos v1.3.1 cannot remove one through its admin
 *     API, so the pod stops accepting them as a proof), and every OTHER
 *     browser session of theirs is ended (founder, answer 4819a6c3: a stolen
 *     session must not live on into a window with no factor; the browser
 *     that finished stays signed in, Relay and desktop device tokens are
 *     kept). They then add a first factor again, which needs no proof.
 *
 * Every step is audited and told to every device. One pending request per
 * person (a unique partial index): asking again returns it.
 */
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  PRESENCE_RECOVERY_DELAY_SECONDS,
  type PresenceRecoveryStatus,
} from "@synap-core/types/presence";
import {
  accountRecoveryCodes,
  and,
  db,
  desc,
  drizzleSql,
  eq,
  isNull,
  lte,
  presenceDeviceKeys,
  presenceDisownedPasskeys,
  presenceRecoveryRequests,
  presenceTotpFactors,
} from "@synap/database";
import { NotificationService } from "../../notifications/NotificationService.js";
import { auditLog } from "../../utils/audit-log.js";
import { endOtherIdentitySessions } from "../kratos-sessions.js";
import { readKratosPasskeys } from "./proof.js";

const logger = createLogger({ module: "presence-recovery" });

export interface PresenceRecoveryRequest {
  id: string;
  status: PresenceRecoveryStatus;
  requestedAt: Date;
  maturesAt: Date;
  cancelledAt: Date | null;
  completedAt: Date | null;
}

const COLUMNS = {
  id: presenceRecoveryRequests.id,
  status: presenceRecoveryRequests.status,
  requestedAt: presenceRecoveryRequests.requestedAt,
  maturesAt: presenceRecoveryRequests.maturesAt,
  cancelledAt: presenceRecoveryRequests.cancelledAt,
  completedAt: presenceRecoveryRequests.completedAt,
};

function asRequest(row: {
  id: string;
  status: string;
  requestedAt: Date;
  maturesAt: Date;
  cancelledAt: Date | null;
  completedAt: Date | null;
}): PresenceRecoveryRequest {
  return { ...row, status: row.status as PresenceRecoveryStatus };
}

/**
 * The person's pending recovery request, else their latest one, or null when
 * they never asked. Pending first, then the newest, then the last settled: a
 * request asked again in the same instant as a cancelled one must never hide
 * behind it.
 */
export async function readPresenceRecovery(
  userId: string
): Promise<PresenceRecoveryRequest | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(presenceRecoveryRequests)
    .where(eq(presenceRecoveryRequests.userId, userId))
    .orderBy(
      desc(drizzleSql`(${presenceRecoveryRequests.status} = 'pending')`),
      desc(presenceRecoveryRequests.requestedAt),
      desc(
        drizzleSql`coalesce(${presenceRecoveryRequests.completedAt}, ${presenceRecoveryRequests.cancelledAt}, ${presenceRecoveryRequests.requestedAt})`
      )
    )
    .limit(1);
  return row ? asRequest(row) : null;
}

/**
 * Tell every device of the person. A notice that cannot be written is logged
 * as an error (the audit holds the step); the step stands.
 */
async function notifyPresenceRecovery(
  userId: string,
  requestId: string,
  stage: "requested" | "cancelled" | "completed"
): Promise<void> {
  try {
    await NotificationService.create({
      type: "security.presence_recovery",
      userId,
      sourceType: "system",
      sourceId: requestId,
      data: { stage },
    });
  } catch (err) {
    logger.error(
      { err, userId, stage },
      "a passkey recovery moved, but the person could not be notified"
    );
  }
}

function audit(
  userId: string,
  requestId: string,
  action: "request" | "cancel" | "complete",
  data: Record<string, unknown> = {}
): void {
  void auditLog({
    subjectType: "presence_recovery",
    action,
    phase: "completed",
    subjectId: requestId,
    userId,
    workspaceId: null,
    data,
  });
}

/** Step 1: ask. A pending request of theirs is returned as it is. */
export async function requestPresenceRecovery(args: {
  userId: string;
  now?: Date;
}): Promise<PresenceRecoveryRequest> {
  const now = args.now ?? new Date();
  const [created] = await db
    .insert(presenceRecoveryRequests)
    .values({
      userId: args.userId,
      status: "pending",
      requestedAt: now,
      maturesAt: new Date(
        now.getTime() + PRESENCE_RECOVERY_DELAY_SECONDS * 1000
      ),
    })
    .onConflictDoNothing()
    .returning(COLUMNS);
  if (!created) {
    const pending = await readPresenceRecovery(args.userId);
    if (pending?.status === "pending") return pending;
    throw new Error("a recovery request was neither created nor found");
  }
  audit(args.userId, created.id, "request", {
    maturesAt: created.maturesAt.toISOString(),
  });
  await notifyPresenceRecovery(args.userId, created.id, "requested");
  return asRequest(created);
}

/** Step 2: cancel the pending request, from any signed-in session of the person. */
export async function cancelPresenceRecovery(args: {
  userId: string;
  now?: Date;
}): Promise<PresenceRecoveryRequest> {
  const [row] = await db
    .update(presenceRecoveryRequests)
    .set({ status: "cancelled", cancelledAt: args.now ?? new Date() })
    .where(
      and(
        eq(presenceRecoveryRequests.userId, args.userId),
        eq(presenceRecoveryRequests.status, "pending")
      )
    )
    .returning(COLUMNS);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "There is no reset waiting to cancel.",
    });
  }
  audit(args.userId, row.id, "cancel");
  await notifyPresenceRecovery(args.userId, row.id, "cancelled");
  return asRequest(row);
}

/**
 * Step 3: finish a request that waited its 24 h uncancelled. The router has
 * checked a fresh sign-in at the pod. Clears every proof factor of the person
 * in ONE transaction, under the per-person factor lock (`factors.ts`).
 */
export async function completePresenceRecovery(args: {
  userId: string;
  /** The Kratos session that finishes it: kept signed in, every other ended. */
  keepSessionId: string | null;
  now?: Date;
}): Promise<
  PresenceRecoveryRequest & {
    cleared: Record<string, number>;
    signedOut: { listed: boolean; ended: number; failed: number };
  }
> {
  const now = args.now ?? new Date();
  const pending = await readPresenceRecovery(args.userId);
  if (!pending || pending.status !== "pending") {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "There is no reset waiting. Ask for one first.",
    });
  }
  if (pending.maturesAt > now) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `The reset can be finished from ${pending.maturesAt.toISOString()}.`,
    });
  }
  // Read before the transaction: a failed read fails the step, nothing changed.
  const passkeys = await readKratosPasskeys(args.userId);

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`select pg_advisory_xact_lock(hashtextextended(${`presence-factor:${args.userId}`}, 0))`
    );
    const [done] = await tx
      .update(presenceRecoveryRequests)
      .set({ status: "completed", completedAt: now })
      .where(
        and(
          eq(presenceRecoveryRequests.id, pending.id),
          eq(presenceRecoveryRequests.status, "pending"),
          lte(presenceRecoveryRequests.maturesAt, now)
        )
      )
      .returning(COLUMNS);
    if (!done) return null;
    const devices = await tx
      .update(presenceDeviceKeys)
      .set({ revokedAt: now })
      .where(
        and(
          eq(presenceDeviceKeys.userId, args.userId),
          isNull(presenceDeviceKeys.revokedAt)
        )
      )
      .returning({ id: presenceDeviceKeys.id });
    const apps = await tx
      .update(presenceTotpFactors)
      .set({ revokedAt: now })
      .where(
        and(
          eq(presenceTotpFactors.userId, args.userId),
          isNull(presenceTotpFactors.revokedAt)
        )
      )
      .returning({ id: presenceTotpFactors.id });
    const codes = await tx
      .delete(accountRecoveryCodes)
      .where(eq(accountRecoveryCodes.userId, args.userId))
      .returning({ id: accountRecoveryCodes.id });
    if (passkeys.length > 0) {
      await tx
        .insert(presenceDisownedPasskeys)
        .values(
          passkeys.map((p) => ({
            userId: args.userId,
            credentialId: p.id,
            recoveryRequestId: pending.id,
            disownedAt: now,
          }))
        )
        .onConflictDoNothing();
    }
    return {
      request: done,
      cleared: {
        passkeys: passkeys.length,
        deviceKeys: devices.length,
        totp: apps.length,
        recoveryCodes: codes.length,
      },
    };
  });
  if (!outcome) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This reset was cancelled or finished meanwhile.",
    });
  }
  // After the factors are cleared: a session ended now cannot have added one.
  const signedOut = await endOtherIdentitySessions(
    args.userId,
    args.keepSessionId
  );
  if (!signedOut.listed || signedOut.failed > 0) {
    logger.error(
      { userId: args.userId, signedOut },
      "a passkey recovery finished, but other browser sessions may still be signed in"
    );
  }
  audit(args.userId, pending.id, "complete", {
    cleared: outcome.cleared,
    signedOut,
  });
  await notifyPresenceRecovery(args.userId, pending.id, "completed");
  return { ...asRequest(outcome.request), cleared: outcome.cleared, signedOut };
}
