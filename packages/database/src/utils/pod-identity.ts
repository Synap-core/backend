/**
 * pod-identity — the pod's OWN asymmetric identity (SECURITY-PLAN-R1 §1, D1/D8).
 *
 * ONE door for everything the pod signs as itself towards the Control Plane.
 * It lives in @synap/database (not @synap/api) so @synap/jobs and the
 * database-level pod→CP readers sign through the same door; @synap/api
 * re-exports it from `utils/pod-identity.ts`.
 *
 *
 *   signPodJwt({ audience, purpose }, claims, ttlSeconds)   ≤ 300 s
 *   getPodJwks()                                            public half
 *
 * Key material: an ES256 (P-256) PKCS#8 PEM in a FILE, never in the database —
 * a DB dump must not yield the pod's identity. The installer creates it once
 * (`synap pod-key ensure`, run by `synap install` / `synap update`) at
 * `<deploy>/state/pod-identity/pod-key.pem` (0600, owned by the backend's uid);
 * the backend reads it through the deploy directory it already mounts
 * read-only at `/opt/synap/deploy`. `SYNAP_POD_IDENTITY_KEY_FILE` overrides
 * the path (tests, source-repo deploys).
 *
 * Why the installer and not backend first boot: the backend container has no
 * writable persistent mount (the deploy dir is `:ro`), and every other
 * generated pod secret is born in the installer. The private half never
 * leaves the host either way.
 *
 * Token shape (the contract `verifyPodJwt` on the CP enforces):
 *   header  { alg: "ES256", typ: "pod+jwt", kid: <RFC 7638 thumbprint> }
 *   payload { iss: <this pod's PUBLIC_URL origin>, aud, purpose, iat, exp, jti, …claims }
 *
 * `iss` is the pod's public origin rather than a CP pod id: the pod does not
 * know its CP id before registration (the installer sends this key IN the
 * registration), and the CP already binds every CP→pod token to the same
 * origin (`aud = podPublicUrl(pod)`). The CP resolves the key by `kid`, then
 * requires `iss` to be that key's own pod — identity comes from the key, the
 * origin only selects among the key's registrations.
 */

import crypto, { type JsonWebKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

export const POD_JWT_TYP = "pod+jwt";
export const POD_JWT_MAX_TTL_SECONDS = 300;
export const DEFAULT_POD_IDENTITY_KEY_FILE =
  "/opt/synap/deploy/state/pod-identity/pod-key.pem";

/** Claims the door sets itself; a caller may not supply them. */
const RESERVED_CLAIMS = [
  "iss",
  "aud",
  "purpose",
  "iat",
  "exp",
  "nbf",
  "jti",
] as const;

export type PodIdentityErrorCode =
  | "POD_IDENTITY_MISSING"
  | "POD_IDENTITY_INVALID"
  | "POD_IDENTITY_NO_PUBLIC_URL"
  | "POD_JWT_BAD_REQUEST"
  /** The enrollment record exists but cannot be read (utils/pod-cp-auth). */
  | "POD_ENROLLMENT_UNREADABLE"
  /** The key on disk is not the key the Control Plane enrolled. */
  | "POD_KEY_NOT_ENROLLED";

export class PodIdentityError extends Error {
  constructor(
    readonly code: PodIdentityErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PodIdentityError";
  }
}

interface LoadedIdentity {
  file: string;
  privateKey: KeyObject;
  kid: string;
  publicJwk: JsonWebKey;
}

let cached: LoadedIdentity | null = null;

export function podIdentityKeyFile(): string {
  return (
    process.env.SYNAP_POD_IDENTITY_KEY_FILE?.trim() ||
    DEFAULT_POD_IDENTITY_KEY_FILE
  );
}

/** RFC 7638 thumbprint of an EC public JWK (members crv, kty, x, y — sorted). */
export function ecJwkThumbprint(jwk: JsonWebKey): string {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  return crypto.createHash("sha256").update(canonical).digest("base64url");
}

function loadIdentity(): LoadedIdentity {
  const file = podIdentityKeyFile();
  if (cached && cached.file === file) return cached;

  let pem: string;
  try {
    pem = readFileSync(file, "utf8");
  } catch {
    throw new PodIdentityError(
      "POD_IDENTITY_MISSING",
      "This pod has no identity key yet. Run `synap pod-key ensure` on the host."
    );
  }
  let privateKey: KeyObject;
  try {
    privateKey = crypto.createPrivateKey(pem);
  } catch {
    throw new PodIdentityError(
      "POD_IDENTITY_INVALID",
      "The pod identity key file is not a readable private key."
    );
  }
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new PodIdentityError(
      "POD_IDENTITY_INVALID",
      "The pod identity key must be an EC P-256 key."
    );
  }
  const full = crypto
    .createPublicKey(privateKey)
    .export({ format: "jwk" }) as JsonWebKey;
  const kid = ecJwkThumbprint(full);
  cached = {
    file,
    privateKey,
    kid,
    publicJwk: {
      kty: full.kty,
      crv: full.crv,
      x: full.x,
      y: full.y,
      use: "sig",
      alg: "ES256",
      kid,
    },
  };
  return cached;
}

/** Test-only: forget the loaded key so the next call re-reads the file. */
export function _resetPodIdentityForTest(): void {
  cached = null;
}

/** This pod's public origin (PUBLIC_URL), the `iss` of every pod token. */
export function podIssuerOrigin(): string {
  const raw = process.env.PUBLIC_URL?.trim();
  if (!raw) {
    throw new PodIdentityError(
      "POD_IDENTITY_NO_PUBLIC_URL",
      "PUBLIC_URL is not set, so this pod cannot name itself in a token."
    );
  }
  return new URL(raw).origin;
}

/** The kid of this pod's key (RFC 7638 thumbprint). */
export function getPodKeyId(): string {
  return loadIdentity().kid;
}

/** The public key set served at `/.well-known/synap-pod-jwks`. */
export function getPodJwks(): { keys: JsonWebKey[] } {
  return { keys: [loadIdentity().publicJwk] };
}

export interface PodTokenBinding {
  /** The ONE recipient: an origin (the CP's issuer URL for pod→CP calls). */
  audience: string;
  /** What the token is for; the recipient refuses any other purpose. */
  purpose: string;
}

function canonicalAudience(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PodIdentityError(
      "POD_JWT_BAD_REQUEST",
      "A pod token audience must be a URL origin."
    );
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new PodIdentityError(
      "POD_JWT_BAD_REQUEST",
      "A pod token audience must be a bare origin."
    );
  }
  return parsed.origin;
}

/**
 * Sign a short-lived token AS this pod, for one audience and one purpose.
 * `ttlSeconds` is capped at 300 (the CP refuses anything longer).
 */
export function signPodJwt(
  binding: PodTokenBinding,
  claims: Record<string, unknown>,
  ttlSeconds: number = POD_JWT_MAX_TTL_SECONDS
): string {
  const audience = canonicalAudience(binding.audience);
  if (!binding.purpose || typeof binding.purpose !== "string") {
    throw new PodIdentityError(
      "POD_JWT_BAD_REQUEST",
      "A pod token needs a purpose."
    );
  }
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > POD_JWT_MAX_TTL_SECONDS
  ) {
    throw new PodIdentityError(
      "POD_JWT_BAD_REQUEST",
      `A pod token lives 1–${POD_JWT_MAX_TTL_SECONDS} seconds.`
    );
  }
  for (const name of RESERVED_CLAIMS) {
    if (name in claims) {
      throw new PodIdentityError(
        "POD_JWT_BAD_REQUEST",
        `Claim "${name}" is set by signPodJwt, not by its caller.`
      );
    }
  }
  const { privateKey, kid } = loadIdentity();
  const now = Math.floor(Date.now() / 1000);
  // JWS compact, ES256 (RFC 7518 §3.4: raw r||s, not DER). node:crypto only —
  // this package carries no JWT library.
  const header = { alg: "ES256", typ: POD_JWT_TYP, kid };
  const payload = {
    ...claims,
    iss: podIssuerOrigin(),
    aud: audience,
    purpose: binding.purpose,
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomUUID(),
  };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
