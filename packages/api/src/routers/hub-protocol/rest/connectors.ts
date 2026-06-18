/**
 * Hub Protocol REST — connectors
 *
 * External action routes backed by the Nango sync connector. Lets IS tools
 * trigger Nango actions (external writes) on connected integrations.
 *
 * Static routes BEFORE any /:id dynamic route (Hono rule).
 */

import { createRoute, z } from "@hono/zod-openapi";
import { db, eq, and, isNull } from "@synap/database";
import { tools } from "@synap/database";
import { syncConnectorRegistry } from "../../../connectors/index.js";
import type { NangoConnector } from "../../../connectors/NangoConnector.js";
import { triggerConnectorAction } from "../../../connectors/external-dispatch.js";
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

  // ── GET /connectors/schema ───────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/connectors/schema",
      tags: ["Connectors"],
      summary:
        "Return available connector providers with their actions for agent context",
      responses: {
        200: {
          description: "Connector schema",
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
                .openapi("ConnectorSchema"),
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
    async (c) => {
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
    async (c) => {
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
    async (c) => {
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
  // Agnostic connector execution endpoint. Serves TWO consumers:
  //   1. dispatchExternalAction() in proposals.ts (proposal-approved actions)
  //   2. callProvider() bridge in skills-executor (AI-written code in isolated-vm)
  //
  // The single dispatch point — no per-provider branches in the caller.
  // Supported provider schemes:
  //   - nango:// → resolved via Nango proxy with Connection-Id + Provider-Config-Key
  //   - vault:// → credential resolved but execution not yet implemented
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
    async (c) => {
      if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
        return c.json(
          { error: "Insufficient scope: hub-protocol.write required" },
          403
        );
      }

      const userId = c.get("userId") as string;
      const { provider, method, path, body, accountHint } = c.req.valid("json");

      // ── Validate provider scheme ─────────────────────────────────────────
      if (
        !provider.startsWith("nango://") &&
        !provider.startsWith("vault://")
      ) {
        return c.json(
          {
            error: `Unsupported provider scheme. Supported: nango://, vault://. Got: ${provider.split("://")[0]}://`,
          },
          400
        );
      }

      try {
        // ── Look up the tool row ──────────────────────────────────────────
        const [tool] = await db
          .select()
          .from(tools)
          .where(
            and(eq(tools.credentialRef, provider), isNull(tools.workspaceId))
          )
          .limit(1);

        if (!tool) {
          return c.json(
            { error: `Tool not found for provider: ${provider}` },
            404
          );
        }

        if (tool.kind !== "provider" && tool.kind !== "external") {
          return c.json(
            {
              error: `Tool kind "${tool.kind}" is not executable via this endpoint. Expected "provider" or "external".`,
            },
            400
          );
        }

        // ── Route by provider scheme ──────────────────────────────────────
        if (provider.startsWith("nango://")) {
          const connector = syncConnectorRegistry.get("nango") as
            | NangoConnector
            | undefined;
          if (!connector || !connector.isConfigured()) {
            return c.json({ error: "Nango not configured" }, 503);
          }

          // Resolve provider config key from the tool row
          const toolConfig = (tool.config ?? {}) as Record<string, unknown>;
          const providerConfigKey =
            (toolConfig.providerConfigKey as string) ??
            tool.credentialRef!.replace(/^nango:\/\//, "");

          // Resolve user's connection for this provider
          const connections = await connector.listConnections(userId);
          const matchingConnections = connections.filter(
            (conn) => conn.provider === providerConfigKey
          );

          if (matchingConnections.length === 0) {
            return c.json(
              {
                error: `No connection found for provider "${providerConfigKey}". Connect it via Settings → Connectors first.`,
              },
              404
            );
          }

          // Pick by accountHint (match connectionId prefix) or default to most recent
          let connection = matchingConnections[0]!;
          if (accountHint) {
            const hinted = matchingConnections.find((c) =>
              c.connectionId.includes(accountHint)
            );
            if (hinted) connection = hinted;
          } else {
            // Most recently created (latest first from Nango)
            connection = matchingConnections.sort(
              (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
            )[0]!;
          }

          const result = await connector.proxyRequest({
            connectionId: connection.connectionId,
            providerConfigKey,
            method,
            path,
            body,
          });

          return c.json(
            {
              status: result.status,
              headers: result.headers,
              body: result.body,
            },
            200
          );
        }

        // vault:// — credential resolution exists, generic HTTP proxy does not
        return c.json(
          {
            status: "not_implemented",
            provider: "vault://",
            detail:
              "TODO: vault:// provider execution is not yet implemented. " +
              "The credential is stored in the vault but there is no generic HTTP proxy " +
              "for vault-resolved secrets yet. Implement a bridge that uses the resolved " +
              "credential (e.g. API key) to make the HTTP call directly.",
          },
          501
        );
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
