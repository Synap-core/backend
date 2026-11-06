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
import { createLogger } from "@synap-core/core";
import {
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
import { readPresenceMode } from "./mode.js";
import {
  hasProofFactor,
  PresenceError,
  presencePodOrigin,
  verifyDeviceSignature,
} from "./proof.js";

const logger = createLogger({ module: "presence-factors" });

export { hasProofFactor };

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
}): Promise<{ id: string }> {
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
    if (held && !verdict && mode === "enforce") {
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
    if (!spent) return { kind: "used" as const };
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
      unproved: held && !verdict,
    };
  });

  if (outcome.kind === "refused") {
    throw await presenceRequiredError({
      userId: args.userId,
      subject: presenceRequestSubject(subject.kind, subject.id),
    });
  }
  if (outcome.kind === "used") {
    throw new PresenceError(PRESENCE_USED, "This challenge was used.");
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
  return { id: outcome.id };
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
  factor: "passkey" | "device_key";
  label: string | null;
}): {
  change: "added" | "removed" | "changed";
  factor: "passkey" | "device_key";
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
      data: factorChangedData(args),
    });
  } catch (err) {
    logger.error(
      { err, userId: args.userId, change: args.change, factor: args.factor },
      "a proof factor changed, but the person could not be notified"
    );
  }
}
