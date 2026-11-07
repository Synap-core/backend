/**
 * A person's 2FA app as a proof of presence (the recovery ladder, founder,
 * 6 Nov 2026: a lost only-passkey must never lock a person out again).
 *
 * The pod holds the secret (an encrypted field, `presence_totp_factors.secret`),
 * not Kratos: Kratos v1.3.1 does not run the `totp` method on our pods, and
 * turning it on would make every session check ask for a second factor
 * (`session.whoami.required_aal` defaults to `highest_available`).
 *
 * A code is accepted once (`totp-code.ts`): the factor's `last_used_step`
 * only moves forward, by a conditional update, so a replayed code (or one of
 * an earlier step) loses.
 *
 * Adding the app follows the device-key rule (`factors.ts`): its first code
 * proves the app holds the secret; a person who already holds a factor
 * approves it with that factor (`totp_enroll:<id>`), and a person who holds
 * none rests on a fresh sign-in (the router checks it). Removing it only
 * takes power away, but never leaves a pod in `enforce` with fewer than two
 * ways in (`assertKeepsTwoWaysIn`).
 */
import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  PRESENCE_REQUEST_KINDS,
  presenceRequestSubject,
  type PresenceProof,
} from "@synap-core/types/presence";
import {
  and,
  db,
  drizzleSql,
  encryptServiceKey,
  eq,
  gt,
  isNull,
  presenceTotpFactors,
} from "@synap/database";
import {
  assertPresenceForRequest,
  presenceRequiredError,
  recordMissing,
} from "./gate.js";
import { readPresenceMode } from "./mode.js";
import { hasProofFactor } from "./proof.js";
import {
  activeTotpFactor,
  base32Encode,
  matchTotpStep,
  otpauthUri,
  readSecret,
} from "./totp-code.js";

export {
  acceptTotpCode,
  activeTotpFactor,
  matchTotpStep,
  totpCode,
  totpStepAt,
} from "./totp-code.js";

/** How long an unconfirmed 2FA app may wait for its first code. */
export const TOTP_PENDING_SECONDS = 15 * 60;

/**
 * Step 1 of adding a 2FA app: a new secret, stored encrypted and unconfirmed.
 * A person keeps ONE app: with one in use, this is refused (remove it first).
 * An earlier unconfirmed secret of theirs is dropped.
 */
export async function beginTotpEnrolment(args: {
  userId: string;
  label: string;
  account: string;
  issuer: string;
}): Promise<{ id: string; secret: string; otpauthUri: string }> {
  if (await activeTotpFactor(args.userId)) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "You already use a 2FA app here. Remove it first to set up another one.",
    });
  }
  const id = crypto.randomUUID();
  const secret = base32Encode(crypto.randomBytes(20));
  await db.transaction(async (tx) => {
    await tx
      .delete(presenceTotpFactors)
      .where(
        and(
          eq(presenceTotpFactors.userId, args.userId),
          isNull(presenceTotpFactors.confirmedAt)
        )
      );
    await tx.insert(presenceTotpFactors).values({
      id,
      userId: args.userId,
      label: args.label,
      secret: encryptServiceKey(secret, {
        column: "presence_totp_factors.secret",
        rowId: id,
      }),
    });
  });
  return {
    id,
    secret,
    otpauthUri: otpauthUri({
      secret,
      account: args.account,
      issuer: args.issuer,
    }),
  };
}

/**
 * Step 2: the app's first code proves it holds the secret; then the factor
 * decision of `enrollDeviceKey`, under the same per-person lock. A proof
 * from an existing factor (`totp_enroll:<id>`) is checked and spent before
 * the lock. Throws the gate's refusal, or BAD_REQUEST for a wrong code.
 */
export async function confirmTotpEnrolment(args: {
  userId: string;
  id: string;
  code: string;
  proof?: PresenceProof | null;
  now?: Date;
}): Promise<{ id: string; label: string }> {
  const now = args.now ?? new Date();
  const pending = await db.query.presenceTotpFactors.findFirst({
    where: and(
      eq(presenceTotpFactors.id, args.id),
      eq(presenceTotpFactors.userId, args.userId),
      isNull(presenceTotpFactors.confirmedAt),
      isNull(presenceTotpFactors.revokedAt),
      gt(
        presenceTotpFactors.createdAt,
        new Date(now.getTime() - TOTP_PENDING_SECONDS * 1000)
      )
    ),
  });
  if (!pending) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "This setup expired. Start again.",
    });
  }
  const step = matchTotpStep(readSecret(pending), args.code, now);
  if (step === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This code doesn't match. Check the app shows Synap, then type the code it shows now.",
    });
  }

  const subject = { kind: "totp_enroll" as const, id: pending.id };
  const door = "presence.totp.confirm";
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
    const [row] = await tx
      .update(presenceTotpFactors)
      .set({ confirmedAt: now, lastUsedStep: step })
      .where(
        and(
          eq(presenceTotpFactors.id, pending.id),
          isNull(presenceTotpFactors.confirmedAt),
          isNull(presenceTotpFactors.revokedAt)
        )
      )
      .returning({ id: presenceTotpFactors.id });
    if (!row) return { kind: "gone" as const };
    return { kind: "confirmed" as const, unproved: held && !verdict };
  });

  if (outcome.kind === "refused") {
    throw await presenceRequiredError({
      userId: args.userId,
      subject: presenceRequestSubject(subject.kind, subject.id),
    });
  }
  if (outcome.kind === "gone") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This setup was already finished or removed.",
    });
  }
  if (outcome.unproved) {
    await recordMissing({
      userId: args.userId,
      subject: presenceRequestSubject(subject.kind, subject.id),
      what: subject.kind,
      reason: PRESENCE_REQUEST_KINDS.totp_enroll,
      door,
    });
  }
  return { id: pending.id, label: pending.label };
}
