/**
 * Hub Protocol REST — connectors
 *
 * External action routes backed by the Nango sync connector. Lets IS tools
 * trigger Nango actions (external writes) on connected integrations.
 *
 * Static routes BEFORE any /:id dynamic route (Hono rule).
 */

import { createRoute, z } from "@hono/zod-openapi";
import { db, workspaceMembers, eq, and } from "@synap/database";
import { syncConnectorRegistry } from "../../../connectors/index.js";
import type { NangoConnector } from "../../../connectors/NangoConnector.js";
import { triggerProviderAction } from "../../../connectors/external-dispatch.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  resolveActorId,
  type HubHono,
} from "./_shared.js";

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
      // TODO(W3/W4): becomes a capability cast (Readable/Pushable/Credentialed).
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
                  /**
                   * Optional: bind the resulting Nango connection to ANOTHER
                   * workspace member instead of the caller (the operator). Used
                   * by the Discord bridge so a linked teammate's `/connect`
                   * creates a connection owned by THEM. SECURITY-GATED: allowed
                   * only when the caller is owner/admin of the workspace OR is
                   * the same user; AND the target must be a workspace member.
                   */
                  onBehalfOfUserId: z.string().optional(),
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
      // TODO(W3/W4): becomes a capability cast (Readable/Pushable/Credentialed).
      const connector = syncConnectorRegistry.get("nango") as
        | NangoConnector
        | undefined;
      if (!connector || !connector.isConfigured()) {
        return c.json({ error: "Nango not configured" }, 503);
      }
      const callerUserId = c.get("userId") as string;
      const { providerId, workspaceId, onBehalfOfUserId } = c.req.valid("json");

      // Resolve WHO the connection binds to. Default = the caller (operator for
      // the bridge key) — behaviour unchanged when onBehalfOfUserId is absent.
      let userId = callerUserId;
      if (onBehalfOfUserId && onBehalfOfUserId !== callerUserId) {
        // ── SECURITY GATE (mirrors discord-identity.ts's link gate) ──────────
        // Bind the acting identity + workspace, then allow on-behalf-of only if
        // the caller is owner/admin of that workspace OR is acting as themself.
        const acting = await resolveActingContext(c, { workspaceId });
        if (!acting.ok) return c.json({ error: acting.error }, acting.status);
        const isPrivileged = acting.role === "owner" || acting.role === "admin";
        const isSelf = onBehalfOfUserId === acting.userId;
        if (!isPrivileged && !isSelf) {
          logger.warn(
            {
              callerUserId: acting.userId,
              workspaceId: acting.workspaceId,
              role: acting.role,
              onBehalfOfUserId,
            },
            "POST /connectors/session rejected: not owner/admin and not self"
          );
          return c.json(
            {
              error:
                "Only a workspace owner or admin can create a connection on behalf of another member",
            },
            403
          );
        }
        // The target MUST be a member of the acting workspace — never bind a
        // connection to an arbitrary pod user the caller can't actually manage.
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, acting.workspaceId),
            eq(workspaceMembers.userId, onBehalfOfUserId)
          ),
          columns: { id: true },
        });
        if (!membership) {
          return c.json(
            { error: "onBehalfOfUserId is not a member of this workspace" },
            403
          );
        }
        userId = onBehalfOfUserId;
      }

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
      // TODO(W3/W4): becomes a capability cast (Readable/Pushable/Credentialed).
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
      // TODO(W3/W4): becomes a capability cast (Readable/Pushable/Credentialed).
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

  // NOTE (W3b): the POST /connectors/actions route (Nango named-action 3rd path,
  // backed by the retired `triggerConnectorAction`) was REMOVED. The agnostic
  // POST /connectors/tool-execute door (backed by `triggerProviderAction`, which
  // dispatches Nango via `proxyRequest`) is the ONE governed external-action
  // endpoint.

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

      // TODO(W3/W4): becomes a capability cast (Readable/Pushable/Credentialed).
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
  //   - vault:// → credential resolved + downstream request executed via the vault handler
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
                  /**
                   * Optional acting workspace — routes a `propose` verdict's
                   * review proposal to the right workspace and scopes the gate.
                   */
                  workspaceId: z.string().optional(),
                  /**
                   * Optional AI-agent identity. Verified to be a real agent user
                   * before it's trusted; threaded to the capability-execution
                   * gate so an agent run routes to `propose`, not auto-run.
                   */
                  agentUserId: z.string().optional(),
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
        202: {
          description:
            "Execution requires human approval — a reviewable proposal was created instead of running.",
          content: {
            "application/json": {
              schema: z
                .object({
                  proposed: z.literal(true),
                  proposalId: z.string(),
                })
                .openapi("ToolExecuteProposed"),
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
      const {
        provider,
        method,
        path,
        body,
        accountHint,
        workspaceId,
        agentUserId,
      } = c.req.valid("json");

      // Verify a supplied agentUserId is a real agent user before trusting it.
      // An invalid id is rejected (never silently downgraded to operator — that
      // would let a caller fake operator trust by passing garbage).
      let resolvedAgentUserId: string | undefined;
      if (agentUserId) {
        const actor = await resolveActorId(agentUserId, userId);
        if ("error" in actor) {
          return c.json({ error: actor.error }, 403);
        }
        resolvedAgentUserId = agentUserId;
      }

      try {
        // ONE impl, two doors: the same dispatcher the proposals.ts
        // `provider.action` executor calls. No inline proxy logic here. The
        // capability-execution gate lives INSIDE triggerProviderAction, so this
        // door is now governed identically to the proposal door.
        const result = await triggerProviderAction({
          userId,
          provider,
          method,
          path,
          body,
          accountHint,
          workspaceId,
          agentUserId: resolvedAgentUserId,
        });

        // Gate routed to a reviewable proposal instead of executing.
        if (result.proposed) {
          return c.json(
            { proposed: true as const, proposalId: result.proposalId! },
            202
          );
        }

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

        // Map the structured failure onto the endpoint's response codes
        // (400 / 404 / 503).
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
