"use strict";

/**
 * The pod's own identity, as the pod-agent signs with it (SECURITY-PLAN-R1
 * §1 + §2, D1/D2). The pod-agent is plain node with zero dependencies, so it
 * cannot import the backend's ONE signing door (`signPodJwt`,
 * packages/database/src/utils/pod-identity.ts). This file MIRRORS that door's
 * token format exactly; `pod-identity.test.js` reads the backend source and
 * fails when the two drift (header members, reserved claims, typ, max TTL).
 *
 * Token (what the CP's `verifyPodJwt` accepts):
 *   header  { alg: "ES256", typ: "pod+jwt", kid: <RFC 7638 thumbprint> }
 *   payload { ...claims, iss: <pod origin>, aud: <CP origin>, purpose, iat, exp, jti }
 *
 * The key is the file the installer creates once (`synap pod-key ensure`):
 * <deploy>/state/pod-identity/pod-key.pem — the pod-agent mounts the deploy
 * directory at /deploy, so it reads the same file the backend reads.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const POD_JWT_TYP = "pod+jwt";
const POD_JWT_MAX_TTL_SECONDS = 300;
/** Claims the signer sets itself; a caller may not supply them. */
const RESERVED_CLAIMS = Object.freeze([
  "iss",
  "aud",
  "purpose",
  "iat",
  "exp",
  "nbf",
  "jti",
]);

function identityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** <deploy>/state/pod-identity/pod-key.pem */
function podKeyFile(deployDir) {
  return path.join(deployDir, "state", "pod-identity", "pod-key.pem");
}

/** <deploy>/state/pod-identity-enrollment.json — written once the CP holds the key. */
function podEnrollmentFile(deployDir) {
  return path.join(deployDir, "state", "pod-identity-enrollment.json");
}

/** RFC 7638 thumbprint of an EC public JWK (members crv, kty, x, y — sorted). */
function ecJwkThumbprint(jwk) {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  return crypto.createHash("sha256").update(canonical).digest("base64url");
}

function loadPodIdentity(file, readFile = fs.readFileSync) {
  let pem;
  try {
    pem = readFile(file, "utf8");
  } catch {
    throw identityError(
      "POD_IDENTITY_MISSING",
      "This pod has no identity key yet. Run `synap pod-key ensure` on the host."
    );
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(pem);
  } catch {
    throw identityError(
      "POD_IDENTITY_INVALID",
      "The pod identity key file is not a readable private key."
    );
  }
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    !privateKey.asymmetricKeyDetails ||
    privateKey.asymmetricKeyDetails.namedCurve !== "prime256v1"
  ) {
    throw identityError(
      "POD_IDENTITY_INVALID",
      "The pod identity key must be an EC P-256 key."
    );
  }
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  return { privateKey, kid: ecJwkThumbprint(jwk) };
}

function bareOrigin(value, what) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw identityError("POD_JWT_BAD_REQUEST", `${what} must be a URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw identityError("POD_JWT_BAD_REQUEST", `${what} must be http(s).`);
  }
  return parsed.origin;
}

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Sign a short-lived token AS this pod, for one audience and one purpose.
 * `issuer` is this pod's public origin (POD_AGENT_AUDIENCE = PUBLIC_URL).
 */
function signPodJwt(
  identity,
  binding,
  claims = {},
  ttlSeconds = POD_JWT_MAX_TTL_SECONDS,
  nowMs = Date.now()
) {
  if (!binding || typeof binding.purpose !== "string" || !binding.purpose) {
    throw identityError("POD_JWT_BAD_REQUEST", "A pod token needs a purpose.");
  }
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > POD_JWT_MAX_TTL_SECONDS
  ) {
    throw identityError(
      "POD_JWT_BAD_REQUEST",
      `A pod token lives 1–${POD_JWT_MAX_TTL_SECONDS} seconds.`
    );
  }
  for (const name of RESERVED_CLAIMS) {
    if (name in claims) {
      throw identityError(
        "POD_JWT_BAD_REQUEST",
        `Claim "${name}" is set by signPodJwt, not by its caller.`
      );
    }
  }
  const now = Math.floor(nowMs / 1000);
  const header = { alg: "ES256", typ: POD_JWT_TYP, kid: identity.kid };
  const payload = {
    ...claims,
    iss: bareOrigin(binding.issuer, "The pod issuer"),
    aud: bareOrigin(binding.audience, "The token audience"),
    purpose: binding.purpose,
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomUUID(),
  };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: identity.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

module.exports = {
  POD_JWT_MAX_TTL_SECONDS,
  POD_JWT_TYP,
  RESERVED_CLAIMS,
  ecJwkThumbprint,
  loadPodIdentity,
  podEnrollmentFile,
  podKeyFile,
  signPodJwt,
};
