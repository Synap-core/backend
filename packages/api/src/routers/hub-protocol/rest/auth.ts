/**
 * Hub Protocol REST — auth introspection.
 *
 * `GET /auth/status` — when called with a valid bearer key, returns the
 * introspection of that key (id, scopes, expiry, owning user). External
 * operators (Eve CLI, OpenClaw, custom integrations) use this to verify
 * what their key can do BEFORE attempting privileged calls.
 *
 * The endpoint is auth-gated by the same middleware as the rest of
 * `/api/hub/*` — there's no "ping with junk credentials and get a hint"
 * path, because that would leak which keys exist on the pod.
 */

import { createRoute } from "@hono/zod-openapi";
import { db, apiKeys, users, eq } from "@synap/database";

import { shortenKeyId } from "../../../utils/auth-error.js";
import { AuthStatusSchema } from "./_codecs/auth.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { logger, type HubHono } from "./_shared.js";

export function registerAuthRoutes(app: HubHono): void {
  const authStatusRoute = createRoute({
    method: "get",
    path: "/auth/status",
    tags: ["Auth"],
    summary: "Introspect the calling bearer credential",
    description:
      "Returns metadata about the API key that authenticated this request — " +
      "id, owning user, scopes, expiry, last-used-at. Used by Eve CLI and " +
      "external operators to verify their credential without making " +
      "privileged calls. Returns 401 if no valid bearer was supplied.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Bearer credential introspection.",
        content: { "application/json": { schema: AuthStatusSchema } },
      },
      401: { $ref: "#/components/responses/Unauthorized" },
      403: {
        description:
          "Forbidden — bearer is not an API key (e.g. session-token caller)",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description:
          "Key was accepted by the auth middleware but its row was deleted concurrently.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(authStatusRoute, async (c) => {
    const apiKeyId = c.get("apiKeyId");
    const userId = c.get("userId");

    // The middleware sets `apiKeyId` only on the bearer-auth path. Session-
    // token callers (X-Session-Token) reach this handler with a userId but
    // no apiKeyId — there's nothing to introspect. Return 403 so clients
    // can tell the difference between "not authenticated" and "authenticated
    // but with the wrong credential type for this endpoint".
    if (!apiKeyId) {
      return c.json(
        {
          error:
            "/auth/status requires a Bearer API key. Session-token callers have no introspectable key.",
        },
        403
      );
    }
    if (!userId) {
      // Defensive — middleware is supposed to set userId alongside apiKeyId.
      return c.json(
        { error: "Internal error: missing userId on context" },
        500
      );
    }

    try {
      const [row] = await db
        .select({
          keyId: apiKeys.id,
          userId: apiKeys.userId,
          name: apiKeys.keyName,
          scope: apiKeys.scope,
          createdAt: apiKeys.createdAt,
          expiresAt: apiKeys.expiresAt,
          lastUsedAt: apiKeys.lastUsedAt,
          parentKeyId: apiKeys.parentKeyId,
          isActive: apiKeys.isActive,
          userEmail: users.email,
          userName: users.name,
        })
        .from(apiKeys)
        .leftJoin(users, eq(users.id, apiKeys.userId))
        .where(eq(apiKeys.id, apiKeyId));

      if (!row) {
        // The key passed validation moments ago but the row vanished — most
        // likely a concurrent revoke + cascade delete. Tell the caller in
        // structured form rather than a confusing 500.
        return c.json(
          { error: "API key row not found (revoked concurrently?)" },
          404
        );
      }

      // Drizzle returns Date objects for timestamp columns; the wire schema
      // declares ISO strings. Convert here so the response shape matches.
      return c.json(
        {
          keyId: row.keyId,
          keyIdPrefix: shortenKeyId(row.keyId) ?? "",
          userId: row.userId,
          userEmail: row.userEmail ?? null,
          userName: row.userName ?? null,
          name: row.name ?? null,
          scopes: (row.scope ?? []) as string[],
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
          lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
          parentKeyId: row.parentKeyId ?? null,
          isActive: row.isActive,
        },
        200
      );
    } catch (err) {
      logger.error({ err, apiKeyId }, "/auth/status lookup failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
