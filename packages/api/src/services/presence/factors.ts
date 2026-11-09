/**
 * A person's proof factors (W3 slice 3, founder decision 2, 4 Nov; the
 * recovery ladder, 6 Nov): the passkeys Kratos holds, the device keys Relay
 * and the desktop app enrolled, their 2FA app (`totp.ts`) and their unused
 * recovery codes.
 *
 * Adding one when the person already has one needs a proof from an EXISTING
 * one: a stolen session alone never adds a factor it controls. Every factor
 * added or removed tells the person on all their devices
 * (`security.factor_changed`, in-app and push). Under `enforce`, a removal
 * never leaves fewer than two ways in (`assertKeepsTwoWaysIn`). Losing them
 * all goes through "I lost my passkey" (`recovery.ts`).
 */
import { createLogger } from "@synap-core/core";
import {
  PRESENCE_ENFORCE_MIN_WAYS,
  PRESENCE_NEEDS_TWO_WAYS,
  presenceWaysIn,
  type PresenceFactorCounts,
  enrollmentSubject,
  PRESENCE_EXPIRED,
  PRESENCE_INVALID,
  PRESENCE_REQUEST_KINDS,
  PRESENCE_USED,
  presenceKeyFingerprint,
  presenceMessage,
  presenceRequestSubject,
  type PresenceProof,
} from "@synap-core/types/presence";
import { TRPCError } from "@trpc/server";
import {
  and,
  db,
  drizzleSql,
  eq,
  gt,
  isNull,
  presenceChallenges,
  presenceDeviceKeys,
} from "@synap/database";
import { NotificationService } from "../../notifications/NotificationService.js";
import {
  assertPresenceForRequest,
  presenceRequiredError,
  recordMissing,
} from "./gate.js";
import { redeemDeviceLink } from "./device-link.js";
import { readPresenceMode } from "./mode.js";
import {
  hasProofFactor,
  PresenceError,
  presenceFactorCounts,
  presencePodOrigin,
  verifyDeviceSignature,
} from "./proof.js";

const logger = createLogger({ module: "presence-factors" });

/** The kinds of factor a `security.factor_changed` notice names. */
export type PresenceFactorKind =
  "passkey" | "device_key" | "totp" | "recovery_codes";

export { hasProofFactor, presenceFactorCounts };

/**
 * Enrol a device key (step 2 of `presence.devices.enroll`): the new key's
 * signature over its enrolment challenge (proof of possession), then the
 * factor decision, then the challenge spent and the key stored.
 *
 * The decision is ONE first factor per person, made inside the transaction
 * that stores the key, under a per-person advisory lock (review of 6 Nov:
 * `hasProofFactor` and the insert were two steps, so two concurrent first
 * enrolments both saw "no factor" and both skipped the proof). The person's
 * first factor rests on the fresh sign-in `enrollChallenge` checked; once
 * they hold one, an EXISTING factor must prove `device_enroll:<fingerprint
 * of the new key>` (refused under `enforce` without it, recorded in
 * `report`). A proof sent is checked and spent before the lock is taken.
 *
 * "Add this device" (founder decision of 9 Nov 2026, session 84c74a23): a
 * device link a device the person already uses approved for THIS session
 * and THIS key (`device-link.ts`) stands for that proof. It is redeemed in
 * the same transaction, under the lock, so a refused or failed enrolment
 * gives it back.
 *
 * Throws `PresenceError` (the router maps it) or the gate's refusal.
 * Not covered: a first PASSKEY added in Kratos' settings flow at the same
 * moment as a first device key (Kratos writes it outside this lock).
 */
export async function enrollDeviceKey(args: {
  userId: string;
  challengeId: string;
  label: string;
  publicKey: string;
  signature: string;
  proof?: PresenceProof | null;
  /** The enrolling session (`callerSessionKey`): the one an approved device link is redeemed by. */
  sessionKey?: string | null;
  /** The approved device link the client names, when it has one. */
  deviceLinkId?: string | null;
}): Promise<{ id: string; viaDeviceLink: boolean }> {
  const challenge = await db.query.presenceChallenges.findFirst({
    where: and(
      eq(presenceChallenges.id, args.challengeId),
      eq(presenceChallenges.userId, args.userId)
    ),
  });
  if (!challenge || challenge.subject !== enrollmentSubject(challenge.id)) {
    throw new PresenceError(PRESENCE_INVALID, "Unknown challenge.");
  }
  if (challenge.consumedAt) {
    throw new PresenceError(PRESENCE_USED, "This challenge was used.");
  }
  if (challenge.expiresAt <= new Date()) {
    throw new PresenceError(PRESENCE_EXPIRED, "This challenge expired.");
  }
  const message = presenceMessage({
    podOrigin: presencePodOrigin(),
    challengeId: challenge.id,
    subject: challenge.subject,
    nonce: challenge.nonce,
  });
  if (!verifyDeviceSignature(args.publicKey, message, args.signature)) {
    throw new PresenceError(
      PRESENCE_INVALID,
      "This key did not sign the enrolment challenge."
    );
  }

  const fingerprint = await presenceKeyFingerprint(args.publicKey);
  const subject = { kind: "device_enroll" as const, id: fingerprint };
  const door = "presence.devices.enroll";
  // A proof that was sent is checked (and spent) before the lock, when the
  // person holds a factor it could come from (a first enrolment ignores it,
  // as before).
  const verdict =
    args.proof && (await hasProofFactor(args.userId))
      ? await assertPresenceForRequest({
          userId: args.userId,
          ...subject,
          proof: args.proof,
          door,
        })
      : null;
  const { mode } = await readPresenceMode();

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`select pg_advisory_xact_lock(hashtextextended(${`presence-factor:${args.userId}`}, 0))`
    );
    const held = await hasProofFactor(args.userId, tx);
    // An approved device link of this session, for this very key, is the
    // proof an existing factor gave from another device.
    const viaDeviceLink =
      held && !verdict
        ? await redeemDeviceLink({
            userId: args.userId,
            sessionKey: args.sessionKey ?? null,
            kind: "device_key",
            keyFingerprint: fingerprint,
            id: args.deviceLinkId ?? null,
            tx,
          })
        : false;
    if (held && !verdict && !viaDeviceLink && mode === "enforce") {
      return { kind: "refused" as const };
    }
    const [spent] = await tx
      .update(presenceChallenges)
      .set({ consumedAt: new Date(), method: "device_key" })
      .where(
        and(
          eq(presenceChallenges.id, challenge.id),
          isNull(presenceChallenges.consumedAt),
          gt(presenceChallenges.expiresAt, new Date())
        )
      )
      .returning({ id: presenceChallenges.id });
    // Thrown, not returned: the rollback gives a redeemed device link back.
    if (!spent) {
      throw new PresenceError(PRESENCE_USED, "This challenge was used.");
    }
    const [row] = await tx
      .insert(presenceDeviceKeys)
      .values({
        userId: args.userId,
        label: args.label,
        publicKey: args.publicKey,
      })
      .returning({ id: presenceDeviceKeys.id });
    return {
      kind: "enrolled" as const,
      id: row!.id,
      viaDeviceLink,
      unproved: held && !verdict && !viaDeviceLink,
    };
  });

  if (outcome.kind === "refused") {
    throw await presenceRequiredError({
      userId: args.userId,
      subject: presenceRequestSubject(subject.kind, subject.id),
    });
  }
  if (outcome.unproved) {
    await recordMissing({
      userId: args.userId,
      subject: presenceRequestSubject(subject.kind, subject.id),
      what: subject.kind,
      reason: PRESENCE_REQUEST_KINDS.device_enroll,
      door,
    });
  }
  return { id: outcome.id, viaDeviceLink: outcome.viaDeviceLink };
}

/**
 * The `security.factor_changed` notification's data: tokens only, the
 * registry row owns the words. `label` is the factor's own name (null when
 * there is none, as on a Kratos passkey change), and `named` says which: an
 * ICU select cannot test for a missing value, so the body drops its label
 * sentence on `named: "no"`.
 */
export function factorChangedData(args: {
  change: "added" | "removed" | "changed";
  factor: PresenceFactorKind;
  label: string | null;
}): {
  change: "added" | "removed" | "changed";
  factor: PresenceFactorKind;
  named: "yes" | "no";
  label: string | null;
} {
  const label = args.label?.trim() || null;
  return {
    change: args.change,
    factor: args.factor,
    named: label ? "yes" : "no",
    label,
  };
}

/**
 * Tell the person a factor was added or removed. The change has already
 * landed; a notification that cannot be written is logged as an error (the
 * audit log still holds the change), never silently dropped.
 */
export async function notifyFactorChanged(args: {
  userId: string;
  change: "added" | "removed" | "changed";
  factor: PresenceFactorKind;
  label: string | null;
  id: string;
}): Promise<void> {
  try {
    await NotificationService.create({
      type: "security.factor_changed",
      userId: args.userId,
      sourceType: "system",
      sourceId: args.id,
      data: factorChangedData(args),
    });
  } catch (err) {
    logger.error(
      { err, userId: args.userId, change: args.change, factor: args.factor },
      "a proof factor changed, but the person could not be notified"
    );
  }
}

/** The refusal of a removal that would leave fewer than two ways in under `enforce`. */
export const PRESENCE_NEEDS_TWO_WAYS_MESSAGE =
  "Approvals need you in person on this pod, so keep two ways to confirm it is you. Add another one first (an authenticator app or recovery codes), or, if you lost it, use “I lost my passkey”.";

/**
 * "Two ways in" (the recovery ladder, founder, 6 Nov 2026): under `enforce`,
 * a removal that would leave the person fewer than
 * `PRESENCE_ENFORCE_MIN_WAYS` ways to prove presence is refused. It guards
 * the person against locking themselves out, not against a thief: a removal
 * takes power away. In `report` nothing is refused. A failed read throws.
 */
export async function assertKeepsTwoWaysIn(args: {
  userId: string;
  /** What the person holds once the removal landed. */
  after: (now: PresenceFactorCounts) => PresenceFactorCounts;
}): Promise<void> {
  const { mode } = await readPresenceMode();
  if (mode !== "enforce") return;
  const now = await presenceFactorCounts(args.userId);
  if (presenceWaysIn(args.after(now)) >= PRESENCE_ENFORCE_MIN_WAYS) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: PRESENCE_NEEDS_TWO_WAYS_MESSAGE,
    cause: { reasonCode: PRESENCE_NEEDS_TWO_WAYS },
  });
}
