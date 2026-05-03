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

/** Bearer-auth security requirement for protected routes. */
export const bearerSecurity = [{ bearerAuth: [] }];
