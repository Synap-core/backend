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
import {
  resolveNangoConnector,
  resolveNangoConnectorResult,
} from "../../../connectors/index.js";
import { triggerProviderAction } from "../../../connectors/external-dispatch.js";
import { materializeConnectorTools } from "../../../connectors/materialize-tools.js";
import { detachNangoConnectionRegistry } from "../../../services/capabilities/capability-nango-sync.js";
import { createHubProtocolCallerContext } from "../utils.js";
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
                  // Discriminates "we couldn't check" from "nothing declared" —
                  // an empty `providers` alone conflates the two, which is the
                  // false diagnosis `synap status` would otherwise print.
                  nangoStatus: z.enum(["ok", "error"]),
                  nangoError: z
                    .object({
                      reason: z.enum([
                        "unreachable",
                        "unauthenticated",
                        "malformed",
                        // Resolver-level faults: the credential likely exists and
                        // could not be read. Distinct from "not configured", so a
                        // broken vault is not reported as an absent one.
                        "vault-unreadable",
                        "db-unavailable",
                      ]),
                      message: z.string(),
                    })
                    .optional(),
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
      const resolved = await resolveNangoConnectorResult();
      if (!resolved.ok) {
        // A configured-but-unreadable Nango is a 200 `error` status, NOT a 503
        // "not configured". The two demand opposite fixes (restore the vault
        // key vs. connect Nango), and reporting the first as the second is the
        // exact false diagnosis this door exists to prevent.
        if (resolved.reason === "not-configured") {
          return c.json({ error: "Nango not configured" }, 503);
        }
        return c.json(
          {
            providers: [],
            nangoStatus: "error" as const,
            nangoError: { reason: resolved.reason, message: resolved.error },
          },
          200
        );
      }
      const connector = resolved.connector;
      const userId = c.get("userId") as string;
      const [declared, connections] = await Promise.all([
        connector.listIntegrationsResult(),
        connector.listConnections(userId),
      ]);
      if (!declared.ok) {
        return c.json(
          {
            providers: [],
            nangoStatus: "error" as const,
            nangoError: { reason: declared.reason, message: declared.error },
          },
          200
        );
      }
      const connMap = new Map(
        connections.map((conn) => [conn.provider, conn.connectionId])
      );
      return c.json(
        {
          providers: declared.integrations.map((i) => ({
            id: i.uniqueKey,
            provider: i.provider,
            displayName: i.displayName,
            connected: connMap.has(i.uniqueKey),
            connectionId: connMap.get(i.uniqueKey),
          })),
          nangoStatus: "ok" as const,
        },
        200
      );
    }
  );

  // ── POST /connectors/connect ──────────────────────────────────────────────
  //
  // THE single "resolve-or-start" door every thin client (Discord bot, CLI, the
  // IS connect_service tool, browser) calls instead of re-implementing the flow.
  // In one governed call it: (1) resolves the requested provider against the
  // real integration list (no provider-less generic picker — an unknown/empty
  // provider returns the pickable list so the caller can choose), (2) checks for
  // an EXISTING connection for the acting user → returns it instead of pushing a
  // fresh OAuth, (3) otherwise mints a provider-SPECIFIC OAuth session URL.
  // `onBehalfOfUserId` binds the connection to another workspace member (same
  // owner/admin gate as POST /connectors/session). Owner-kinds beyond the acting
  // user (global / entity / agent — the `authBinding` axis) are a documented
  // follow-up: they need matching execution-side resolution in nangoHandler, so
  // we don't half-wire a creation path the dispatcher can't resolve yet.
  app.openapi(
    createRoute({
      method: "post",
      path: "/connectors/connect",
      tags: ["Connectors"],
      summary:
        "Resolve-or-start a connection for a provider (the unified door)",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  provider: z.string().optional(),
                  workspaceId: z.string().optional(),
                  onBehalfOfUserId: z.string().optional(),
                  // Force a fresh OAuth session even when a connection record
                  // already exists — the reconnect path for an EXPIRED/revoked
                  // token, which the record's mere existence can't detect. Without
                  // it the door short-circuits to `connected` and the stale token
                  // is never refreshed.
                  forceReauth: z.boolean().optional(),
                })
                .openapi("ConnectorConnectRequest"),
            },
          },
        },
      },
      responses: {
        200: {
          description:
            "Connection status: connected | setup_required | provider_required | provider_unavailable",
          content: {
            "application/json": {
              schema: z
                .object({
                  status: z.enum([
                    "connected",
                    "setup_required",
                    "provider_required",
                    "provider_unavailable",
                  ]),
                  provider: z.string().optional(),
                  displayName: z.string().optional(),
                  // provider_unavailable: WHY the pod can't offer it. `reason`
                  // separates "Nango answered, doesn't declare it" from the
                  // lookup failures, so the caller states the real cause.
                  code: z.literal("POD_PROVIDER_NOT_CONFIGURED").optional(),
                  reason: z
                    .enum([
                      "not_declared",
                      "unauthenticated",
                      "unreachable",
                      "malformed",
                    ])
                    .optional(),
                  message: z.string().optional(),
                  connectionId: z.string().optional(),
                  redirectUrl: z.string().optional(),
                  sessionToken: z.string().optional(),
                  // Populated for provider_required: the pickable provider list.
                  providers: z
                    .array(
                      z.object({
                        id: z.string(),
                        provider: z.string(),
                        displayName: z.string().optional(),
                        connected: z.boolean(),
                      })
                    )
                    .optional(),
                  // Populated for `connected`: the verbs this connection unlocked
                  // (from the provider's family template), so the caller can show
                  // "you can now: send email, list calendar, …".
                  unlocked: z
                    .array(
                      z.object({
                        provider: z.string(),
                        displayName: z.string(),
                        skills: z.array(
                          z.object({
                            name: z.string(),
                            description: z.string().optional(),
                          })
                        ),
                      })
                    )
                    .optional(),
                })
                .openapi("ConnectorConnectResult"),
            },
          },
        },
        403: {
          description: "Forbidden",
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
      const connector = await resolveNangoConnector();
      if (!connector || !connector.isConfigured()) {
        return c.json({ error: "Nango not configured" }, 503);
      }

      const { provider, workspaceId, onBehalfOfUserId, forceReauth } =
        c.req.valid("json");

      // Resolve the acting identity. Default = the caller; an explicit
      // onBehalfOfUserId binds to another member (owner/admin-gated + the target
      // must be a workspace member). Same gate as POST /connectors/session.
      let userId = c.get("userId") as string;
      if (onBehalfOfUserId && onBehalfOfUserId !== userId) {
        const acting = await resolveActingContext(c, { workspaceId });
        if (!acting.ok) return c.json({ error: acting.error }, acting.status);
        // On-behalf-of binds to another WORKSPACE member, so a workspace is
        // required here (no pod-personal delegation).
        if (!acting.workspaceId) {
          return c.json(
            {
              error:
                "workspaceId is required to connect on behalf of another member",
            },
            400
          );
        }
        const isPrivileged = acting.role === "owner" || acting.role === "admin";
        if (!isPrivileged) {
          return c.json(
            {
              error:
                "Only a workspace owner or admin can connect on behalf of another member",
            },
            403
          );
        }
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

      try {
        const [declared, connections] = await Promise.all([
          connector.listIntegrationsResult(),
          connector.listConnections(userId),
        ]);

        const wanted = (provider ?? "").trim().toLowerCase();

        // Could not find out what this pod offers → say THAT, naming the real
        // cause. Minting a session against an unvalidated provider here is what
        // produced the vendor 500 this door exists to prevent.
        if (!declared.ok) {
          const message =
            declared.reason === "unauthenticated"
              ? `This pod's NANGO_SECRET_KEY is not valid for its Nango environment, so its integrations can't be listed. A pod admin needs to fix the key.`
              : declared.reason === "unreachable"
                ? `This pod cannot reach its Nango server, so its integrations can't be listed. A pod admin needs to check that Nango is running and reachable.`
                : `This pod's Nango returned an integration list that could not be read. A pod admin needs to check the Nango version and configuration.`;
          return c.json(
            {
              status: "provider_unavailable" as const,
              ...(provider ? { provider } : {}),
              code: "POD_PROVIDER_NOT_CONFIGURED" as const,
              reason: declared.reason,
              message,
            },
            200
          );
        }

        const integrations = declared.integrations;

        // ── Provider resolution: match the requested term against the real
        // integration list by uniqueKey / provider / displayName (case-insensitive).
        const match = wanted
          ? integrations.find(
              (i) =>
                i.uniqueKey.toLowerCase() === wanted ||
                i.provider.toLowerCase() === wanted ||
                (i.displayName ?? "").toLowerCase() === wanted
            )
          : undefined;

        // Nango answered and declares nothing. A picker with zero entries is the
        // same dead end as an unvalidated session, so neither is offered — the
        // remedy is for a pod admin to declare the integration.
        if (integrations.length === 0) {
          return c.json(
            {
              status: "provider_unavailable" as const,
              ...(provider ? { provider } : {}),
              code: "POD_PROVIDER_NOT_CONFIGURED" as const,
              reason: "not_declared" as const,
              message: provider
                ? `This pod's Nango declares no integrations, so "${provider}" can't be connected yet. A pod admin needs to declare it in the Nango dashboard.`
                : `This pod's Nango declares no integrations yet. A pod admin needs to declare one in the Nango dashboard before anything can be connected.`,
            },
            200
          );
        }

        if (!match) {
          const connSet = new Set(connections.map((conn) => conn.provider));
          return c.json(
            {
              status: "provider_required" as const,
              providers: integrations.map((i) => ({
                id: i.uniqueKey,
                provider: i.provider,
                displayName: i.displayName,
                connected: connSet.has(i.uniqueKey),
              })),
            },
            200
          );
        }

        // ── Already connected? Return it instead of a fresh OAuth — UNLESS the
        // caller forces a reconnect (expired/revoked token: the record exists but
        // its credential is dead, which only forcing a fresh OAuth session fixes).
        const existing = connections.find(
          (conn) => conn.provider === match.uniqueKey
        );
        if (existing && !forceReauth) {
          // Self-completing door: the moment a connection is confirmed,
          // materialize its provider tool + apply the family template (verbs +
          // skills + grants). Idempotent — safe to re-run on every poll. This is
          // what lets a CLI/agent connect (no browser) arrive fully wired, and
          // surfaces what the connection unlocked. Best-effort: a materialize
          // failure must not break the "you're connected" signal.
          let unlocked: Awaited<
            ReturnType<typeof materializeConnectorTools>
          >["unlocked"] = [];
          try {
            const ctx = await createHubProtocolCallerContext(
              userId,
              c.get("scopes") as string[],
              null
            );
            const result = await materializeConnectorTools(ctx, connector);
            unlocked = result.unlocked.filter(
              (u) => u.provider === match.uniqueKey
            );
          } catch (matErr) {
            logger.warn(
              { err: matErr, provider: match.uniqueKey },
              "connect: tool materialization failed (connection still valid)"
            );
          }
          // Idempotency: a reconnect leaves stale Nango connections behind. Keep
          // the most-recent un-scoped connection for this (user, provider) and
          // revoke the older dups — object-scoped (entity/project) connections are
          // preserved. Best-effort; never breaks the "connected" signal.
          try {
            const revoked = await connector.dedupeConnections(
              userId,
              match.uniqueKey
            );
            if (revoked.length > 0) {
              logger.info(
                { provider: match.uniqueKey, revoked: revoked.length },
                "connect: revoked stale duplicate connections"
              );
            }
          } catch (dedupErr) {
            logger.warn(
              { err: dedupErr, provider: match.uniqueKey },
              "connect: connection dedup failed (non-fatal)"
            );
          }
          return c.json(
            {
              status: "connected" as const,
              provider: match.uniqueKey,
              displayName: match.displayName,
              connectionId: existing.connectionId,
              unlocked,
            },
            200
          );
        }

        // ── Not connected → provider-specific OAuth session.
        // Nango can LIST an integration and still REJECT it at session time (a
        // declared-but-incomplete config), which pre-validation cannot catch —
        // so the throw is mapped here rather than escaping as a vendor 500.
        let session;
        try {
          session = await connector.createSession(
            userId,
            match.uniqueKey,
            workspaceId ?? ""
          );
        } catch (sessErr) {
          logger.warn(
            { err: sessErr, provider: match.uniqueKey, userId },
            "connect: Nango rejected a declared integration at session time"
          );
          return c.json(
            {
              status: "provider_unavailable" as const,
              provider: match.uniqueKey,
              displayName: match.displayName,
              code: "POD_PROVIDER_NOT_CONFIGURED" as const,
              reason: "malformed" as const,
              message: `"${match.displayName}" is declared on this pod's Nango but looks incomplete, so it can't be connected yet. A pod admin needs to finish configuring it in the Nango dashboard.`,
            },
            200
          );
        }
        return c.json(
          {
            status: "setup_required" as const,
            provider: match.uniqueKey,
            displayName: match.displayName,
            redirectUrl: session.redirectUrl,
            sessionToken: session.sessionToken,
          },
          200
        );
      } catch (err) {
        logger.error(
          { err, provider, userId },
          "POST /connectors/connect failed"
        );
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
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
      const connector = await resolveNangoConnector();
      if (!connector || !connector.isConfigured()) {
        return c.json({ error: "Nango not configured" }, 503);
      }
      const callerUserId = c.get("userId") as string;
      const { providerId, workspaceId, onBehalfOfUserId } = c.req.valid("json");

      // Resolve WHO the connection binds to — USER-scoped, not pod-scoped.
      // A connection belongs to the person, available on all their pods.
      // Default = the caller (operator for the bridge key).
      let userId = callerUserId;
      if (onBehalfOfUserId && onBehalfOfUserId !== callerUserId) {
        // ── SECURITY GATE (mirrors discord-identity.ts's link gate) ──────────
        const acting = await resolveActingContext(c, { workspaceId });
        if (!acting.ok) return c.json({ error: acting.error }, acting.status);
        // On-behalf-of binds to another WORKSPACE member, so a workspace is
        // required here (no pod-personal delegation).
        if (!acting.workspaceId) {
          return c.json(
            {
              error:
                "workspaceId is required to create a connection on behalf of another member",
            },
            400
          );
        }
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

      // No CP gateway here — the CP returns {token, connectLink, nangoHost}, not redirectUrl.

      // Pre-validate against what Nango actually declares. Falling back to the
      // generic picker is only correct when Nango ANSWERED and doesn't declare
      // the provider; a failed lookup must not be read as "doesn't exist".
      let effectiveProvider = providerId ?? "*";
      if (effectiveProvider !== "*") {
        const declared = await connector.listIntegrationsResult();
        if (declared.ok) {
          const exists = declared.integrations.some(
            (i) => i.uniqueKey === effectiveProvider
          );
          if (!exists) effectiveProvider = "*";
        }
      }

      let session;
      try {
        session = await connector.createSession(
          userId,
          effectiveProvider,
          workspaceId ?? ""
        );
      } catch (err) {
        logger.error({ err, providerId }, "POST /connectors/session failed");
        return c.json(
          {
            error:
              "Could not start a connection session with this pod's Nango. A pod admin needs to check that the integration is fully configured.",
          },
          500
        );
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
      const connector = await resolveNangoConnector();
      if (!connector || !connector.isConfigured()) {
        return c.json({ error: "Nango not configured" }, 503);
      }
      const { connectionId } = c.req.valid("param");
      try {
        await connector.revokeConnection(connectionId);
        // Self-heal: drop the connection-registry pointer rows + mark sourced
        // entities disconnected, so a revoke takes effect immediately.
        await detachNangoConnectionRegistry(connectionId);
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
      const connector = await resolveNangoConnector();
      if (!connector || !connector.isConfigured()) {
        return c.json({ error: "Nango not configured" }, 503);
      }
      const { connectionId, provider } = c.req.valid("json");
      try {
        // Pass the provider key on the hot path (CLI sends it) so the revoke
        // needs no extra Nango lookup; the door still self-resolves without it.
        await connector.revokeConnection(connectionId, provider);
        await detachNangoConnectionRegistry(connectionId);
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
      const connector = await resolveNangoConnector();
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
                   * Optional per-call proxy base-URL override (Nango
                   * `Base-Url-Override`). Lets one connection reach multiple API
                   * hosts — e.g. a `google` connection uses gmail.googleapis.com
                   * for Gmail but the provider default for Calendar/Drive.
                   */
                  baseUrlOverride: z.string().optional(),
                  /**
                   * Optional static custom request headers merged into the
                   * outbound request (e.g. Cal.com's `cal-api-version`). Spread
                   * FIRST in the dispatcher so auth + structural headers win.
                   */
                  headers: z.record(z.string(), z.string()).optional(),
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
        baseUrlOverride,
        headers,
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
          baseUrlOverride,
          headers,
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
        // (400 / 404 / 503). P1: carry the dispatcher's failure classification
        // (errorClass/providerRef, stamped at external-dispatch's single exit)
        // in the body so an in-skill callProvider failure can surface the
        // recovery chip — HubApiError.body preserves these across the IS hop.
        const code =
          result.status === 404 ? 404 : result.status === 503 ? 503 : 400;
        return c.json(
          {
            error: result.error ?? "Unknown error",
            ...(result.errorClass ? { errorClass: result.errorClass } : {}),
            ...(result.providerRef ? { providerRef: result.providerRef } : {}),
          },
          code
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
