/**
 * Hub Protocol REST — keys
 *
 * Self-service key rotation for CLI and agent callers. The only operation
 * exposed here is rotate-cli: revoke the calling key and re-issue it with the
 * latest INTEGRATION_HUB_SCOPES.cli scope set so existing installations pick
 * up new scopes without going through pod setup again.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { db, eq } from "@synap/database";
import { apiKeys } from "@synap/database/schema";
import type { ApiKeyScope } from "@synap/database";
import { apiKeyService } from "../../../services/api-keys.js";
import { INTEGRATION_HUB_SCOPES } from "../../../services/hub-integration-registration.js";
import { ErrorSchema, bearerSecurity } from "./_codecs/_openapi.js";
import { logger, type HubHono } from "./_shared.js";

export function registerKeysRoutes(app: HubHono): void {
  // ── POST /keys/rotate-cli ─────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/keys/rotate-cli",
      tags: ["Keys"],
      summary: "Rotate the calling key to the latest CLI scope set",
      description:
        "Revokes the current key and issues a new one with the full " +
        "INTEGRATION_HUB_SCOPES.cli scope set. Safe to call with a stale-scoped key — " +
        "no extra scope check required beyond being active.",
      security: bearerSecurity,
      responses: {
        200: {
          description: "New key issued",
          content: {
            "application/json": {
              schema: z
                .object({
                  apiKey: z.string(),
                  keyId: z.string(),
                  scopes: z.array(z.string()),
                })
                .openapi("RotateCliKeyResult"),
            },
          },
        },
        400: {
          description: "Bad request",
          content: { "application/json": { schema: ErrorSchema } },
        },
        401: {
          description:
            "Unauthorized — no API key auth (session-token callers not supported)",
          content: { "application/json": { schema: ErrorSchema } },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const keyId = c.get("apiKeyId");
      const userId = c.get("userId") as string;

      if (!keyId) {
        return c.json(
          { error: "Key rotation requires API key auth (Bearer token)" },
          401
        );
      }

      // Load the full key record so we can forward keyName and hubId to the new key.
      const keyRecord = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, keyId),
      });

      if (!keyRecord) {
        return c.json({ error: "Calling key not found" }, 400);
      }

      try {
        const { key: newKey, keyId: newKeyId } =
          await apiKeyService.generateApiKey(
            keyRecord.userId,
            keyRecord.keyName,
            INTEGRATION_HUB_SCOPES.cli as ApiKeyScope[],
            keyRecord.hubId ?? undefined
          );

        await apiKeyService.revokeApiKey(
          keyId,
          userId,
          "Rotated to updated CLI scopes"
        );

        logger.info(
          { oldKeyId: keyId, newKeyId, userId },
          "CLI key rotated via POST /keys/rotate-cli"
        );

        return c.json(
          {
            apiKey: newKey,
            keyId: newKeyId,
            scopes: INTEGRATION_HUB_SCOPES.cli,
          },
          200
        );
      } catch (err) {
        logger.error({ err, keyId, userId }, "POST /keys/rotate-cli failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );
}
