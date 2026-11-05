/**
 * A person's proof factors (W3 slice 3, founder decision 2, 4 Nov): the
 * passkeys Kratos holds and the device keys Relay enrolled.
 *
 * Adding one when the person already has one needs a proof from an EXISTING
 * one: a stolen session alone never adds a factor it controls. Every factor
 * added or removed tells the person on all their devices
 * (`security.factor_changed`, in-app and push). Losing them all goes through
 * account recovery.
 */
import {
  and,
  count,
  db,
  eq,
  isNull,
  presenceDeviceKeys,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  presenceKeyFingerprint,
  type PresenceProof,
} from "@synap-core/types/presence";
import { NotificationService } from "../../notifications/NotificationService.js";
import { assertPresenceForRequest } from "./gate.js";
import { readPasskeys } from "./proof.js";

const logger = createLogger({ module: "presence-factors" });

/**
 * Does the person hold a factor that can prove presence? A failed read of
 * their passkeys throws: it is never "no factor", which would let a session
 * add one unapproved.
 */
export async function hasProofFactor(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(presenceDeviceKeys)
    .where(
      and(
        eq(presenceDeviceKeys.userId, userId),
        isNull(presenceDeviceKeys.revokedAt)
      )
    );
  if (Number(row?.n ?? 0) > 0) return true;
  return (await readPasskeys(userId)).length > 0;
}

/**
 * May this person enrol this new device key? Their first factor rests on the
 * fresh sign-in `enrollChallenge` checked. Once they hold one, an EXISTING
 * factor must prove `device_enroll:<fingerprint of the new key>` (refused
 * under `enforce` without it, recorded in `report`).
 */
export async function assertMayEnrollDeviceKey(args: {
  userId: string;
  publicKey: string;
  proof?: PresenceProof | null;
}): Promise<void> {
  if (!(await hasProofFactor(args.userId))) return;
  await assertPresenceForRequest({
    userId: args.userId,
    kind: "device_enroll",
    id: await presenceKeyFingerprint(args.publicKey),
    proof: args.proof ?? null,
    door: "presence.devices.enroll",
  });
}

/**
 * Tell the person a factor was added or removed. The change has already
 * landed; a notification that cannot be written is logged as an error (the
 * audit log still holds the change), never silently dropped.
 */
export async function notifyFactorChanged(args: {
  userId: string;
  change: "added" | "removed" | "changed";
  factor: "passkey" | "device_key";
  label: string | null;
  id: string;
}): Promise<void> {
  try {
    await NotificationService.create({
      type: "security.factor_changed",
      userId: args.userId,
      sourceType: "system",
      sourceId: args.id,
      data: {
        change: args.change,
        factor: args.factor,
        what: args.factor === "passkey" ? "A passkey" : "A device key",
        verb:
          args.change === "added"
            ? "was added to"
            : args.change === "removed"
              ? "was removed from"
              : "was added to or removed from",
        label: args.label ?? "Just now",
      },
    });
  } catch (err) {
    logger.error(
      { err, userId: args.userId, change: args.change, factor: args.factor },
      "a proof factor changed, but the person could not be notified"
    );
  }
}
