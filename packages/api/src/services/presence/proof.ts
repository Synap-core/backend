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
 * A challenge is consumed by the first proof that answers it (conditional
 * update), lives `PRESENCE_CHALLENGE_TTL_SECONDS`, and belongs to one person and
 * one subject. Every refusal is a typed `PresenceError`; nothing is half-applied.
 */

import crypto from "node:crypto";
import { kratosAdmin } from "@synap/auth";
import { isRefusedSiteBase } from "@synap-core/types/tenancy";
import {
  PRESENCE_CHALLENGE_TTL_SECONDS,
  PRESENCE_EXPIRED,
  PRESENCE_INVALID,
  PRESENCE_USED,
  presenceMessage,
  type PresenceProof,
  type PresenceRefusalCode,
  type PasskeyAssertionJSON,
} from "@synap-core/types/presence";
import {
  and,
  db,
  eq,
  gt,
  isNull,
  presenceChallenges,
  presenceDeviceKeys,
} from "@synap/database";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";

import { podAudience } from "../../utils/jwks-client.js";
import { toPodAdminOrigin } from "../../utils/pod-admin-origin.js";

export class PresenceError extends Error {
  constructor(
    readonly code: PresenceRefusalCode,
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

/** Issue a challenge for (person, subject). The subject is a proposal id or `enroll:<id>`. */
export async function issuePresenceChallenge(args: {
  userId: string;
  subject: string | ((challengeId: string) => string);
}): Promise<IssuedChallenge> {
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
  authenticator?: { sign_count?: number };
}

/** The person's passkeys, read from Kratos (the one place they are registered). */
export async function readPasskeys(
  userId: string
): Promise<Array<{ id: string; publicKey: Uint8Array; counter: number }>> {
  const { data } = await kratosAdmin.getIdentity({
    id: userId,
    includeCredential: ["passkey" as never],
  });
  const config = (
    data.credentials as
      | Record<string, { config?: { credentials?: KratosPasskeyCredential[] } }>
      | undefined
  )?.passkey?.config;
  return (config?.credentials ?? [])
    .filter((c) => c.id && c.public_key)
    .map((c) => ({
      id: b64url(Buffer.from(c.id!, "base64")),
      publicKey: new Uint8Array(Buffer.from(c.public_key!, "base64")),
      counter: c.authenticator?.sign_count ?? 0,
    }));
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
  method: "passkey" | "device_key";
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
