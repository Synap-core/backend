/**
 * Hub Protocol REST — connectors
 *
 * External action routes backed by the Nango sync connector. Lets IS tools
 * trigger Nango actions (external writes) on connected integrations.
 *
 * Static routes BEFORE any /:id dynamic route (Hono rule).
 */

import { createRoute, z } from "@hono/zod-openapi";
import { syncConnectorRegistry } from "../../../connectors/index.js";
import type { NangoConnector } from "../../../connectors/NangoConnector.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { logger, type HubHono } from "./_shared.js";

export function registerConnectorsRoutes(app: HubHono): void {
  // ── POST /connectors/actions ──────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/connectors/actions",
      tags: ["Connectors"],
      summary: "Trigger a Nango action on a connected integration",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  connectionId: z.string(),
                  providerConfigKey: z.string(),
                  actionName: z.string(),
                  input: z.record(z.string(), z.unknown()).optional(),
                })
                .openapi("TriggerConnectorActionRequest"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Action triggered",
          content: {
            "application/json": {
              schema: z
                .object({ result: z.unknown() })
                .openapi("TriggerConnectorActionResult"),
            },
          },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
        503: {
          description: "Connector not configured",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const connector = syncConnectorRegistry.get("nango") as
        | NangoConnector
        | undefined;
      if (!connector || !connector.isConfigured()) {
        return c.json({ error: "Nango connector not configured" }, 503);
      }
      const { connectionId, providerConfigKey, actionName, input } =
        c.req.valid("json");
      try {
        const result = await connector.triggerAction({
          connectionId,
          providerConfigKey,
          actionName,
          input: input ?? {},
        });
        return c.json({ result }, 200);
      } catch (err) {
        logger.error(
          { err, connectionId, providerConfigKey, actionName },
          "POST /connectors/actions failed"
        );
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );
}
