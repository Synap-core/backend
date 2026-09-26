/**
 * Shared OpenAPI primitives for Hub Protocol REST.
 *
 * - `IdempotencyKeyHeader` — opt-in `Idempotency-Key` header documented on
 *   every write (POST/PUT/PATCH/DELETE) operation. The middleware itself lives
 *   in `_middleware/idempotency.ts`.
 * - `ErrorSchema` — canonical `{ error: string }` payload returned by every
 *   non-2xx handler in the hub.
 * - `errorResponse` / `okJson` — small helpers so per-resource files don't
 *   repeat the same `content: { "application/json": { schema } }` boilerplate.
 *
 * These are intentionally thin so callers can compose richer route configs.
 */

import { z } from "@hono/zod-openapi";

/** Reusable opt-in idempotency header parameter. */
export const IdempotencyKeyHeader = z
  .string()
  .min(8)
  .max(256)
  .optional()
  .openapi({
    param: {
      name: "Idempotency-Key",
      in: "header",
      required: false,
    },
    description:
      "Optional UUID/ULID; identical (key, body, user) returns cached 2xx response for 24h.",
    example: "01HV3RZJ4M5T7Q9Z3E0X2B6N8K",
  });

/**
 * The text form Postgres accepts for a `uuid` column: 8-4-4-4-12 hex, any
 * version/variant nibble. Deliberately NOT zod's `.uuid()` (RFC 9562 — it
 * rejects version/variant nibbles Postgres happily stores, so a valid stored
 * id could be refused at the door). Same shape as `_shared.ts`'s `isUuid`.
 */
export const PG_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical REQUEST-input schema for a caller-supplied id bound to a Postgres
 * `uuid` column (query string or JSON body) — the sibling of `_shared.ts`'s
 * `uuidPathParam`. Use it for every `workspaceId` a Hub route accepts.
 *
 * WHY: `workspaceId: z.string()` accepts anything; the value then reaches a
 * `uuid` column comparison (e.g. `verifyWorkspaceReadAccess`), Postgres throws
 * `invalid input syntax for type uuid` (22P02), and the route's catch turns a
 * caller mistake into a 500 (reproduced live 2026-09-25:
 * `GET /entities?workspaceId=notauuid` → 500). A malformed id is a CLIENT
 * error and must be a 400 at the door.
 *
 * The EMPTY string is accepted on purpose: every handler reading these params
 * treats `""` as "absent" (`query.workspaceId || null`), and callers (CLI with
 * an unset env var) do send `?workspaceId=`. Refusing it would be a behaviour
 * change riding on a bug fix. Chain `.optional()` / `.nullable()` as needed.
 *
 * Kept in this pure module (not `_shared.ts`) so `_codecs/*` request schemas
 * can use it without importing the router graph `_shared.ts` pulls in.
 * Tripwire: `__tripwires__/hub-workspace-id-input-is-uuid.test.ts` walks the
 * live OpenAPI registry, so a new route joins the scan by existing.
 */
export const uuidQueryParam = z
  .string()
  .refine((v) => v === "" || PG_UUID_RE.test(v), {
    message:
      "must be a full 36-character UUID (8-4-4-4-12 hex). A truncated, " +
      "display-shortened or slug value will not resolve — re-fetch the full " +
      "id (e.g. GET /api/hub/workspaces) and retry.",
  });

/** Canonical error envelope returned by every hub handler. */
export const ErrorSchema = z
  .object({
    error: z.string(),
  })
  .openapi("HubError");

/**
 * Build a standard JSON response entry for a given Zod schema.
 * Used by route configs in per-resource files.
 */
export function jsonContent<T extends z.ZodType>(
  schema: T,
  description: string
) {
  return {
    description,
    content: {
      "application/json": {
        schema,
      },
    },
  };
}

/** Generic error response entry. */
export function errorResponse(description: string) {
  return jsonContent(ErrorSchema, description);
}

/** Standard write-response set: 401, 403, 500. Spread into responses object. */
export const writeErrorResponses = {
  400: errorResponse("Bad request"),
  401: errorResponse("Unauthorized"),
  403: errorResponse("Forbidden — missing scope or workspace access"),
  500: errorResponse("Internal error"),
} as const;

/** Standard read-response set: 401, 403, 500. */
export const readErrorResponses = {
  401: errorResponse("Unauthorized"),
  403: errorResponse("Forbidden — missing scope or workspace access"),
  500: errorResponse("Internal error"),
} as const;

/**
 * Every status `httpStatusForTrpcError` (`_shared.ts`) can return. Spread FIRST
 * into a route's `responses` whose catch maps through that helper, so the typed
 * handler may return the mapped status (route-specific entries after it win).
 */
export const trpcErrorResponses = {
  400: errorResponse("Bad request — the wrapped door refused the input"),
  403: errorResponse("Forbidden"),
  404: errorResponse("Not found"),
  409: errorResponse("Conflict — a refusal the caller can act on"),
  412: errorResponse("Precondition failed"),
  500: errorResponse("Internal error"),
} as const;

/** Bearer-auth security requirement for protected routes. */
export const bearerSecurity = [{ bearerAuth: [] }];
