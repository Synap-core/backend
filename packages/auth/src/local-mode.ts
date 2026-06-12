/**
 * Local Mode — fixed-identity auth for the embedded local pod.
 *
 * When LOCAL_MODE=true the pod runs without Kratos/Hydra. A single
 * operator user is authenticated via a static bearer token
 * (LOCAL_AUTH_TOKEN). This module is the single source of truth for
 * that identity — no identity literals should be duplicated elsewhere.
 *
 * The identity shape mirrors what orySessionMiddleware sets on the Hono
 * context so all downstream code (tRPC procedures, hub-protocol handlers,
 * etc.) sees the same shape regardless of auth path.
 */

import { timingSafeEqual } from "crypto";

// ── Module-level local-mode state ────────────────────────────────────────────
// Set once at startup by configureLocalMode() (called from apps/api/src/index.ts
// immediately after config validation). All auth paths read ONLY these values;
// no code outside this module should read process.env.LOCAL_MODE directly.

let _localModeEnabled = false;
let _localAuthToken: string | undefined;

/**
 * Initialise local-mode state from the Zod-validated config values.
 * Must be called once at pod startup before any request is handled.
 */
export function configureLocalMode(enabled: boolean, token?: string): void {
  _localModeEnabled = enabled;
  _localAuthToken = token;
}

/** Returns true when the pod is running in LOCAL_MODE. */
export function isLocalModeEnabled(): boolean {
  return _localModeEnabled;
}

/** Returns the configured LOCAL_AUTH_TOKEN (undefined when not set). */
export function getLocalAuthToken(): string | undefined {
  return _localAuthToken;
}

/**
 * Timing-safe token comparison.
 *
 * Uses crypto.timingSafeEqual so that the comparison time is constant
 * regardless of where (if anywhere) the two strings differ, preventing
 * timing-oracle attacks.
 *
 * Length mismatch is handled by hashing both sides to a fixed-length
 * buffer before comparison — this ensures even a length difference does
 * not produce an early exit that leaks information.
 */
export function safeTokenEqual(a: string, b: string): boolean {
  // Encode both strings to UTF-8 buffers.
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  // Guard: empty tokens must never compare equal to anything.
  if (bufA.length === 0 || bufB.length === 0) return false;

  // If lengths differ, pad the shorter one with zeros so timingSafeEqual
  // receives equal-length buffers. We then AND in an explicit length check
  // so a length mismatch always returns false — but in constant time.
  const maxLen = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);

  const lengthsMatch = bufA.length === bufB.length;
  const contentsMatch = timingSafeEqual(paddedA, paddedB);
  return lengthsMatch && contentsMatch;
}

/**
 * The stable user-id used for the local operator in LOCAL_MODE.
 * Seeded into the `users` table at startup.
 */
export const LOCAL_USER_ID = "local-operator";

/**
 * The Hono context "user" object that downstream handlers read.
 * Shape must match what orySessionMiddleware sets.
 */
export function buildLocalUser() {
  return {
    id: LOCAL_USER_ID,
    email: "operator@local",
    name: "Local Operator",
  } as const;
}

/**
 * The Hono context "session" object that downstream handlers may read.
 * Mirrors the Kratos session shape (identity wrapper).
 */
export function buildLocalSession() {
  const user = buildLocalUser();
  return {
    id: "local-session",
    active: true,
    identity: {
      id: user.id,
      traits: {
        email: user.email,
        name: user.name,
      },
    },
  } as const;
}

/**
 * The /api/session response shape that the browser client expects.
 * Mirrors the real path: { authenticated: true, session }.
 */
export function buildLocalApiSession() {
  return {
    authenticated: true as const,
    session: buildLocalSession(),
  };
}
