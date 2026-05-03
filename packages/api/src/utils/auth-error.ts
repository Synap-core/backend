/**
 * Standardized 401 envelope for the Hub Protocol auth surface.
 *
 * Background: Eve CLI (and other external operators) need a structured failure
 * reason when their bearer key is rejected — "is the key revoked? expired?
 * does it lack a scope? did I just forget the header?". Returning ad-hoc
 * `{ error: "..." }` messages forces clients to string-match, which breaks
 * silently when we tweak copy.
 *
 * Shape (per AUTH-ENVELOPE design):
 *
 *   {
 *     "error": "unauthorized",
 *     "reason": "key_revoked" | "missing_scope" | "expired"
 *             | "invalid_format" | "no_auth",
 *     "message": "human-readable",
 *     "missingScope"?: "string (when reason = missing_scope)",
 *     "keyIdPrefix"?: "first 8 chars of the key id, when present"
 *   }
 *
 * Backwards compatibility: existing operators only consumed `{ error: string }`.
 * The new envelope KEEPS `error` (now hardcoded to "unauthorized" — distinct
 * from the previous human messages, but stable) and adds `reason`/`message`
 * alongside. Operators who string-matched on the old `error` value will need
 * to migrate to `message`/`reason`. The status code (401) is unchanged.
 */

import type { Context } from "hono";

/**
 * The closed set of failure reasons. Reflects the auth-middleware decision
 * tree. New reasons require a coordinated update to the OpenAPI doc and any
 * client SDK that switches on this field.
 */
export type AuthErrorReason =
  | "no_auth" // No Authorization header / X-Session-Token header at all.
  | "invalid_format" // Header present but not parseable (e.g. wrong prefix).
  | "key_revoked" // Bearer key didn't match any active row in api_keys.
  | "expired" // Bearer key matched but expiresAt is in the past.
  | "missing_scope"; // Bearer is valid but lacks a scope required by the route.

/** Strongly-typed shape returned by `authErrorResponse`. */
export interface AuthErrorEnvelope {
  error: "unauthorized";
  reason: AuthErrorReason;
  message: string;
  missingScope?: string;
  keyIdPrefix?: string | null;
}

/** Default human-readable copy for each reason. Operators see this directly. */
const DEFAULT_MESSAGES: Record<AuthErrorReason, string> = {
  no_auth:
    "Authentication required. Use Authorization: Bearer <key> or X-Session-Token: <token>.",
  invalid_format:
    "Authorization header is malformed. Expected `Authorization: Bearer <key>` with a key starting with synap_user_, synap_hub_live_, or synap_hub_test_.",
  key_revoked:
    "API key is not active or no longer exists on this pod. Re-mint via POST /api/hub/setup/agent or pod admin tooling.",
  expired: "API key has expired. Mint a new key.",
  missing_scope: "API key is valid but lacks the scope required by this route.",
};

/**
 * Build and send a standardized 401 response.
 *
 * The HTTP status is fixed at 401 — `missing_scope` would conventionally be
 * 403, but we keep the envelope at 401 because the existing hub auth surface
 * uses 401 for both authentication and unscoped access (the auth middleware
 * itself doesn't gate scopes; per-handler 403s are kept as-is).
 *
 * @param c - Hono context (any Variables shape — we only need c.json).
 * @param reason - One of the closed-set reasons.
 * @param opts.message - Override the default human-readable copy.
 * @param opts.missingScope - Required scope name (only meaningful for
 *   `reason: "missing_scope"`).
 * @param opts.keyIdPrefix - First 8 chars of the api_keys.id when known.
 *   Helps operators correlate logs ("which key got rejected?") without
 *   leaking the full key.
 */
export function authErrorResponse(
  c: Context,
  reason: AuthErrorReason,
  opts?: {
    message?: string;
    missingScope?: string;
    keyIdPrefix?: string | null;
  }
): Response {
  const body: AuthErrorEnvelope = {
    error: "unauthorized",
    reason,
    message: opts?.message ?? DEFAULT_MESSAGES[reason],
  };
  if (opts?.missingScope) body.missingScope = opts.missingScope;
  if (opts?.keyIdPrefix) body.keyIdPrefix = opts.keyIdPrefix;
  return c.json(body, 401);
}

/**
 * Take the first 8 chars of a uuid as the safe-to-log key prefix.
 * Returns null when the id is missing/empty.
 */
export function shortenKeyId(keyId: string | null | undefined): string | null {
  if (!keyId) return null;
  return keyId.slice(0, 8);
}
