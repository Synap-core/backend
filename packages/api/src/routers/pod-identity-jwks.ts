/**
 * GET /.well-known/synap-pod-jwks — the PUBLIC half of this pod's identity key
 * (utils/pod-identity.ts). Public and cacheable: a public key is not a secret,
 * and the CP never trusts it from here — it trusts only the key registered at
 * `/pods/register` (or enrolled once). Useful for C2C debugging and for any
 * verifier that wants to check a pod-signed token.
 *
 * POST /.well-known/synap-pod-proof `{ nonce }` — proof that this host HOLDS
 * that key (plan 5b923276 D3, decision e9d91a22). A desktop or phone app that
 * is about to follow a moved Synap Cloud pod to a new address sends a fresh
 * nonce of its own; this answers `{ proof }`, a compact JWS over the nonce
 * signed with the identity key (`signPodProof`). The app verifies it with the
 * key whose thumbprint the Control Plane registered for the pod: a host that
 * only copied the JWKS cannot sign. Public and unauthenticated: it reads no
 * cookie, session or Bearer, sets no cookie, and is never cached. A nonce that
 * is not 16–64 bytes of unpadded base64url is a 400 `POD_PROOF_BAD_NONCE`.
 * Rate class: the default (`crud`), like the JWKS beside it.
 *
 * Mounted at the app ROOT (a `.well-known` path belongs to the origin). A pod
 * without a key answers 503 with a typed code, never an empty key set: "no
 * identity yet" and "an identity with zero keys" are different facts.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  getPodJwks,
  isPodProofNonce,
  PodIdentityError,
  signPodProof,
} from "../utils/pod-identity.js";

export const POD_JWKS_PATH = "/.well-known/synap-pod-jwks";
export const POD_PROOF_PATH = "/.well-known/synap-pod-proof";

/** A `{ nonce }` body is under 200 bytes; anything far larger is not one. */
export const POD_PROOF_MAX_BODY_BYTES = 1024;

export const podIdentityJwksApp = new Hono();

podIdentityJwksApp.get(POD_JWKS_PATH, (c) => {
  try {
    const jwks = getPodJwks();
    c.header("Cache-Control", "public, max-age=300");
    return c.json(jwks, 200);
  } catch (err) {
    if (err instanceof PodIdentityError) {
      c.header("Cache-Control", "no-store");
      return c.json({ error: err.message, code: err.code }, 503);
    }
    throw err;
  }
});

podIdentityJwksApp.post(
  POD_PROOF_PATH,
  bodyLimit({
    maxSize: POD_PROOF_MAX_BODY_BYTES,
    onError: (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          error: "A proof request is a small JSON body.",
          code: "POD_PROOF_TOO_LARGE",
        },
        413
      );
    },
  }),
  async (c) => {
    c.header("Cache-Control", "no-store");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const nonce =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).nonce
        : undefined;
    if (!isPodProofNonce(nonce)) {
      return c.json(
        {
          error: "Send { nonce }: 16 to 64 random bytes as unpadded base64url.",
          code: "POD_PROOF_BAD_NONCE",
        },
        400
      );
    }
    try {
      return c.json({ proof: signPodProof(nonce) }, 200);
    } catch (err) {
      if (err instanceof PodIdentityError) {
        return c.json({ error: err.message, code: err.code }, 503);
      }
      throw err;
    }
  }
);
