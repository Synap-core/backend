/**
 * Hub Protocol REST — agent setup endpoint.
 *
 * Creates an agent user + Hub Protocol API key for external services
 * (e.g. OpenClaw). Mounted at POST /setup/agent and skip-listed from
 * the regular API-key auth middleware (it does its own auth here).
 */

import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";

import {
  db,
  sql,
  asc,
  eq,
  and,
  inArray,
  drizzleSql,
  apiKeyExternalUsers,
  workspaces,
  workspaceMembers,
  users,
  EventRepository,
  ApiKeyRepository,
  TrustedIssuerService,
  createWorkspaceFromDefinition,
  type ApiKeyScope,
} from "@synap/database";
import { getBoss } from "@synap/jobs";

import { apiKeyService } from "../../../services/api-keys.js";
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

import { logger, type HubHono } from "./_shared.js";

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
    let authMethod: "jwt" | "provisioning_token" | "api_key" =
      "provisioning_token";
    let jwtEmail: string | null = null;
    let jwtName: string | null = null;
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
                jwtEmail =
                  typeof payload.email === "string" ? payload.email : null;
                jwtName =
                  typeof payload.name === "string" ? payload.name : null;
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
        const keyOwner = await db.query.users.findFirst({
          where: (u, { eq }) => eq(u.id, keyRecord.userId),
          columns: { email: true, name: true },
        });
        jwtEmail = keyOwner?.email ?? null;
        jwtName = keyOwner?.name ?? null;
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
    const bodyDefinition: Record<string, unknown> | null =
      body.definition &&
      typeof body.definition === "object" &&
      !Array.isArray(body.definition)
        ? (body.definition as Record<string, unknown>)
        : null;

    const agentLabel = agentType.charAt(0).toUpperCase() + agentType.slice(1);

    try {
      // ── Find target workspace ───────────────────────────────────────────────
      // Priority: explicit id > agent-os package > any workspace on the pod.
      // The agent-os lookup is kept for backward-compat with OpenClaw installs
      // that seeded that workspace. Falling back to any workspace means Eve
      // and other self-hosted provisioners don't need a specific workspace
      // pre-created before provisioning can succeed.
      let ws = requestedWorkspaceId
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

      // If still no workspace exists, auto-seed one from the bundled template.
      if (!ws && !requestedWorkspaceId) {
        let ownerCandidate = await db.query.users.findFirst({
          where: (u, { eq }) => eq(u.userType, "human"),
          columns: { id: true, name: true },
        });

        // No human user on pod yet — create one so we can seed the workspace.
        if (!ownerCandidate) {
          // Use email from: CP JWT > ADMIN_EMAIL env > generated placeholder.
          // The placeholder lets a completely fresh pod bootstrap without any
          // env vars — the real user can be created later via normal sign-up,
          // and the workspace ownership transferred.
          const ownerEmail =
            jwtEmail ?? process.env.ADMIN_EMAIL ?? `admin@pod.local`;
          const ownerName =
            jwtName ?? (ownerEmail ? ownerEmail.split("@")[0] : "Pod Admin");

          const existingByEmail = await db.query.users.findFirst({
            where: (u, { eq }) => eq(u.email, ownerEmail),
            columns: { id: true, name: true },
          });

          if (existingByEmail) {
            ownerCandidate = existingByEmail;
            logger.info(
              { userId: existingByEmail.id, email: ownerEmail },
              "setup/agent: found existing user by email"
            );
          } else {
            const newUserId = randomUUID();
            await db.insert(users).values({
              id: newUserId,
              email: ownerEmail,
              name: ownerName,
              userType: "human",
              emailVerified: true,
              kratosIdentityId: null,
              timezone: "UTC",
              locale: "en",
            });
            ownerCandidate = { id: newUserId, name: ownerName };
            logger.info(
              {
                userId: newUserId,
                email: ownerEmail,
                source: jwtEmail
                  ? "cp-jwt"
                  : process.env.ADMIN_EMAIL
                    ? "admin-email-env"
                    : "placeholder",
              },
              "setup/agent: created human user"
            );
          }
        }

        if (ownerCandidate) {
          // 1) definition from CLI body  2) bundled file fallback (dist/ → ../../../ = repo root)
          let agentOsDefinition: Record<string, unknown> | null =
            bodyDefinition;
          if (!agentOsDefinition) {
            try {
              const templatePath = resolvePath(
                new URL(".", import.meta.url).pathname,
                "../../../templates/agent-os.json"
              );
              agentOsDefinition = JSON.parse(
                readFileSync(templatePath, "utf-8")
              );
            } catch {
              // Template not available — fall back to blank workspace below
            }
          }

          let newWsId: string;
          if (agentOsDefinition) {
            const result = await createWorkspaceFromDefinition({
              definition: agentOsDefinition as Parameters<
                typeof createWorkspaceFromDefinition
              >[0]["definition"],
              userId: ownerCandidate.id,
              packageSlug: "agent-os",
              workspaceName: "OpenClaw Agent OS",
              workspaceType: "personal",
              createdBy: "provisioning",
            });
            newWsId = result.workspaceId;
            logger.info(
              { workspaceId: newWsId, ownerId: ownerCandidate.id },
              "setup/agent: auto-seeded Agent OS workspace from template"
            );
          } else {
            // Fallback: plain blank workspace
            const [newWs] = await db
              .insert(workspaces)
              .values({
                name: ownerCandidate.name
                  ? `${ownerCandidate.name}'s Space`
                  : "My Space",
                type: "personal",
                ownerId: ownerCandidate.id,
                settings: {},
              })
              .returning();
            await db.insert(workspaceMembers).values({
              id: randomUUID(),
              workspaceId: newWs.id,
              userId: ownerCandidate.id,
              role: "owner",
            });
            newWsId = newWs.id;
            logger.info(
              { workspaceId: newWsId, ownerId: ownerCandidate.id },
              "setup/agent: auto-created blank workspace (template unavailable)"
            );
          }

          // Enqueue workspace-init to seed whiteboard, commands, relation defs, etc.
          try {
            const boss = getBoss();
            await boss.send("workspace-init", {
              workspaceId: newWsId,
              userId: ownerCandidate.id,
              packageSlug: "agent-os",
            });
          } catch (err) {
            logger.warn(
              { err, workspaceId: newWsId },
              "setup/agent: could not enqueue workspace-init (non-fatal)"
            );
          }

          ws = await db.query.workspaces.findFirst({
            where: (w, { eq }) => eq(w.id, newWsId),
          });
        }
      }

      if (!ws) {
        return c.json(
          {
            error: requestedWorkspaceId
              ? `Workspace ${requestedWorkspaceId} not found`
              : "No workspace exists on this pod and auto-creation failed. Set ADMIN_EMAIL in your pod .env and retry.",
          },
          404
        );
      }

      // ── Find workspace owner, repair if missing ─────────────────────────────
      const ownerMember = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, ws.id),
          eq(workspaceMembers.role, "owner")
        ),
        columns: { userId: true },
      });

      let ownerUserId = ownerMember?.userId ?? null;

      if (!ownerUserId) {
        const humanUser = await db.query.users.findFirst({
          where: (u, { eq }) => eq(u.userType, "human"),
          columns: { id: true },
        });
        if (humanUser) {
          const existingMembership = await db.query.workspaceMembers.findFirst({
            where: and(
              eq(workspaceMembers.userId, humanUser.id),
              eq(workspaceMembers.workspaceId, ws.id)
            ),
            columns: { id: true, role: true },
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
          ownerUserId = humanUser.id;
        }
      }

      // ── 1. Find or create the agent user (pod-wide singleton per agentType) ─
      const existingAgent = await db.query.users.findFirst({
        where: and(
          eq(users.userType, "agent"),
          drizzleSql`${users.agentMetadata}->>'agentType' = ${agentType}`
        ),
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
      }

      // ── 2. Grant workspace membership (idempotent) ──────────────────────────
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

      // ── 3. Create Hub Protocol API key ──────────────────────────────────────
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
          workspaceId: ws.id,
          agentType,
          authMethod,
          registration: registrationTrace,
        },
        "setup/agent: Hub API key created"
      );

      return c.json({
        agentUserId,
        workspaceId: ws.id,
        hubApiKey: plainKey,
        keyId: apiKey.id,
        registration: registrationTrace,
      });
    } catch (err) {
      logger.error({ err, agentType, flowId }, "setup/agent: failed");
      return c.json({ error: "Internal server error", flowId }, 500);
    }
  });

  // ── POST /setup/external-user ──────────────────────────────────────────────
  //
  // Provision a per-external-user mapping for a parent agent key.
  //
  // Auth: requires the caller's bearer to be a Hub API key with
  // `hub-protocol.write` scope (i.e. the parent agent key itself, or an
  // operator-managed key). The middleware in hub-protocol-rest.ts has already
  // authenticated the request and set c.userId / c.scopes by the time we
  // reach this handler.
  //
  // Body:
  //   externalUserId: string  (required)  — opaque ID from the upstream system
  //   name?: string                       — optional human-friendly name
  //   email?: string                      — optional email
  //   mintSubToken?: boolean              — Mode 2 (returns 501 for now)
  //
  // Response (200):
  //   { synapUserId, externalUserId, mapping: { id, parentKeyId, ... }, created }
  //
  // Mode 2 — returning 501 until the sub-token mint path is fully implemented.
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
}
