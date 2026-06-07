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
  // ── GET /connectors/providers ─────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/connectors/providers",
      tags: ["Connectors"],
      summary: "List available connector providers and connection status",
      responses: {
        200: {
          description: "Provider list",
          content: {
            "application/json": {
              schema: z
                .object({
                  providers: z.array(
                    z.object({
                      id: z.string(),
                      provider: z.string(),
                      displayName: z.string().optional(),
                      connected: z.boolean(),
                      connectionId: z.string().optional(),
                    })
                  ),
                })
                .openapi("ConnectorProviderList"),
            },
          },
        },
        503: {
          description: "Not configured",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const connector = syncConnectorRegistry.get("nango") as
        | NangoConnector
        | undefined;
      if (!connector || !connector.isConfigured()) {
        return c.json({ error: "Nango not configured" }, 503);
      }
      const userId = c.get("userId") as string;
      const [integrations, connections] = await Promise.all([
        connector.listIntegrations(),
        connector.listConnections(userId),
      ]);
      const connMap = new Map(
        connections.map((conn) => [conn.provider, conn.connectionId])
      );
      return c.json(
        {
          providers: integrations.map((i) => ({
            id: i.uniqueKey,
            provider: i.provider,
            displayName: i.displayName,
            connected: connMap.has(i.uniqueKey),
            connectionId: connMap.get(i.uniqueKey),
          })),
        },
        200
      );
    }
  );

  // ── POST /connectors/session ──────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/connectors/session",
      tags: ["Connectors"],
      summary: "Get an OAuth session URL for a specific provider",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  providerId: z.string().optional(),
                  workspaceId: z.string().optional(),
                })
                .openapi("ConnectorSessionRequest"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Session URL",
          content: {
            "application/json": {
              schema: z
                .object({
                  redirectUrl: z.string(),
                  sessionToken: z.string(),
                })
                .openapi("ConnectorSessionResult"),
            },
          },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
        503: {
          description: "Not configured",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const connector = syncConnectorRegistry.get("nango") as
        | NangoConnector
        | undefined;
      if (!connector || !connector.isConfigured()) {
        return c.json({ error: "Nango not configured" }, 503);
      }
      const userId = c.get("userId") as string;
      const { providerId, workspaceId } = c.req.valid("json");
      const effectiveProvider = providerId ?? "*";
      let session;
      try {
        session = await connector.createSession(
          userId,
          effectiveProvider,
          workspaceId ?? ""
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fall back to the generic picker when the requested integration
        // doesn't exist in Nango yet (not yet configured or wrong key).
        if (
          effectiveProvider !== "*" &&
          msg.toLowerCase().includes("integration does not exist")
        ) {
          try {
            session = await connector.createSession(
              userId,
              "*",
              workspaceId ?? ""
            );
          } catch (retryErr) {
            logger.error(
              { err: retryErr, providerId },
              "POST /connectors/session fallback failed"
            );
            return c.json(
              {
                error:
                  retryErr instanceof Error
                    ? retryErr.message
                    : "Unknown error",
              },
              500
            );
          }
        } else {
          logger.error({ err, providerId }, "POST /connectors/session failed");
          return c.json({ error: msg }, 500);
        }
      }
      return c.json(
        {
          redirectUrl: session.redirectUrl,
          sessionToken: session.sessionToken,
        },
        200
      );
    }
  );

  // ── DELETE /connectors/connections/:connectionId ──────────────────────────
  app.openapi(
    createRoute({
      method: "delete",
      path: "/connectors/connections/{connectionId}",
      tags: ["Connectors"],
      summary: "Disconnect a specific connection",
      request: {
        params: z.object({ connectionId: z.string() }),
      },
      responses: {
        200: {
          description: "Connection revoked",
          content: {
            "application/json": {
              schema: z
                .object({ success: z.boolean() })
                .openapi("RevokeConnectionResult"),
            },
          },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
        503: {
          description: "Not configured",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const connector = syncConnectorRegistry.get("nango") as
        | NangoConnector
        | undefined;
      if (!connector || !connector.isConfigured()) {
        return c.json({ error: "Nango not configured" }, 503);
      }
      const { connectionId } = c.req.valid("param");
      try {
        await connector.revokeConnection(connectionId);
        return c.json({ success: true }, 200);
      } catch (err) {
        logger.error(
          { err, connectionId },
          "DELETE /connectors/connections failed"
        );
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );

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
