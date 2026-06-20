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
import {
  triggerConnectorAction,
  triggerProviderAction,
} from "../../../connectors/external-dispatch.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

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
    async (c): Promise<any> => {
      if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
        return c.json(
          { error: "Insufficient scope: hub-protocol.read required" },
          403
        );
      }
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
    async (c): Promise<any> => {
      if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
        return c.json(
          { error: "Insufficient scope: hub-protocol.write required" },
          403
        );
      }
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
    async (c): Promise<any> => {
      if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
        return c.json(
          { error: "Insufficient scope: hub-protocol.write required" },
          403
        );
      }
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

  // ── POST /connectors/disconnect ───────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/connectors/disconnect",
      tags: ["Connectors"],
      summary:
        "Disconnect a connection by connectionId (POST alternative to DELETE)",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  connectionId: z.string(),
                  provider: z.string().optional(),
                })
                .openapi("DisconnectRequest"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Connection revoked",
          content: {
            "application/json": {
              schema: z
                .object({ success: z.boolean() })
                .openapi("DisconnectResult"),
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
    async (c): Promise<any> => {
      if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
        return c.json(
          { error: "Insufficient scope: hub-protocol.write required" },
          403
        );
      }
      const connector = syncConnectorRegistry.get("nango") as
        | NangoConnector
        | undefined;
      if (!connector || !connector.isConfigured()) {
        return c.json({ error: "Nango not configured" }, 503);
      }
      const { connectionId } = c.req.valid("json");
      try {
        await connector.revokeConnection(connectionId);
        return c.json({ success: true }, 200);
      } catch (err) {
        logger.error(
          { err, connectionId },
          "POST /connectors/disconnect failed"
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
    async (c): Promise<any> => {
      if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
        return c.json(
          { error: "Insufficient scope: hub-protocol.write required" },
          403
        );
      }
      const { connectionId, providerConfigKey, actionName, input } =
        c.req.valid("json");
      try {
        const { success, result } = await triggerConnectorAction({
          connectionId,
          providerConfigKey,
          actionName,
          input: input ?? {},
        });
        if (!success)
          return c.json({ error: "Nango connector not configured" }, 503);
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

  // ── GET /connectors/connections/{provider} ──────────────────────────────
  //
  // Lists the authenticated user's connections for a specific Nango provider.
  // Registered AFTER the DELETE /connections/{connectionId} route — Hono
  // distinguishes by HTTP method so there is no route conflict.
  app.openapi(
    createRoute({
      method: "get",
      path: "/connectors/connections/{provider}",
      tags: ["Connectors"],
      summary:
        "List the authenticated user's connections for a specific provider",
      request: {
        params: z.object({ provider: z.string() }),
      },
      responses: {
        200: {
          description: "Connection list",
          content: {
            "application/json": {
              schema: z
                .object({
                  connections: z.array(
                    z.object({
                      connectionId: z.string(),
                      provider: z.string(),
                      createdAt: z.string(),
                    })
                  ),
                })
                .openapi("ConnectorProviderConnections"),
            },
          },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: ErrorSchema } },
        },
        503: {
          description: "Nango not configured",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c): Promise<any> => {
      if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
        return c.json(
          { error: "Insufficient scope: hub-protocol.read required" },
          403
        );
      }

      const connector = syncConnectorRegistry.get("nango") as
        | NangoConnector
        | undefined;
      if (!connector || !connector.isConfigured()) {
        return c.json({ error: "Nango not configured" }, 503);
      }

      const userId = c.get("userId") as string;
      const { provider } = c.req.valid("param");

      try {
        const allConnections = await connector.listConnections(userId);
        const filtered = allConnections.filter((c) => c.provider === provider);
        return c.json(
          {
            connections: filtered.map((conn) => ({
              connectionId: conn.connectionId,
              provider: conn.provider,
              createdAt: conn.createdAt.toISOString(),
            })),
          },
          200
        );
      } catch (err) {
        logger.error(
          { err, userId, provider },
          "GET /connectors/connections/:provider failed"
        );
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );

  // ── POST /connectors/tool-execute ───────────────────────────────────────
  //
  // Agnostic connector execution endpoint. Thin HTTP door over the shared
  // `triggerProviderAction()` dispatcher in connectors/external-dispatch.ts.
  // The SAME dispatcher backs the proposals.ts `provider.action` executor, so
  // the human/AI-bridge REST path and the proposal-approval path run identical
  // connector code (one impl, two doors — like sendExternalMessage).
  // Supported provider schemes:
  //   - nango:// → resolved via Nango proxy with Connection-Id + Provider-Config-Key
  //   - vault:// → credential resolved but execution not yet implemented (501)
  app.openapi(
    createRoute({
      method: "post",
      path: "/connectors/tool-execute",
      tags: ["Connectors"],
      summary: "Execute a provider tool (agnostic connector execution)",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  /** Provider reference (e.g. "nango://gmail", "vault://secret-id"). */
                  provider: z.string(),
                  /** HTTP method for the downstream request (GET, POST, PUT, DELETE, etc.). */
                  method: z.string(),
                  /** Path after the proxy root (e.g. "/gmail/v1/messages/send"). */
                  path: z.string(),
                  /** Optional request body for POST/PUT/PATCH. */
                  body: z.record(z.string(), z.unknown()).optional(),
                  /** Optional hint to pick a specific account when multiple connections exist. */
                  accountHint: z.string().optional(),
                })
                .openapi("ToolExecuteRequest"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Execution result",
          content: {
            "application/json": {
              schema: z
                .object({
                  status: z.number(),
                  headers: z.record(z.string(), z.string()).optional(),
                  body: z.unknown(),
                })
                .openapi("ToolExecuteResult"),
            },
          },
        },
        400: {
          description: "Bad request",
          content: { "application/json": { schema: ErrorSchema } },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: ErrorSchema } },
        },
        404: {
          description: "Tool or connection not found",
          content: { "application/json": { schema: ErrorSchema } },
        },
        501: {
          description: "Provider type not yet supported for execution",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c): Promise<any> => {
      if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
        return c.json(
          { error: "Insufficient scope: hub-protocol.write required" },
          403
        );
      }

      const userId = c.get("userId") as string;
      const { provider, method, path, body, accountHint } = c.req.valid("json");

      try {
        // ONE impl, two doors: the same dispatcher the proposals.ts
        // `provider.action` executor calls. No inline proxy logic here.
        const result = await triggerProviderAction({
          userId,
          provider,
          method,
          path,
          body,
          accountHint,
        });

        if (result.success) {
          return c.json(
            {
              status: result.status,
              headers: result.headers,
              body: result.body,
            },
            200
          );
        }

        // Map the structured failure onto the endpoint's response codes,
        // preserving the prior status codes (400 / 404 / 501 / 503).
        if (result.status === 501) {
          return c.json(
            {
              status: "not_implemented",
              provider: "vault://",
              detail: result.error,
            },
            501
          );
        }
        const code =
          result.status === 404 ? 404 : result.status === 503 ? 503 : 400;
        return c.json({ error: result.error ?? "Unknown error" }, code);
      } catch (err) {
        logger.error(
          { err, userId, provider, method, path },
          "POST /connectors/tool-execute failed"
        );
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );
}
