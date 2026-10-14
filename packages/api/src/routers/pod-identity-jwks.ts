/**
 * GET /.well-known/synap-pod-jwks — the PUBLIC half of this pod's identity key
 * (utils/pod-identity.ts). Public and cacheable: a public key is not a secret,
 * and the CP never trusts it from here — it trusts only the key registered at
 * `/pods/register` (or enrolled once). Useful for C2C debugging and for any
 * verifier that wants to check a pod-signed token.
 *
 * Mounted at the app ROOT (a `.well-known` path belongs to the origin). A pod
 * without a key answers 503 with a typed code, never an empty key set: "no
 * identity yet" and "an identity with zero keys" are different facts.
 */

import { Hono } from "hono";
import { getPodJwks, PodIdentityError } from "../utils/pod-identity.js";

export const POD_JWKS_PATH = "/.well-known/synap-pod-jwks";

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
