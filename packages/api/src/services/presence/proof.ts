/**
 * Proof of presence — the pod's ONE door (W3, founder decision of 4 Nov 2026:
 * a session proves the account, not the person).
 *
 * A sensitive approval (`sensitiveApprovalReason`, `@synap-core/types/presence`)
 * needs a fresh signature over a pod challenge that names that ONE proposal:
 *
 *  - `device_key`: a P-256 key the person enrolled on a device, held behind
 *    Face ID / the device passcode (Relay). DER ECDSA SHA-256 over
 *    `presenceMessage(...)`, verified against the stored SPKI public key.
 *  - `passkey`: a WebAuthn assertion by one of the person's passkeys (those
 *    Kratos holds; Kratos stays the only place they are registered). Its
 *    `challenge` is SHA-256 of the same message, user verification REQUIRED
 *    (Kratos v1.3.1 asks for it only as "preferred", so the pod checks the UV
 *    flag itself), origin = the pod or its console, rpId = the pod host or a
 *    parent domain (Kratos' `rp.id` is one of them).
 *
 *  - `totp` / `recovery_code` (the recovery ladder, founder, 6 Nov 2026): a
 *    code the person TYPES in pod admin's dialog, from their 2FA app or their
 *    recovery codes. Bound to the challenge like the others (the challenge
 *    names the subject and is spent), accepted once (the app's step moves
 *    forward, the recovery code is spent), refused from a Synap app's device
 *    session, and limited to `PRESENCE_TYPED_FAILURES_MAX` wrong codes per
 *    person in `PRESENCE_TYPED_FAILURE_WINDOW_SECONDS`.
 *
 * A challenge is consumed by the first proof that answers it (conditional
 * update), lives `PRESENCE_CHALLENGE_TTL_SECONDS`, and belongs to one person and
 * one subject. Every refusal is a typed `PresenceError`; nothing is half-applied
 * (a typed code that verified is spent even when its challenge then loses a
 * race: one use, never two).
 */

import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { kratosAdmin } from "@synap/auth";
import { isRefusedSiteBase } from "@synap-core/types/tenancy";
import {
  aaguidFromBytes,
  PRESENCE_CHALLENGE_TTL_SECONDS,
  PRESENCE_EXPIRED,
  PRESENCE_INVALID,
  PRESENCE_TYPED_FAILURE_WINDOW_SECONDS,
  PRESENCE_TYPED_FAILURES_MAX,
  PRESENCE_USED,
  isTypedPresenceProof,
  presenceMessage,
  presenceWaysIn,
  type PresenceFactorCounts,
  type PresenceProof,
  type PresenceProofKind,
  type PresenceRefusalCode,
  type DeviceLinkRefusalCode,
  type PasskeyAssertionJSON,
} from "@synap-core/types/presence";
import { normalizeRecoveryCode } from "@synap-core/types/account-recovery";
import {
  AccountRecoveryCodeRepository,
  accountRecoveryCodes,
  and,
  count,
  db,
  eq,
  gt,
  isNotNull,
  isNull,
  presenceChallenges,
  presenceDeviceKeys,
  presenceDisownedPasskeys,
  presenceProofFailures,
  presenceTotpFactors,
} from "@synap/database";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";

import { podAudience } from "../../utils/jwks-client.js";
import {
  isBrowserPersonSession,
  isDeviceSession,
} from "../../utils/device-session.js";
import { toPodAdminOrigin } from "../../utils/pod-admin-origin.js";
import { matchRecoveryCode } from "../account-recovery/codes.js";
import { acceptTotpCode } from "./totp-code.js";

export class PresenceError extends Error {
  constructor(
    // A device-link refusal ("Add this device", 9 Nov 2026) rides the same
    // typed error; the router maps it by code.
    readonly code: PresenceRefusalCode | DeviceLinkRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "PresenceError";
  }
}

/** base64url (no padding) of bytes. */
export function b64url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** The pod's public origin, the first line of every signed message. */
export function presencePodOrigin(): string {
  const value = podAudience();
  if (!value) {
    throw new PresenceError(
      PRESENCE_INVALID,
      "This pod has no PUBLIC_URL, so it cannot ask for a proof of presence."
    );
  }
  return new URL(value).origin;
}

export interface IssuedChallenge {
  challengeId: string;
  subject: string;
  nonce: string;
  /** The exact UTF-8 text a device key signs. */
  message: string;
  /** base64url SHA-256 of `message`: a passkey's WebAuthn challenge. */
  webauthnChallenge: string;
  expiresAt: Date;
}

function webauthnChallengeOf(message: string): string {
  return b64url(crypto.createHash("sha256").update(message, "utf8").digest());
}

/**
 * At most this many challenges a person may ask for in a minute (every
 * challenge door: `presence.challenge`, `devices.enrollChallenge`). A person
 * confirming things asks for a few; a loop asking for thousands only fills
 * the table (the jobs sweep `presence-challenge-sweep` empties what expired).
 */
export const PRESENCE_CHALLENGES_PER_MINUTE = 20;

/** Issue a challenge for (person, subject). The subject is a proposal id or `enroll:<id>`. */
export async function issuePresenceChallenge(args: {
  userId: string;
  subject: string | ((challengeId: string) => string);
}): Promise<IssuedChallenge> {
  const [recent] = await db
    .select({ n: count() })
    .from(presenceChallenges)
    .where(
      and(
        eq(presenceChallenges.userId, args.userId),
        gt(presenceChallenges.createdAt, new Date(Date.now() - 60_000))
      )
    );
  if (Number(recent?.n ?? 0) >= PRESENCE_CHALLENGES_PER_MINUTE) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message:
        "Too many confirmations asked for in the last minute. Wait a moment, then try again.",
    });
  }
  const id = crypto.randomUUID();
  const subject =
    typeof args.subject === "function" ? args.subject(id) : args.subject;
  const nonce = b64url(crypto.randomBytes(32));
  const expiresAt = new Date(
    Date.now() + PRESENCE_CHALLENGE_TTL_SECONDS * 1000
  );
  await db.insert(presenceChallenges).values({
    id,
    userId: args.userId,
    subject,
    nonce,
    expiresAt,
  });
  const message = presenceMessage({
    podOrigin: presencePodOrigin(),
    challengeId: id,
    subject,
    nonce,
  });
  return {
    challengeId: id,
    subject,
    nonce,
    message,
    webauthnChallenge: webauthnChallengeOf(message),
    expiresAt,
  };
}

/** Verify a DER ECDSA P-256 SHA-256 signature by an SPKI (base64url) key. */
export function verifyDeviceSignature(
  publicKeySpki: string,
  message: string,
  signature: string
): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    if (
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      return false;
    }
    return crypto.verify(
      "sha256",
      Buffer.from(message, "utf8"),
      { key, dsaEncoding: "der" },
      Buffer.from(signature, "base64url")
    );
  } catch {
    return false;
  }
}

/** The rp ids a passkey of this pod may carry: its host and each parent domain. */
export function passkeyRpIds(origin: string): string[] {
  const host = new URL(origin).hostname;
  if (host === "localhost" || /^[\d.]+$/.test(host)) return [host];
  const labels = host.split(".");
  const ids: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    ids.push(labels.slice(i).join("."));
  }
  return ids;
}

/**
 * The rp id this pod's passkeys are registered under. The installer gives
 * Kratos `rp.id` = the domain the pod and its console share (its cookie
 * domain, `shared_cookie_domain` in `synap`): their longest common parent,
 * unless that is a bare TLD or a tenant zone (`isRefusedSiteBase`, the TS
 * twin), and then the pod's own host. `passkeyRpIds` still accepts every
 * parent, so a pod whose Kratos says otherwise keeps verifying.
 */
export function passkeyRpId(podOrigin: string, consoleOrigin: string): string {
  const pod = new URL(podOrigin).hostname.split(".");
  const con = new URL(consoleOrigin).hostname.split(".");
  const common: string[] = [];
  while (
    pod.length > 0 &&
    con.length > 0 &&
    pod[pod.length - 1] === con[con.length - 1]
  ) {
    common.unshift(pod.pop()!);
    con.pop();
  }
  const shared = common.join(".");
  return shared && !isRefusedSiteBase(shared)
    ? shared
    : new URL(podOrigin).hostname;
}

/** A passkey as Kratos stores it (go-webauthn `Credential`, bytes base64 std). */
interface KratosPasskeyCredential {
  id?: string;
  public_key?: string;
  /** The authenticator's AAGUID (16 bytes) and its signature counter. */
  authenticator?: { sign_count?: number; aaguid?: string | null };
  /** Kratos' name for the passkey's store ("iCloud Keychain"), from its AAGUID. */
  display_name?: string | null;
}

/** One passkey of the person, as the presence ceremony needs it. */
export interface PodPasskey {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  /** Lowercase hyphenated AAGUID, or null when Kratos recorded none. */
  aaguid: string | null;
  /** Kratos' name for where it lives, or null. */
  displayName: string | null;
}

/** Kratos' passkey credentials → the pod's passkeys (pure; `readPasskeys` reads them). */
export function passkeysFromKratos(
  credentials: ReadonlyArray<KratosPasskeyCredential> | undefined
): PodPasskey[] {
  return (credentials ?? [])
    .filter((c) => c.id && c.public_key)
    .map((c) => ({
      id: b64url(Buffer.from(c.id!, "base64")),
      publicKey: new Uint8Array(Buffer.from(c.public_key!, "base64")),
      counter: c.authenticator?.sign_count ?? 0,
      aaguid: c.authenticator?.aaguid
        ? aaguidFromBytes(Buffer.from(c.authenticator.aaguid, "base64"))
        : null,
      displayName: c.display_name?.trim() || null,
    }));
}

/** Every passkey Kratos holds for the person, a finished recovery's included. */
export async function readKratosPasskeys(
  userId: string
): Promise<PodPasskey[]> {
  const { data } = await kratosAdmin.getIdentity({
    id: userId,
    includeCredential: ["passkey" as never],
  });
  const config = (
    data.credentials as
      | Record<string, { config?: { credentials?: KratosPasskeyCredential[] } }>
      | undefined
  )?.passkey?.config;
  return passkeysFromKratos(config?.credentials);
}

/**
 * The person's passkeys that PROVE presence: those Kratos holds (the one place
 * they are registered), minus those a finished recovery disowned
 * (`presence_disowned_passkeys`: Kratos v1.3.1 cannot remove a passkey
 * through its admin API, so the pod stops accepting it instead).
 */
export async function readPasskeys(
  userId: string,
  /** A transaction to read the disowned list in (an enrolment's, under its lock). */
  executor: Pick<typeof db, "select"> = db
): Promise<PodPasskey[]> {
  const all = await readKratosPasskeys(userId);
  if (all.length === 0) return all;
  const disowned = new Set(
    (
      await executor
        .select({ id: presenceDisownedPasskeys.credentialId })
        .from(presenceDisownedPasskeys)
        .where(eq(presenceDisownedPasskeys.userId, userId))
    ).map((r) => r.id)
  );
  return all.filter((p) => !disowned.has(p.id));
}

/**
 * What the person holds that can prove presence, counted: their passkeys
 * (`readPasskeys`), their device keys not revoked, their 2FA app, their unused
 * recovery codes. The pod-held ones are read in `executor` (an enrolment's
 * transaction, under its lock). A failed read throws: it is never "no
 * factor", which would let a session add one unapproved.
 */
export async function presenceFactorCounts(
  userId: string,
  executor: Pick<typeof db, "select"> = db
): Promise<PresenceFactorCounts> {
  const [devices] = await executor
    .select({ n: count() })
    .from(presenceDeviceKeys)
    .where(
      and(
        eq(presenceDeviceKeys.userId, userId),
        isNull(presenceDeviceKeys.revokedAt)
      )
    );
  const [totp] = await executor
    .select({ n: count() })
    .from(presenceTotpFactors)
    .where(
      and(
        eq(presenceTotpFactors.userId, userId),
        isNotNull(presenceTotpFactors.confirmedAt),
        isNull(presenceTotpFactors.revokedAt)
      )
    );
  const [codes] = await executor
    .select({ n: count() })
    .from(accountRecoveryCodes)
    .where(
      and(
        eq(accountRecoveryCodes.userId, userId),
        isNull(accountRecoveryCodes.usedAt)
      )
    );
  return {
    passkeys: (await readPasskeys(userId, executor)).length,
    deviceKeys: Number(devices?.n ?? 0),
    totp: Number(totp?.n ?? 0) > 0,
    recoveryCodes: Number(codes?.n ?? 0),
  };
}

/**
 * Does the person hold a factor that can prove presence (a passkey, a device
 * key, a 2FA app, an unused recovery code)? Throws on a failed read. (Here,
 * beside `readPasskeys`, so the gate can ask it without the factor-change
 * graph of `factors.ts`, which re-exports it.)
 */
export async function hasProofFactor(
  userId: string,
  /** A transaction to read the pod-held factors in (an enrolment's, under its lock). */
  executor: Pick<typeof db, "select"> = db
): Promise<boolean> {
  return presenceWaysIn(await presenceFactorCounts(userId, executor)) > 0;
}

/**
 * Record a typed try BEFORE the code is read, then count the tries in the
 * window, this one included: of N tries sent at once, the k-th sees at least
 * k rows, so at most `PRESENCE_TYPED_FAILURES_MAX` are ever read (a count
 * taken before the insert let a burst through, review of backend#885). A try
 * past the limit is taken back and refused; a right code takes its row back.
 * A failed write fails the proof: an unrecorded try would escape the limit.
 */
async function recordTypedTry(userId: string, method: string): Promise<string> {
  const [row] = await db
    .insert(presenceProofFailures)
    .values({ userId, method })
    .returning({ id: presenceProofFailures.id });
  if (!row) throw new Error("a typed try could not be recorded");
  const since = new Date(
    Date.now() - PRESENCE_TYPED_FAILURE_WINDOW_SECONDS * 1000
  );
  const [counted] = await db
    .select({ n: count() })
    .from(presenceProofFailures)
    .where(
      and(
        eq(presenceProofFailures.userId, userId),
        gt(presenceProofFailures.createdAt, since)
      )
    );
  if (Number(counted?.n ?? 0) > PRESENCE_TYPED_FAILURES_MAX) {
    await forgetTypedTry(row.id);
    throw new PresenceError(
      PRESENCE_INVALID,
      "Too many wrong codes. Wait 15 minutes, or confirm with your passkey or Face ID."
    );
  }
  return row.id;
}

async function forgetTypedTry(id: string): Promise<void> {
  await db
    .delete(presenceProofFailures)
    .where(eq(presenceProofFailures.id, id));
}

/**
 * Check a TYPED code (2FA app, recovery code) and spend it. Every try is
 * counted first (`recordTypedTry`); a right code takes its try back.
 */
async function verifyTypedCode(
  userId: string,
  proof: Extract<PresenceProof, { kind: "totp" | "recovery_code" }>
): Promise<void> {
  // An allowlist: only a person's browser session (pod admin) may type a
  // code. A device token, a key, or any door that opened no such scope (Hub
  // REST, an executor) is refused before the code is read.
  if (isDeviceSession() || !isBrowserPersonSession()) {
    throw new PresenceError(
      PRESENCE_INVALID,
      isDeviceSession()
        ? "A code is typed in pod admin, signed in in your browser. Here, confirm with Face ID or Touch ID."
        : "A code is typed in pod admin, signed in in your browser."
    );
  }
  const tryId = await recordTypedTry(userId, proof.kind);
  let accepted = false;
  if (proof.kind === "totp") {
    accepted = await acceptTotpCode(userId, proof.code);
  } else {
    const codes = new AccountRecoveryCodeRepository(
      db as unknown as ConstructorParameters<
        typeof AccountRecoveryCodeRepository
      >[0]
    );
    const matched = await matchRecoveryCode(
      normalizeRecoveryCode(proof.code),
      await codes.listUnused(userId)
    );
    accepted = matched !== null && (await codes.claim(matched, new Date()));
  }
  if (!accepted) {
    throw new PresenceError(
      PRESENCE_INVALID,
      proof.kind === "totp"
        ? "This code doesn't match your authenticator app, or it was already used. Type the code it shows now."
        : "This recovery code doesn't match one of yours, or it was already used."
    );
  }
  await forgetTypedTry(tryId);
}

async function verifyPasskey(
  userId: string,
  assertion: PasskeyAssertionJSON,
  expectedChallenge: string
): Promise<void> {
  const passkeys = await readPasskeys(userId);
  const credential = passkeys.find((p) => p.id === assertion.rawId);
  if (!credential) {
    throw new PresenceError(
      PRESENCE_INVALID,
      "This passkey is not one of yours on this pod."
    );
  }
  const podOrigin = presencePodOrigin();
  let verified = false;
  try {
    const result = await verifyAuthenticationResponse({
      response: assertion as never,
      expectedChallenge,
      expectedOrigin: [...new Set([podOrigin, toPodAdminOrigin(podOrigin)])],
      expectedRPID: passkeyRpIds(podOrigin),
      credential: {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
      },
      requireUserVerification: true,
    });
    verified = result.verified && result.authenticationInfo.userVerified;
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new PresenceError(
      PRESENCE_INVALID,
      "The passkey did not confirm it is you (no user verification, or the wrong challenge or site)."
    );
  }
}

export interface PresenceVerdict {
  method: PresenceProofKind;
  deviceKeyId: string | null;
  deviceLabel: string | null;
  challengeId: string;
}

/**
 * Verify `proof` for (person, subject) and CONSUME its challenge. Throws a
 * `PresenceError` on any failure; the challenge is consumed only by a proof
 * that verified.
 */
export async function verifyAndConsumePresence(args: {
  userId: string;
  subject: string;
  proof: PresenceProof;
}): Promise<PresenceVerdict> {
  const { userId, subject, proof } = args;
  const challenge = await db.query.presenceChallenges.findFirst({
    where: and(
      eq(presenceChallenges.id, proof.challengeId),
      eq(presenceChallenges.userId, userId)
    ),
  });
  // Another person's challenge reads as unknown: never confirm it exists.
  if (!challenge || challenge.subject !== subject) {
    throw new PresenceError(
      PRESENCE_INVALID,
      "This proof was made for another approval."
    );
  }
  if (challenge.consumedAt) {
    throw new PresenceError(PRESENCE_USED, "This proof was already used.");
  }
  if (challenge.expiresAt <= new Date()) {
    throw new PresenceError(PRESENCE_EXPIRED, "This proof expired. Ask again.");
  }

  const message = presenceMessage({
    podOrigin: presencePodOrigin(),
    challengeId: challenge.id,
    subject: challenge.subject,
    nonce: challenge.nonce,
  });

  let deviceKeyId: string | null = null;
  let deviceLabel: string | null = null;
  if (proof.kind === "device_key") {
    const key = await db.query.presenceDeviceKeys.findFirst({
      where: and(
        eq(presenceDeviceKeys.id, proof.keyId),
        eq(presenceDeviceKeys.userId, userId),
        isNull(presenceDeviceKeys.revokedAt)
      ),
    });
    if (
      !key ||
      !verifyDeviceSignature(key.publicKey, message, proof.signature)
    ) {
      throw new PresenceError(
        PRESENCE_INVALID,
        "This device's signature does not match (unknown or revoked key, or the wrong challenge)."
      );
    }
    deviceKeyId = key.id;
    deviceLabel = key.label;
  } else if (proof.kind === "passkey") {
    await verifyPasskey(userId, proof.credential, webauthnChallengeOf(message));
  } else if (isTypedPresenceProof(proof.kind)) {
    await verifyTypedCode(
      userId,
      proof as Extract<PresenceProof, { kind: "totp" | "recovery_code" }>
    );
  } else {
    throw new PresenceError(PRESENCE_INVALID, "Unknown kind of proof.");
  }

  // Once: the first verified proof consumes it; a racing second one loses.
  const [consumed] = await db
    .update(presenceChallenges)
    .set({ consumedAt: new Date(), method: proof.kind, deviceKeyId })
    .where(
      and(
        eq(presenceChallenges.id, challenge.id),
        isNull(presenceChallenges.consumedAt),
        gt(presenceChallenges.expiresAt, new Date())
      )
    )
    .returning({ id: presenceChallenges.id });
  if (!consumed) {
    throw new PresenceError(PRESENCE_USED, "This proof was already used.");
  }
  if (deviceKeyId) {
    await db
      .update(presenceDeviceKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(presenceDeviceKeys.id, deviceKeyId));
  }
  return {
    method: proof.kind,
    deviceKeyId,
    deviceLabel,
    challengeId: challenge.id,
  };
}
