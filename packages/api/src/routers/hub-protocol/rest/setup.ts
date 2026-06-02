/**
 * Hub Protocol REST — agent setup endpoint.
 *
 * Creates an agent user + Hub Protocol API key for external services
 * (e.g. OpenClaw). Mounted at POST /setup/agent and skip-listed from
 * the regular API-key auth middleware (it does its own auth here).
 */

import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";

import {
  db,
  sql,
  asc,
  eq,
  and,
  inArray,
  isNull,
  count,
  drizzleSql,
  apiKeys,
  apiKeyExternalUsers,
  workspaces,
  workspaceMembers,
  invites,
  users,
  EventRepository,
  ApiKeyRepository,
  TrustedIssuerService,
  type ApiKeyScope,
} from "@synap/database";

import { apiKeyService } from "../../../services/api-keys.js";
import {
  createAdminUser,
  ensureUserRow,
} from "../../../scripts/create-admin-user.js";
import {
  isSubTokenFeatureEnabled,
  lookupExternalUserMapping,
  resolveExternalUserMapping,
} from "../../../services/external-user-mapping.js";
import { NotificationService } from "../../../notifications/NotificationService.js";
import { verifyCpJwt } from "../../../utils/jwks-client.js";
import {
  integrationHubIdFromIssuerUrl,
  revokeActiveHubInboundKeysForUser,
  SETUP_AGENT_HUB_SCOPES,
} from "../../../services/hub-integration-registration.js";
import {
  createAndVerifyHubInboundKey,
  toRegistrationTrace,
} from "../../../services/external-registration.js";

import { kratosAdmin } from "@synap/auth";
import { logger, type HubHono } from "./_shared.js";

const SURFACE_AGENT_TYPES = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "raycast",
  "codex",
  "openwebui",
  "generic",
] as const;

/** Check Kratos admin API for any identities. */
async function checkKratosIdentity(): Promise<boolean> {
  try {
    const { data: identities } = await kratosAdmin.listIdentities({
      pageSize: 1,
    });
    return Array.isArray(identities) && identities.length > 0;
  } catch {
    return false;
  }
}

/**
 * Probe the pod-admin invariant. Returns a structured result the operator
 * (or eve's post-update probe) can act on.
 *
 *   { healthy: true, … }            — pod-admin owner exists, all rows present.
 *   { healthy: false, kind: 'fresh' } — no users yet, install pre-bootstrap.
 *   { healthy: false, kind: 'broken_no_workspace' }   — users exist, no pod-admin workspace.
 *   { healthy: false, kind: 'broken_no_owner' }        — workspace exists, no owners.
 *   { healthy: false, kind: 'broken_orphan_member' }   — owner row points at missing user.
 */
async function computePodAdminInvariant(): Promise<{
  healthy: boolean;
  kind: string;
  reason: string;
}> {
  try {
    const podAdminWorkspace = await db.query.workspaces.findFirst({
      where: drizzleSql`${workspaces.settings}->>'systemSlug' = 'pod-admin'`,
      columns: { id: true },
    });

    if (!podAdminWorkspace) {
      const anyUser = await db.query.users.findFirst({
        columns: { id: true },
      });
      if (!anyUser) {
        return {
          healthy: false,
          kind: "fresh",
          reason: "no users yet — pre-bootstrap install",
        };
      }
      return {
        healthy: false,
        kind: "broken_no_workspace",
        reason: "users exist but no pod-admin system workspace",
      };
    }

    const owner = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
        inArray(workspaceMembers.role, ["owner", "admin"])
      ),
      columns: { userId: true },
    });

    if (!owner) {
      return {
        healthy: false,
        kind: "broken_no_owner",
        reason: `pod-admin workspace ${podAdminWorkspace.id} has no owner/admin`,
      };
    }

    const userRow = await db.query.users.findFirst({
      where: eq(users.id, owner.userId),
      columns: { id: true, email: true },
    });

    if (!userRow) {
      return {
        healthy: false,
        kind: "broken_orphan_member",
        reason: `pod-admin owner ${owner.userId} has no users row`,
      };
    }

    return {
      healthy: true,
      kind: "ok",
      reason: `pod-admin owned by ${userRow.email}`,
    };
  } catch (err) {
    return {
      healthy: false,
      kind: "probe_failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerSetupRoutes(app: HubHono): void {
  app.post("/setup/agent", async (c) => {
    const flowId = randomUUID();
    // ── Auth: CP JWT (preferred) or PROVISIONING_TOKEN (self-hosted fallback) ──
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

    if (!token) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    let authenticated = false;
    let authMethod:
      | "jwt"
      | "provisioning_token"
      | "api_key"
      | "api_key_surface" = "provisioning_token";
    let jwtIssuerUrl: string | null = null;

    // Try 1: CP-signed JWT verified against Trusted Issuers registry
    const adminUrl = `${process.env.PUBLIC_URL ?? ""}/admin/trusted-issuers`;
    try {
      const decoded = jwt.decode(token);
      if (decoded && typeof decoded === "object") {
        const iss = (decoded as Record<string, unknown>).iss;
        if (typeof iss === "string" && iss.startsWith("https://")) {
          const issuerSvc = new TrustedIssuerService();
          let issuer = await issuerSvc.getByUrl(iss);

          if (!issuer) {
            // Unknown issuer — register as pending and ask admin to approve
            const derivedDisplayName = new URL(iss).hostname;
            issuer = await issuerSvc.registerPending(
              iss,
              derivedDisplayName,
              decoded
            );
            try {
              const podAdminWorkspace = await db.query.workspaces.findFirst({
                where: drizzleSql`${workspaces.settings}->>'systemSlug' = 'pod-admin'`,
                columns: { id: true },
              });
              if (podAdminWorkspace) {
                const admins = await db.query.workspaceMembers.findMany({
                  where: and(
                    eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
                    inArray(workspaceMembers.role, ["admin", "owner"])
                  ),
                  columns: { userId: true },
                });
                for (const admin of admins) {
                  await NotificationService.create({
                    type: "system.issuer_pending_approval",
                    workspaceId: podAdminWorkspace.id,
                    userId: admin.userId,
                    sourceType: "system",
                    sourceId: issuer.id,
                    data: {
                      issuerUrl: iss,
                      displayName: derivedDisplayName,
                    },
                  });
                }
              }
            } catch (notifyErr) {
              logger.warn(
                { err: notifyErr, issuerUrl: iss },
                "setup/agent: failed to notify admins about pending issuer"
              );
            }
            logger.warn(
              { issuerUrl: iss, adminUrl },
              "setup/agent: unknown JWT issuer registered as pending — admin approval required"
            );
            return c.json(
              { code: "ISSUER_PENDING_APPROVAL", adminUrl, issuerUrl: iss },
              202
            );
          }

          if (issuer.status === "pending") {
            return c.json(
              { code: "ISSUER_PENDING_APPROVAL", adminUrl, issuerUrl: iss },
              202
            );
          }

          if (issuer.status === "rejected" || issuer.status === "revoked") {
            return c.json(
              { error: "This issuer is not authorized on this pod." },
              403
            );
          }

          if (issuer.status === "approved") {
            if (!issuer.allowedScopes.includes("setup.agent")) {
              return c.json(
                { error: "This issuer is not authorized on this pod." },
                403
              );
            }

            try {
              const payload = await verifyCpJwt<{
                type: string;
                email?: string;
                name?: string;
              }>(token, iss);
              if (
                payload &&
                (payload.type === "agent_setup" ||
                  payload.type === "addon_activate")
              ) {
                authenticated = true;
                authMethod = "jwt";
                jwtIssuerUrl = iss;
              }
            } catch {
              // JWT verification failed — fall through to other auth methods
            }
          }
        }
      }
    } catch {
      // Not a valid JWT or issuer lookup failed — fall through
    }

    // Try 2: PROVISIONING_TOKEN (self-hosted pods — env var known only to operator)
    if (!authenticated) {
      const provisioningToken = process.env.PROVISIONING_TOKEN;
      if (provisioningToken && token === provisioningToken) {
        authenticated = true;
        authMethod = "provisioning_token";
      }
    }

    // Try 3: Hub Protocol API key with `setup.agent` scope.
    if (!authenticated) {
      const keyRecord = await apiKeyService.validateApiKey(token);
      if (keyRecord?.isActive && keyRecord.scope.includes("setup.agent")) {
        authenticated = true;
        authMethod = "api_key";
      }
    }

    // Path 4: any hub-protocol.write key (human-owned) can self-provision a surface agent type
    let surfaceAgentLinkedUserId: string | undefined;
    if (!authenticated) {
      const keyRecord = await apiKeyService.validateApiKey(token);
      if (
        keyRecord?.isActive &&
        keyRecord.scope.includes("hub-protocol.write")
      ) {
        authenticated = true;
        authMethod = "api_key_surface";
        surfaceAgentLinkedUserId = keyRecord.userId;
      }
    }

    if (!authenticated) {
      return c.json(
        {
          error:
            "Invalid credentials. Accepted: CP-signed JWT, PROVISIONING_TOKEN, or a Hub API key with `setup.agent` scope.",
        },
        401
      );
    }

    logger.info({ authMethod }, "setup/agent: authenticated");

    // ── Parse body ──────────────────────────────────────────────────────────────
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const agentType: string =
      typeof body.agentType === "string" ? body.agentType : "openclaw";
    const requestedWorkspaceId: string | undefined =
      typeof body.workspaceId === "string" ? body.workspaceId : undefined;
    const linkedUserId: string | undefined =
      typeof body.linkedUserId === "string" && body.linkedUserId.trim()
        ? body.linkedUserId.trim()
        : undefined;

    if (authMethod === "api_key_surface") {
      if (!(SURFACE_AGENT_TYPES as readonly string[]).includes(agentType)) {
        return c.json(
          {
            error: "Surface key provisioning only supports surface agent types",
          },
          400
        );
      }
    }

    const agentLabel = agentType.charAt(0).toUpperCase() + agentType.slice(1);

    try {
      // ── Auto-resolve linkedUserId: find the pod owner when not explicit ───────
      // When linkedUserId is not passed in the body, default to the first human
      // user on the pod. This means all agent keys are automatically attributed
      // to the pod owner — memory dual-writes then appear in the owner's timeline
      // without the lifecycle needing to fetch the userId separately.
      // Explicit body.linkedUserId overrides this (passed as "" to opt out).
      let resolvedLinkedUserId: string | undefined = linkedUserId;
      if (authMethod === "api_key_surface") {
        resolvedLinkedUserId = surfaceAgentLinkedUserId;
      } else if (resolvedLinkedUserId === undefined) {
        const humanUser = await db.query.users.findFirst({
          where: (u, { eq: eqFn }) => eqFn(u.userType, "human"),
          columns: { id: true },
        });
        if (humanUser) resolvedLinkedUserId = humanUser.id;
      }

      // ── Find target workspace (optional — agent exists at pod level) ─────────
      // Workspace is NOT required for provisioning. The agent user and API key
      // are pod-wide resources. Workspace membership is granted opportunistically
      // when a workspace already exists; if none does, provisioning still succeeds.
      //
      // Priority: explicit id > agent-os package > any workspace on the pod.
      const ws = requestedWorkspaceId
        ? await db.query.workspaces.findFirst({
            where: (w, { eq }) => eq(w.id, requestedWorkspaceId),
          })
        : ((await db.query.workspaces.findFirst({
            where: drizzleSql`${workspaces.settings}->>'packageSlug' = 'agent-os'`,
            orderBy: (w) => asc(w.createdAt),
          })) ??
          (await db.query.workspaces.findFirst({
            orderBy: (w) => asc(w.createdAt),
          })));

      if (requestedWorkspaceId && !ws) {
        return c.json(
          { error: `Workspace ${requestedWorkspaceId} not found` },
          404
        );
      }

      // ── Find pod owner (any human user) ────────────────────────────────────
      // Used to attribute the agent user and, when a workspace exists, to repair
      // missing workspace membership.
      let ownerUserId: string | null = null;

      if (ws) {
        const ownerMember = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, ws.id),
            eq(workspaceMembers.role, "owner")
          ),
          columns: { userId: true },
        });
        ownerUserId = ownerMember?.userId ?? null;
      }

      if (!ownerUserId) {
        const humanUser = await db.query.users.findFirst({
          where: (u, { eq }) => eq(u.userType, "human"),
          columns: { id: true },
        });
        if (humanUser) {
          ownerUserId = humanUser.id;
          // Self-repair: ensure the human user is a member of the workspace.
          if (ws) {
            const existingMembership =
              await db.query.workspaceMembers.findFirst({
                where: and(
                  eq(workspaceMembers.userId, humanUser.id),
                  eq(workspaceMembers.workspaceId, ws.id)
                ),
                columns: { id: true },
              });
            if (!existingMembership) {
              await db.insert(workspaceMembers).values({
                id: randomUUID(),
                workspaceId: ws.id,
                userId: humanUser.id,
                role: "owner",
              });
              logger.info(
                { workspaceId: ws.id, userId: humanUser.id },
                "setup/agent: assigned human user as workspace owner (self-repair)"
              );
            }
          }
        }
      }

      // ── 1. Find or create the agent user (pod-wide singleton per agentType) ─
      // Deterministic: if a provisioning race ever produced more than one row for
      // this agentType, always reuse the OLDEST so the singleton is stable and the
      // dedup never flip-flops between rows across calls.
      const existingAgent = await db.query.users.findFirst({
        where: and(
          eq(users.userType, "agent"),
          drizzleSql`${users.agentMetadata}->>'agentType' = ${agentType}`
        ),
        orderBy: (u, { asc }) => [asc(u.createdAt)],
        columns: { id: true },
      });

      let agentUserId: string;

      if (existingAgent) {
        agentUserId = existingAgent.id;
        logger.info(
          { agentUserId, agentType },
          "setup/agent: reusing existing agent user"
        );
      } else {
        agentUserId = randomUUID();
        const shortId = agentUserId.slice(0, 8);
        try {
          await db.insert(users).values({
            id: agentUserId,
            email: `agent-${agentType}-${shortId}@synap.agent`,
            name: agentLabel,
            emailVerified: true,
            userType: "agent",
            kratosIdentityId: null,
            agentMetadata: {
              agentType,
              description: `${agentLabel} — external agent (${authMethod === "jwt" ? "CP-managed" : "self-hosted"} setup)`,
              createdByUserId: ownerUserId ?? agentUserId,
              isPersonalAgent: false,
              writesRequireProposal: true,
              capabilities: [],
            },
            timezone: "UTC",
            locale: "en",
          });
          logger.info(
            { agentUserId, agentType },
            "setup/agent: created agent user"
          );
        } catch (err) {
          // DB firewall: a partial unique index on (agentType) for service agents
          // rejects a concurrent insert. Re-resolve the winning singleton and reuse
          // it. If nothing matches, the error wasn't a dedup race — re-throw.
          const raced = await db.query.users.findFirst({
            where: and(
              eq(users.userType, "agent"),
              drizzleSql`${users.agentMetadata}->>'agentType' = ${agentType}`
            ),
            orderBy: (u, { asc }) => [asc(u.createdAt)],
            columns: { id: true },
          });
          if (!raced) throw err;
          agentUserId = raced.id;
          logger.info(
            { agentUserId, agentType },
            "setup/agent: lost provision race — reusing existing agent user"
          );
        }
      }

      // ── 2. Grant workspace membership (opportunistic — skipped if no workspace) ─
      if (ws) {
        const existingMembership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.userId, agentUserId),
            eq(workspaceMembers.workspaceId, ws.id)
          ),
          columns: { id: true },
        });

        if (!existingMembership) {
          await db.insert(workspaceMembers).values({
            id: randomUUID(),
            workspaceId: ws.id,
            userId: agentUserId,
            role: "editor",
            invitedBy: ownerUserId ?? undefined,
          });
          logger.info(
            { agentUserId, workspaceId: ws.id },
            "setup/agent: workspace membership granted"
          );
        }
      }

      // ── 3. Create Hub Protocol API key ──────────────────────────────────────
      // Idempotent path: when the caller passes `idempotent: true`, skip
      // revocation and re-mint if a valid (non-revoked) key already exists.
      // This is used by Eve's workspace-membership repair so it can add the
      // agent to the workspace without rotating a healthy key on every update.
      if (body.idempotent === true) {
        const existingKey = await db.query.apiKeys.findFirst({
          where: and(
            eq(apiKeys.userId, agentUserId),
            eq(apiKeys.keyType, "hub_inbound"),
            isNull(apiKeys.revokedAt)
          ),
          columns: { id: true },
        });
        if (existingKey) {
          logger.info(
            { agentUserId, agentType, keyId: existingKey.id },
            "setup/agent: idempotent — valid key exists, skipping revoke+mint"
          );
          return c.json({
            agentUserId,
            workspaceId: ws?.id ?? null,
            alreadyValid: true,
          });
        }
      }

      await revokeActiveHubInboundKeysForUser(db, {
        userId: agentUserId,
        revokedBy: agentUserId,
        revokedReason: "Re-provisioning — replaced by new key via setup/agent",
      });

      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(db, eventRepo);
      const registration = await createAndVerifyHubInboundKey(
        apiKeyRepo,
        {
          keyName: `${agentLabel} Hub Key`,
          hubId: jwtIssuerUrl
            ? integrationHubIdFromIssuerUrl(jwtIssuerUrl)
            : undefined,
          scope: [...SETUP_AGENT_HUB_SCOPES],
          userId: agentUserId,
          keyType: "hub_inbound",
          description: `Hub Protocol auth token for ${agentLabel} agent — created via ${authMethod === "jwt" ? "CP-managed" : "self-hosted"} setup`,
          linkedUserId: resolvedLinkedUserId ?? null,
        },
        agentUserId,
        agentUserId
      );
      const registrationTrace = toRegistrationTrace(flowId, registration);
      const { apiKey, plainKey } = registration;
      if (registration.outcome !== "CONNECTED_VERIFIED") {
        logger.error(
          {
            flowId,
            agentUserId,
            agentType,
            authMethod,
            verificationError: registration.verificationError,
          },
          "setup/agent: key minted but verification failed"
        );
        return c.json(
          {
            error: "Key minted but verification failed",
            code: "KEY_MINTED_BUT_VERIFICATION_FAILED",
            registration: registrationTrace,
          },
          500
        );
      }

      logger.info(
        {
          agentUserId,
          keyId: apiKey.id,
          workspaceId: ws?.id ?? null,
          agentType,
          authMethod,
          registration: registrationTrace,
        },
        "setup/agent: Hub API key created"
      );

      return c.json({
        agentUserId,
        workspaceId: ws?.id ?? null,
        hubApiKey: plainKey,
        keyId: apiKey.id,
        registration: registrationTrace,
      });
    } catch (err) {
      logger.error({ err, agentType, flowId }, "setup/agent: failed");
      return c.json({ error: "Internal server error", flowId }, 500);
    }
  });

  /**
   * Provision an external-service user identity against a parent Hub API key.
   *
   * Mode 1 (header-based): Just call this to pre-provision the mapping.
   *   External service sends X-External-User-Id header on each request.
   *
   * Mode 2 (sub-token): Pass mintSubToken: true.
   *   Returns a one-time plaintext token. Store it per external user.
   *   Use that token directly for all subsequent API calls — no header needed.
   *
   * Idempotent: same (parentKeyId, externalUserId) always returns the same mapping.
   * The token is only returned in plaintext on first mint; subsequent calls return
   * the mapping ID only (retrieve the token from your own storage).
   */
  app.post("/setup/external-user", async (c) => {
    if (!isSubTokenFeatureEnabled()) {
      return c.json(
        {
          error:
            "Per-user sub-token system is disabled on this pod. Set HUB_PROTOCOL_SUB_TOKENS=true to enable.",
        },
        404
      );
    }

    const scopes = (c.get("scopes") as string[] | undefined) ?? [];
    if (
      !scopes.includes("hub-protocol.write") &&
      !scopes.includes("hub-protocol.admin")
    ) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    // We need the parent key ID. The middleware only stashes `parentKeyId`
    // when an X-External-User-Id header was forwarded — for the bare
    // /setup/external-user call there's no header, so we recover the parent
    // key ID from the bearer directly. Re-validating the token here is cheap
    // (bcrypt compare is cached at the OS level for a hot key) and keeps the
    // route self-contained.
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;
    if (!token) {
      return c.json({ error: "Missing bearer token" }, 401);
    }
    const keyRecord = await apiKeyService.validateApiKey(token);
    if (!keyRecord || !keyRecord.isActive) {
      return c.json({ error: "Invalid or inactive API key" }, 401);
    }
    // Prevent grandchild token minting: sub-tokens (depth≥1) cannot mint further sub-tokens.
    if (keyRecord.parentKeyId !== null && keyRecord.parentKeyId !== undefined) {
      return c.json(
        {
          error:
            "Sub-tokens cannot mint child tokens. Use the root API key to provision external users.",
        },
        403
      );
    }
    const effectiveParentKeyId = keyRecord.id;

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const externalUserId =
      typeof body.externalUserId === "string" ? body.externalUserId.trim() : "";
    if (!externalUserId) {
      return c.json({ error: "externalUserId is required" }, 400);
    }

    const wantsSubToken = body.mintSubToken === true;

    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : undefined;
    const email =
      typeof body.email === "string" && body.email.trim()
        ? body.email.trim()
        : undefined;
    // Optional caller-supplied narrower scopes (least-privilege). When
    // omitted, the child inherits the parent's scopes verbatim.
    const requestedScopesRaw = Array.isArray(body.scopes) ? body.scopes : [];
    const requestedScopes = requestedScopesRaw.filter(
      (s: unknown): s is ApiKeyScope => typeof s === "string"
    ) as ApiKeyScope[];

    // ── Mode 2 — mint a real child API key bound to (parent, external user).
    if (wantsSubToken) {
      // 1. Resolve / create the mapping FIRST so we have a synapUserId to
      //    bind the child key to. The mapping row is the canonical link
      //    between the parent and the external user; the child key just
      //    rides on top of it.
      const mapping = await resolveExternalUserMapping(
        effectiveParentKeyId,
        externalUserId,
        {
          parentOwnerUserId: keyRecord.userId,
          source: "setup/external-user",
          displayName: name,
          email,
        }
      );

      if (!mapping) {
        return c.json(
          { error: "Failed to resolve external user mapping" },
          500
        );
      }

      // 2. Idempotent re-mint: if the mapping already has a child key,
      //    return its id WITHOUT a fresh plaintext. The plaintext is
      //    one-shot and only ever returned on first mint — caller is
      //    responsible for persisting it then. Returning `reused: true`
      //    so the caller knows not to expect a `subToken` field.
      const existingMapping = await lookupExternalUserMapping(
        effectiveParentKeyId,
        externalUserId
      );
      if (existingMapping?.childApiKeyId) {
        return c.json({
          synapUserId: mapping.synapUserId,
          externalUserId,
          mappingId: mapping.mappingId,
          subTokenId: existingMapping.childApiKeyId,
          reused: true,
          warning:
            "A sub-token was already minted for this mapping. Plaintext is " +
            "only returned on first mint — if it was lost, revoke the existing " +
            "child key (DELETE on api_keys) and re-call this endpoint.",
        });
      }

      // 3. Mint the child key. Inherits parent's scopes by default, or the
      //    caller can request narrower scopes for least-privilege. Wider
      //    scopes than the parent are rejected by generateApiKey().
      let child: { key: string; keyId: string };
      try {
        child = await apiKeyService.generateApiKey(
          mapping.synapUserId,
          `external:${externalUserId}`,
          requestedScopes, // empty array → inherit parent's scopes
          undefined, // hubId inherited from parent inside generateApiKey
          undefined, // expiresInDays — children expire when the parent does (cascade)
          effectiveParentKeyId
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        // Most likely cause: caller asked for scopes wider than parent.
        // Rest of the surface is auth/active-state which we already
        // guarded above — surface the message verbatim, it's safe.
        return c.json({ error: `Sub-token mint failed: ${msg}` }, 400);
      }

      // 4. Link the child key id back onto the mapping row so future
      //    /setup/external-user calls hit the idempotent path above.
      await db
        .update(apiKeyExternalUsers)
        .set({ childApiKeyId: child.keyId })
        .where(eq(apiKeyExternalUsers.id, mapping.mappingId));

      // 5. Return the plaintext ONCE. Caller MUST persist it now — it
      //    cannot be recovered later.
      return c.json({
        synapUserId: mapping.synapUserId,
        externalUserId,
        mappingId: mapping.mappingId,
        subTokenId: child.keyId,
        subToken: child.key,
        reused: false,
        created: mapping.created,
        warning:
          "Plaintext sub-token is returned ONCE. Store it securely now — it " +
          "cannot be retrieved later. Subsequent calls return only the id.",
      });
    }

    // ── Mode 1 (header-based remap) — just provision the mapping ───────────

    // Idempotent: if a mapping already exists, return it.
    const existing = await lookupExternalUserMapping(
      effectiveParentKeyId,
      externalUserId
    );
    if (existing) {
      return c.json({
        synapUserId: existing.synapUserId,
        externalUserId: existing.externalUserId,
        created: false,
        mapping: {
          id: existing.id,
          parentKeyId: existing.parentApiKeyId,
          childApiKeyId: existing.childApiKeyId,
          createdAt: existing.createdAt,
        },
      });
    }

    const mapping = await resolveExternalUserMapping(
      effectiveParentKeyId,
      externalUserId,
      {
        parentOwnerUserId: keyRecord.userId,
        source: "setup/external-user",
        displayName: name,
        email,
      }
    );

    if (!mapping) {
      return c.json(
        { error: "Failed to provision external user mapping" },
        500
      );
    }

    return c.json({
      synapUserId: mapping.synapUserId,
      externalUserId,
      created: mapping.created,
      mapping: {
        id: mapping.mappingId,
        parentKeyId: effectiveParentKeyId,
        childApiKeyId: null,
      },
    });
  });

  // ── GET /setup/status ──────────────────────────────────────────────────────
  //
  // No auth required — safe to expose so the CLI and setup page can detect
  // whether the pod has been bootstrapped yet.
  app.get("/setup/status", async (c) => {
    try {
      // Primary check: Kratos identities (source of truth for auth).
      const kratosHasIdentity = await checkKratosIdentity();

      const [humanResult] = await db
        .select({ count: count() })
        .from(users)
        .where(eq(users.userType, "human"));
      const [wsResult] = await db.select({ count: count() }).from(workspaces);

      const humanCount = Number(humanResult?.count ?? 0);
      const workspaceCount = Number(wsResult?.count ?? 0);

      // Pod-admin invariant — true when there exists a pod-admin system
      // workspace AND at least one owner/admin member with a backing users
      // row. Distinct from `needsSetup`: a pod can have Kratos identities
      // and synap users but a broken pod-admin invariant (e.g. partial
      // wipe), in which case `/admin/*` surfaces 403 even though sign-in
      // works. Eve's post-update probe reads this to surface a recovery
      // command.
      const invariant = await computePodAdminInvariant();

      return c.json({
        hasAdmin: kratosHasIdentity || humanCount > 0,
        workspaceCount,
        needsSetup: !kratosHasIdentity && humanCount === 0,
        podAdminInvariant: invariant,
      });
    } catch (err) {
      logger.error({ err }, "setup/status: failed");
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ── POST /setup/magic-link ─────────────────────────────────────────────────
  //
  // Auth: PROVISIONING_TOKEN only.
  // Generates a short-lived JWT the operator pastes into their browser.
  // Guard: if a human user already exists → 409.
  app.post("/setup/magic-link", async (c) => {
    // Auth
    const provisioningToken = process.env.PROVISIONING_TOKEN;
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;
    if (!token || !provisioningToken || token !== provisioningToken) {
      return c.json(
        { error: "Unauthorized — PROVISIONING_TOKEN required" },
        401
      );
    }

    // Guard: already has admin? (check Kratos first, then Synap DB fallback)
    const kratosHasIdentity = await checkKratosIdentity();
    const dbHasHuman = Number(
      (
        await db
          .select({ count: count() })
          .from(users)
          .where(eq(users.userType, "human"))
      )?.[0]?.count ?? 0
    );
    if (kratosHasIdentity || dbHasHuman > 0) {
      return c.json({ error: "Admin already exists" }, 409);
    }

    const magicToken = jwt.sign(
      { purpose: "first_admin_setup" },
      provisioningToken,
      { expiresIn: "1h" }
    );

    const publicUrl = process.env.PUBLIC_URL ?? "";
    const url = `${publicUrl}/setup?token=${magicToken}`;
    return c.json({ token: magicToken, url });
  });

  // ── POST /setup/first-admin ────────────────────────────────────────────────
  //
  // Auth: PROVISIONING_TOKEN in header OR magicToken in body.
  // Body: { email, password, name?, magicToken? }
  // Guard: if human users already exist → 409.
  app.post("/setup/first-admin", async (c) => {
    const provisioningToken = process.env.PROVISIONING_TOKEN;

    // Parse body first
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : email.split("@")[0];
    const magicToken =
      typeof body.magicToken === "string" ? body.magicToken : null;

    if (!email || !password) {
      return c.json({ error: "email and password are required" }, 400);
    }

    // Auth: magic token OR PROVISIONING_TOKEN header
    let authenticated = false;

    if (magicToken) {
      if (!provisioningToken) {
        return c.json(
          { error: "PROVISIONING_TOKEN not configured on pod" },
          500
        );
      }
      try {
        const decoded = jwt.verify(magicToken, provisioningToken) as Record<
          string,
          unknown
        >;
        if (decoded.purpose === "first_admin_setup") {
          authenticated = true;
        }
      } catch {
        return c.json({ error: "Invalid or expired magic token" }, 401);
      }
    } else {
      const authHeader = c.req.header("authorization") ?? "";
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : null;
      if (token && provisioningToken && token === provisioningToken) {
        authenticated = true;
      }
    }

    if (!authenticated) {
      return c.json(
        {
          error:
            "Unauthorized — PROVISIONING_TOKEN or valid magic token required",
        },
        401
      );
    }

    // Guard: admin already exists? (check Kratos first, then Synap DB fallback)
    const kratosHasIdentity = await checkKratosIdentity();
    const dbHasHuman = Number(
      (
        await db
          .select({ count: count() })
          .from(users)
          .where(eq(users.userType, "human"))
      )?.[0]?.count ?? 0
    );
    if (kratosHasIdentity || dbHasHuman > 0) {
      return c.json({ error: "Admin already exists" }, 409);
    }

    try {
      const result = await createAdminUser(email, password, name, {
        createWorkspace: true,
      });

      logger.info(
        { userId: result.userId, workspaceId: result.workspaceId, email },
        "setup/first-admin: first human admin created"
      );

      return c.json({
        userId: result.userId,
        workspaceId: result.workspaceId,
        email,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, email }, "setup/first-admin: createAdminUser failed");
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        return c.json({ error: "Admin user already exists" }, 409);
      }
      return c.json(
        { error: "Failed to create admin user", detail: msg.slice(0, 200) },
        500
      );
    }
  });

  // ── POST /setup/accept-invite ──────────────────────────────────────────────
  //
  // Public endpoint — no auth required. Validates an invite token, creates a
  // Kratos identity + users row for the invitee, accepts the invite (adds
  // workspace membership), and deletes the used token.
  //
  // On success the caller should redirect to /login so the user can sign in.
  app.post("/setup/accept-invite", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : email.split("@")[0];
    const inviteToken =
      typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";

    if (!email || !password || !inviteToken) {
      return c.json(
        { error: "email, password, and inviteToken are required" },
        400
      );
    }
    if (password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }

    const invite = await db.query.invites.findFirst({
      where: eq(invites.token, inviteToken),
    });
    if (!invite)
      return c.json({ error: "Invite not found or already used" }, 404);
    if (invite.expiresAt < new Date())
      return c.json({ error: "Invite has expired" }, 410);
    if (invite.email && invite.email.toLowerCase() !== email) {
      return c.json(
        { error: "This invite was sent to a different email address" },
        403
      );
    }

    // Create Kratos identity. On 409, tell the user to sign in — do NOT reuse
    // an existing identity as that would let an attacker accept an invite on
    // behalf of a user who owns that email.
    let identityId: string;
    try {
      const { data: identity } = await kratosAdmin.createIdentity({
        createIdentityBody: {
          schema_id: "default",
          traits: { email, name },
          credentials: { password: { config: { password } } },
          verifiable_addresses: [
            { value: email, verified: true, via: "email", status: "completed" },
          ],
        },
      });
      identityId = identity.id;
      logger.info(
        { identityId, email },
        "accept-invite: Kratos identity created"
      );
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 409) {
        // Identity already exists. Two stale cases we can safely clean up:
        //   A) users row exists + no workspace memberships (removed without cleanup)
        //   B) orphaned Kratos identity with no users row at all
        // Active accounts (has memberships) keep the security guard.
        const existingUser = await db.query.users.findFirst({
          where: eq(users.email, email),
          columns: { id: true },
        });

        let kratosIdentityId: string | null = existingUser?.id ?? null;

        if (!existingUser) {
          // Orphaned identity — look it up in Kratos directly.
          const { data: matches } = await kratosAdmin.listIdentities({
            credentialsIdentifier: email,
            pageSize: 1,
          });
          kratosIdentityId = matches?.[0]?.id ?? null;
        }

        const hasActiveMembership =
          existingUser &&
          !!(await db.query.workspaceMembers.findFirst({
            where: eq(workspaceMembers.userId, existingUser.id),
            columns: { workspaceId: true },
          }));

        const isStale = kratosIdentityId && !hasActiveMembership;

        if (isStale) {
          try {
            await kratosAdmin.deleteIdentity({ id: kratosIdentityId! });
            if (existingUser) {
              await db.delete(users).where(eq(users.id, existingUser.id));
            }
          } catch (cleanupErr) {
            logger.warn(
              { cleanupErr, email },
              "accept-invite: stale identity cleanup failed"
            );
            return c.json({ error: "Failed to clean up stale account" }, 500);
          }
          // Retry identity creation with the new credentials.
          try {
            const { data: identity } = await kratosAdmin.createIdentity({
              createIdentityBody: {
                schema_id: "default",
                traits: { email, name },
                credentials: { password: { config: { password } } },
                verifiable_addresses: [
                  {
                    value: email,
                    verified: true,
                    via: "email",
                    status: "completed",
                  },
                ],
              },
            });
            identityId = identity.id;
            logger.info(
              { identityId, email },
              "accept-invite: stale identity replaced"
            );
          } catch (retryErr) {
            const msg =
              retryErr instanceof Error ? retryErr.message : String(retryErr);
            logger.error(
              { retryErr, email },
              "accept-invite: createIdentity retry failed"
            );
            return c.json(
              { error: "Failed to create account", detail: msg.slice(0, 200) },
              500
            );
          }
        } else {
          return c.json(
            {
              error:
                "An account with this email already exists. Use the Sign in tab to accept the invite.",
            },
            409
          );
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, email }, "accept-invite: createIdentity failed");
        return c.json(
          { error: "Failed to create account", detail: msg.slice(0, 200) },
          500
        );
      }
    }

    await ensureUserRow(identityId, email, name);

    // Accept invite: add workspace membership (workspace or all-pod).
    if (invite.type === "workspace" && invite.workspaceId) {
      const alreadyMember = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, invite.workspaceId),
          eq(workspaceMembers.userId, identityId)
        ),
      });
      if (!alreadyMember) {
        await db.insert(workspaceMembers).values({
          workspaceId: invite.workspaceId,
          userId: identityId,
          role: invite.role as "owner" | "editor" | "viewer",
        });
      }
    } else {
      const allWorkspaces = await db.query.workspaces.findMany({
        columns: { id: true },
      });
      for (const ws of allWorkspaces) {
        const alreadyMember = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, ws.id),
            eq(workspaceMembers.userId, identityId)
          ),
        });
        if (!alreadyMember) {
          await db.insert(workspaceMembers).values({
            workspaceId: ws.id,
            userId: identityId,
            role: invite.role as "owner" | "editor" | "viewer",
          });
        }
      }
    }

    await db.delete(invites).where(eq(invites.id, invite.id));
    logger.info(
      { identityId, email, inviteId: invite.id },
      "accept-invite: account created and invite accepted"
    );

    return c.json({ userId: identityId, success: true });
  });
}
