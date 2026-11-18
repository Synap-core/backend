/**
 * The grace window of proof of presence (founder, 18 Nov 2026): after a
 * passkey or device-key proof made from a person's own signed-in BROWSER
 * session, that session may do the GRACEABLE acts (`presenceGraceable`,
 * `@synap-core/types/presence`) for `PRESENCE_GRACE_SECONDS` without asking
 * again. Not sliding: it runs from the moment the proof was verified.
 *
 * No table of its own: the grant IS the consumed challenge of that proof,
 * stamped with the session that made it (`grant_session`, the column the
 * passkey-change grant and "Add this device" already use). The gate
 * (`gate.ts`) is the only place that decides; this file only stamps and
 * reads. A read that fails is "no grace" (the caller then asks for a proof),
 * never a grace.
 *
 * What stamps: a verified `passkey` or `device_key` proof, never a typed code
 * (2FA app, recovery code), never the `passkey_change` proof (its own grant
 * owns that column), and only when the request is a browser person session
 * that names its key. What reads: the same session key, the same person, a
 * stamped challenge consumed within the window.
 */
import {
  and,
  db,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  notLike,
  presenceChallenges,
} from "@synap/database";
import {
  PRESENCE_GRACE_SECONDS,
  type PresenceProofKind,
} from "@synap-core/types/presence";

/** The proofs that can mint a grace: signed by a key, never typed. */
const GRACE_METHODS: readonly PresenceProofKind[] = ["passkey", "device_key"];

/** The challenge subject a `passkey_change` grant uses: it owns `grant_session`. */
const notPasskeyChange = notLike(presenceChallenges.subject, "passkey_change:%");

export interface PresenceGrace {
  /** Whole seconds left, at least 1. */
  remainingSeconds: number;
  until: Date;
  method: PresenceProofKind;
  deviceKeyId: string | null;
  challengeId: string;
}

/**
 * Bind the just-verified proof's challenge to the session that made it.
 * True when stamped; false (no grace) for a typed code, a `passkey_change`
 * proof, a challenge already stamped, or no session key.
 */
export async function stampGrace(args: {
  userId: string;
  challengeId: string;
  method: PresenceProofKind;
  sessionKey: string | null;
}): Promise<boolean> {
  if (!args.sessionKey || !GRACE_METHODS.includes(args.method)) return false;
  const [stamped] = await db
    .update(presenceChallenges)
    .set({ grantSession: args.sessionKey })
    .where(
      and(
        eq(presenceChallenges.id, args.challengeId),
        eq(presenceChallenges.userId, args.userId),
        inArray(presenceChallenges.method, [...GRACE_METHODS]),
        isNotNull(presenceChallenges.consumedAt),
        isNull(presenceChallenges.grantSession),
        notPasskeyChange
      )
    )
    .returning({ id: presenceChallenges.id });
  return Boolean(stamped);
}

/**
 * The grace this session holds now, or null. Throws on a failed read: the
 * gate treats that as no grace.
 */
export async function readGrace(args: {
  userId: string;
  sessionKey: string | null;
  now?: Date;
}): Promise<PresenceGrace | null> {
  if (!args.sessionKey) return null;
  const now = args.now ?? new Date();
  const [row] = await db
    .select({
      id: presenceChallenges.id,
      consumedAt: presenceChallenges.consumedAt,
      method: presenceChallenges.method,
      deviceKeyId: presenceChallenges.deviceKeyId,
    })
    .from(presenceChallenges)
    .where(
      and(
        eq(presenceChallenges.userId, args.userId),
        eq(presenceChallenges.grantSession, args.sessionKey),
        inArray(presenceChallenges.method, [...GRACE_METHODS]),
        gt(
          presenceChallenges.consumedAt,
          new Date(now.getTime() - PRESENCE_GRACE_SECONDS * 1000)
        ),
        notPasskeyChange
      )
    )
    .orderBy(desc(presenceChallenges.consumedAt))
    .limit(1);
  if (!row?.consumedAt) return null;
  const until = new Date(row.consumedAt.getTime() + PRESENCE_GRACE_SECONDS * 1000);
  const remaining = Math.ceil((until.getTime() - now.getTime()) / 1000);
  if (remaining <= 0) return null;
  return {
    remainingSeconds: remaining,
    until,
    method: row.method as PresenceProofKind,
    deviceKeyId: row.deviceKeyId,
    challengeId: row.id,
  };
}
