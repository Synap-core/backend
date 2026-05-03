/**
 * Auth Wire Codecs — Hub Protocol REST schemas for the auth surface.
 *
 * - `AuthStatusSchema` — response from `GET /auth/status`. Mirrors the bearer
 *   key + owning user, used by Eve CLI and similar operators to introspect
 *   their credential ("which key am I sending? does it have the scopes I
 *   think it does? when does it expire?").
 * - `AuthErrorEnvelopeSchema` — closed-set 401 envelope. Source-of-truth
 *   shape lives in `utils/auth-error.ts`; this is the OpenAPI mirror so the
 *   `/openapi.json` doc references a named schema.
 */

import { z } from "@hono/zod-openapi";

/**
 * Wire shape returned by `GET /api/hub/auth/status` for a valid bearer.
 *
 * `keyIdPrefix` is the first 8 chars of the api_keys.id — safe to log,
 * sufficient to correlate auth failures with the rejected key.
 *
 * `userEmail` / `userName` come from the users row joined to the api_keys
 * row. They MAY be null — agent users (created via `/setup/agent`) often
 * carry only a synthetic email.
 */
export const AuthStatusSchema = z
  .object({
    keyId: z.string().uuid(),
    keyIdPrefix: z.string(),
    userId: z.string(),
    userEmail: z.string().nullable(),
    userName: z.string().nullable(),
    name: z.string().nullable().describe("Human-friendly key name."),
    scopes: z.array(z.string()),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    lastUsedAt: z.string().datetime().nullable(),
    parentKeyId: z.string().uuid().nullable(),
    isActive: z.boolean(),
  })
  .openapi("AuthStatus");

/** OpenAPI mirror of the standardized 401 envelope from `auth-error.ts`. */
export const AuthErrorEnvelopeSchema = z
  .object({
    error: z.literal("unauthorized"),
    reason: z.enum([
      "key_revoked",
      "missing_scope",
      "expired",
      "invalid_format",
      "no_auth",
    ]),
    message: z.string(),
    missingScope: z.string().optional(),
    keyIdPrefix: z.string().optional(),
  })
  .openapi("AuthErrorEnvelope");
