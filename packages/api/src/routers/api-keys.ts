/**
 * API Keys Router
 *
 * Synchronous CRUD with inline permission checks and bcrypt hashing.
 * SECURITY: Keys are displayed ONCE and never stored in plaintext.
 */

import {
  router,
  protectedProcedure,
  podAdminProcedure,
  workspaceProcedure,
} from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { integrationKindSchema } from "@synap-core/types";
import { API_KEY_SCOPES } from "@synap/database/schema";
import {
  db,
  and,
  eq,
  asc,
  inArray,
  getDb,
  EventRepository,
  ApiKeyRepository,
  sql,
} from "@synap/database";
import {
  apiKeys,
  workspaceMembers,
  mcpConnectCodes,
  users,
} from "@synap/database/schema";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/events";
import { randomUUID, randomBytes, createHash } from "crypto";
import {
  INTEGRATION_HUB_SCOPES,
  integrationHubId,
} from "../services/hub-integration-registration.js";
import { createAndVerifyHubInboundKey } from "../services/external-registration.js";
import { toRegistrationTrace } from "../services/external-registration.js";
import {
  AuthorizeUserError,
  decideOAuthAuthorization,
  getOAuthConsentContext,
} from "./oauth/consent.js";
import { OAuthError } from "./oauth/protocol.js";

/**
 * The authorize parameters pod-admin's consent screen round-trips.
 *
 * Bounded lengths only — the SEMANTIC validation (does this client exist? is
 * this redirect_uri registered to it? is the challenge a well-formed S256
 * value?) deliberately lives in `oauth/consent.ts`, which re-derives everything
 * from the stored client. Duplicating those rules here as Zod refinements would
 * create a second place for them to drift.
 */
const oauthAuthorizeParamsSchema = z.object({
  clientId: z.string().min(1).max(200),
  redirectUri: z.string().min(1).max(2048),
  responseType: z.string().max(64).optional(),
  scope: z.string().max(1024).optional(),
  state: z.string().max(2048).optional(),
  codeChallenge: z.string().max(256).optional(),
  codeChallengeMethod: z.string().max(64).optional(),
});

/**
 * Map an OAuth-layer failure to a tRPC error the consent screen can render.
 *
 * `AuthorizeUserError` means the request itself is unusable (unknown client,
 * unregistered redirect_uri, non-human caller) — BAD_REQUEST. `OAuthError`
 * carries a protocol error code the screen shows verbatim. Anything else
 * propagates unchanged so a genuine bug is never disguised as a client error.
 */
function toConsentTrpcError(err: unknown): unknown {
  if (err instanceof AuthorizeUserError) {
    return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  if (err instanceof OAuthError) {
    return new TRPCError({
      code: "BAD_REQUEST",
      message: `${err.code}: ${err.message}`,
    });
  }
  return err;
}

/**
 * Generate API key with proper prefix
 */
function generateApiKey(prefix: string): string {
  const randomPart = randomBytes(32).toString("hex");
  return `${prefix}${randomPart}`;
}

export const apiKeysRouter = router({
  /**
   * The canonical set of scopes a key may carry — the SAME `API_KEY_SCOPES` the
   * `create` mutation validates against. The key-creation UI renders its scope
   * options from this so it can never drift out of sync with the backend
   * validator (which is exactly how the phantom `sync` scope shipped).
   */
  availableScopes: protectedProcedure.query(() => {
    return { scopes: API_KEY_SCOPES as readonly string[] };
  }),

  /**
   * List API keys for the current user
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const keys = await db.query.apiKeys.findMany({
      where: eq(apiKeys.userId, ctx.userId),
      orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
    });

    // Remove sensitive fields (keyHash)
    return keys.map((key) => ({
      id: key.id,
      keyName: key.keyName,
      keyPrefix: key.keyPrefix,
      keyType: key.keyType,
      hubId: key.hubId,
      linkedUserId: key.linkedUserId,
      scope: key.scope,
      isActive: key.isActive,
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
      usageCount: key.usageCount,
      createdAt: key.createdAt,
      revokedAt: key.revokedAt,
      revokedReason: key.revokedReason,
    }));
  }),

  /**
   * Admin: list all API keys on the pod (pod-admin only).
   * When `workspaceId` is set, filters to keys whose owner is a member of that workspace.
   * Note: API keys don't have a direct workspace_id column — workspace association is
   * inferred via the owner's workspace memberships.
   */
  adminListAll: podAdminProcedure
    .input(z.object({ workspaceId: z.string().uuid().optional() }).optional())
    .query(async ({ input }) => {
      const workspaceId = input?.workspaceId;

      let userIdFilter: string[] | undefined;
      if (workspaceId) {
        const members = await db.query.workspaceMembers.findMany({
          where: eq(workspaceMembers.workspaceId, workspaceId),
          columns: { userId: true },
        });
        userIdFilter = members.map((m) => m.userId);
        // No members → no keys to return.
        if (userIdFilter.length === 0) return [];
      }

      const keys = await db.query.apiKeys.findMany({
        where: userIdFilter ? inArray(apiKeys.userId, userIdFilter) : undefined,
        orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
      });

      return keys.map((key) => ({
        id: key.id,
        userId: key.userId,
        keyName: key.keyName,
        keyPrefix: key.keyPrefix,
        keyType: key.keyType,
        hubId: key.hubId,
        linkedUserId: key.linkedUserId,
        scope: key.scope,
        isActive: key.isActive,
        expiresAt: key.expiresAt,
        lastUsedAt: key.lastUsedAt,
        usageCount: key.usageCount,
        createdAt: key.createdAt,
        createdBy: key.createdBy,
        revokedAt: key.revokedAt,
        revokedReason: key.revokedReason,
      }));
    }),

  /**
   * Create a new API key
   *
   * SECURITY: The key is displayed ONCE and cannot be retrieved later.
   */
  create: protectedProcedure
    .input(
      z.object({
        keyName: z.string().min(1).max(100),
        scope: z
          .array(z.enum([...API_KEY_SCOPES] as [string, ...string[]]))
          .min(1),
        hubId: z.string().optional(),
        expiresInDays: z.number().int().min(1).max(365).optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const id = randomUUID();

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "apiKey",
        action: "create",
        data: { id, keyName: input.keyName },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          id,
          key: null as unknown as string,
          keyPrefix: "",
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      // Determine key prefix
      const keyPrefix = input.hubId
        ? process.env.NODE_ENV === "production"
          ? "synap_hub_live_"
          : "synap_hub_test_"
        : "synap_user_";

      // Generate key (plaintext - will be hashed in repository)
      const key = generateApiKey(keyPrefix);

      // Calculate expiration
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : undefined;

      // 2. Direct DB operation via repository (handles bcrypt hashing)
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      const apiKey = await apiKeyRepo.create(
        {
          keyName: input.keyName,
          keyPrefix,
          key,
          hubId: input.hubId,
          scope: input.scope,
          expiresAt,
          userId: ctx.userId,
          keyType: input.hubId ? "hub_inbound" : "user_pat",
        },
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "completed",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { keyName: input.keyName, keyPrefix },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "apiKey",
        action: "create",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      // Return key ONLY once (never stored in plaintext)
      return {
        id: apiKey.id,
        key, // Displayed ONCE
        keyPrefix,
        status: "created" as const,
        message: "Save this key securely. It will not be displayed again.",
      };
    }),

  /**
   * Revoke an API key
   */
  revoke: protectedProcedure
    .input(
      z.object({
        keyId: z.string().uuid(),
        reason: z.string().optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify ownership
      const key = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, input.keyId),
      });

      if (!key || key.userId !== ctx.userId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "API key not found",
        });
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "apiKey",
        action: "delete",
        data: { id: input.keyId },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation via repository
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      await apiKeyRepo.revoke(input.keyId, ctx.userId, input.reason);

      // 3. Audit log
      auditLog({
        subjectType: "apiKey",
        action: "delete",
        phase: "completed",
        subjectId: input.keyId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { reason: input.reason },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "apiKey",
        action: "delete",
        subjectId: input.keyId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        status: "revoked" as const,
      };
    }),

  /**
   * Rotate an API key (create new, revoke old)
   */
  rotate: protectedProcedure
    .input(
      z.object({
        keyId: z.string().uuid(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify ownership
      const oldKey = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, input.keyId),
      });

      if (!oldKey || oldKey.userId !== ctx.userId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "API key not found",
        });
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "apiKey",
        action: "update",
        data: { id: input.keyId },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          id: null as unknown as string,
          key: null as unknown as string,
          keyPrefix: "",
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      // Generate new key
      const newKey = generateApiKey(oldKey.keyPrefix);

      // 2. Direct DB operation via repository (handles bcrypt + revoke old)
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      const newApiKey = await apiKeyRepo.rotate(
        input.keyId,
        newKey,
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "apiKey",
        action: "update",
        phase: "completed",
        subjectId: newApiKey.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { rotatedFromId: input.keyId },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "apiKey",
        action: "update",
        subjectId: newApiKey.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        id: newApiKey.id,
        key: newKey, // Displayed ONCE
        keyPrefix: oldKey.keyPrefix,
        status: "rotated" as const,
        message: "Save this new key securely. It will not be displayed again.",
      };
    }),

  /**
   * Admin: revoke every active API key owned by the given user.
   *
   * Soft-revoke (sets is_active=false + revoked_at=NOW + revoked_reason).
   * Idempotent — already-inactive keys are skipped via the `is_active = true`
   * predicate so re-running returns `revokedCount: 0`. Pod admins cannot
   * revoke their own keys to avoid locking themselves out.
   */
  adminRevokeAllForUser: podAdminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        reason: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "You cannot revoke your own API keys via this admin endpoint.",
        });
      }

      const revokedRows = await db
        .update(apiKeys)
        .set({
          isActive: false,
          revokedAt: new Date(),
          revokedBy: ctx.userId,
          revokedReason: input.reason ?? "Bulk revocation by pod admin",
        })
        .where(
          and(eq(apiKeys.userId, input.userId), eq(apiKeys.isActive, true))
        )
        .returning({ id: apiKeys.id });

      auditLog({
        subjectType: "apiKey",
        action: "delete",
        phase: "completed",
        subjectId: input.userId,
        userId: ctx.userId,
        data: {
          targetUserId: input.userId,
          revokedCount: revokedRows.length,
          reason: input.reason,
          bulk: true,
        },
      });

      return { revokedCount: revokedRows.length };
    }),

  /**
   * Permanently delete a single revoked key. Only allowed when isActive=false.
   * Use this to clean up the revoked-keys graveyard in the pod-admin UI.
   */
  adminDeleteRevoked: podAdminProcedure
    .input(z.object({ keyId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const key = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, input.keyId),
        columns: { id: true, isActive: true, keyName: true },
      });
      if (!key) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Key not found" });
      }
      if (key.isActive) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot delete an active key — revoke it first.",
        });
      }
      await db.delete(apiKeys).where(eq(apiKeys.id, input.keyId));
      auditLog({
        subjectType: "apiKey",
        action: "delete",
        phase: "completed",
        subjectId: input.keyId,
        userId: ctx.userId,
        data: { keyId: input.keyId, keyName: key.keyName, permanent: true },
      });
      return { deleted: true };
    }),

  /**
   * List all API keys on the pod (metadata only). Pod-admin workspace only.
   */
  listSystemKeys: podAdminProcedure.query(async () => {
    const keys = await db.query.apiKeys.findMany({
      orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
      with: {
        user: true, // Include user details
      },
    });

    return keys.map((key) => ({
      id: key.id,
      keyName: key.keyName,
      keyPrefix: key.keyPrefix,
      keyType: key.keyType,
      hubId: key.hubId,
      linkedUserId: key.linkedUserId,
      scope: key.scope,
      isActive: key.isActive,
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
      usageCount: key.usageCount,
      createdAt: key.createdAt,
      user: key.user
        ? { id: key.user.id, email: key.user.email, name: key.user.name }
        : null,
    }));
  }),

  /**
   * Create a system-wide service key (synap_hub_live_ prefix, keyType=system).
   * Pod-admin only. Tied to the operator's userId for audit purposes.
   */
  createSystemKey: podAdminProcedure
    .input(
      z.object({
        keyName: z.string().min(1).max(100),
        scope: z
          .array(z.enum([...API_KEY_SCOPES] as [string, ...string[]]))
          .min(1),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const keyPrefix =
        process.env.NODE_ENV === "production"
          ? "synap_hub_live_"
          : "synap_hub_test_";
      const key = generateApiKey(keyPrefix);
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : undefined;

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      const apiKey = await apiKeyRepo.create(
        {
          keyName: input.keyName,
          keyPrefix,
          key,
          scope: input.scope,
          expiresAt,
          userId: ctx.userId,
          keyType: "system",
        },
        ctx.userId
      );

      auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "completed",
        subjectId: apiKey.id,
        userId: ctx.userId,
        data: { keyName: input.keyName, keyPrefix, keyType: "system" },
      });

      return {
        id: apiKey.id,
        key,
        keyPrefix,
        status: "created" as const,
        message: "Save this key securely. It will not be displayed again.",
      };
    }),

  /**
   * Pod-admin: create a workspace-scoped service key (synap_hub_ prefix, keyType=hub_inbound).
   * Use this when provisioning credentials for external services via the connections UI.
   */
  adminCreateServiceKey: podAdminProcedure
    .input(
      z.object({
        keyName: z.string().min(1).max(100),
        scope: z
          .array(z.enum([...API_KEY_SCOPES] as [string, ...string[]]))
          .min(1),
        workspaceId: z.string().uuid(),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const keyPrefix =
        process.env.NODE_ENV === "production"
          ? "synap_hub_live_"
          : "synap_hub_test_";
      const key = generateApiKey(keyPrefix);
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : undefined;

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      const apiKey = await apiKeyRepo.create(
        {
          keyName: input.keyName,
          keyPrefix,
          key,
          scope: input.scope,
          expiresAt,
          userId: ctx.userId,
          keyType: "hub_inbound",
          workspaceId: input.workspaceId,
        },
        ctx.userId
      );

      auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "completed",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { keyName: input.keyName, keyPrefix, keyType: "hub_inbound" },
      });

      emitSideEffects({
        subjectType: "apiKey",
        action: "create",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        id: apiKey.id,
        key,
        keyPrefix,
        status: "created" as const,
        message: "Save this key securely. It will not be displayed again.",
      };
    }),

  /**
   * Connect an integration — create a scoped Hub Protocol API key in one call.
   *
   * Called from the admin UI /connect page after the user authenticates.
   * Returns the key + podUrl + workspaceId so the caller can build a deeplink
   * or display a copy-paste flow — no separate agent provisioning required.
   */
  connectIntegration: protectedProcedure
    .input(
      z.object({
        integration: integrationKindSchema,
        workspaceId: z.string().uuid().optional(),
        strategy: z
          .enum(["create_new", "replace_existing"])
          .default("create_new"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const flowId = randomUUID();
      const id = randomUUID();

      // Resolve workspace: use provided (verified) or fall back to user's first
      let resolvedWorkspaceId = input.workspaceId;
      if (resolvedWorkspaceId) {
        // Explicit workspace supplied — verify the caller is actually a member
        const membership = await db.query.workspaceMembers.findFirst({
          where: (m, { and, eq }) =>
            and(
              eq(m.userId, ctx.userId),
              eq(m.workspaceId, resolvedWorkspaceId!)
            ),
        });
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You are not a member of the requested workspace",
          });
        }
      } else {
        // No workspace supplied — use caller's first workspace
        const membership = await db.query.workspaceMembers.findFirst({
          where: eq(workspaceMembers.userId, ctx.userId),
          orderBy: [asc(workspaceMembers.joinedAt)],
        });
        resolvedWorkspaceId = membership?.workspaceId;
      }

      // Standard permission gate — same as `create`. Will auto-approve for
      // direct user actions on their own resources (DEFAULT_AUTO_APPROVE).
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: resolvedWorkspaceId,
        subjectType: "apiKey",
        action: "create",
        data: {
          id,
          keyName: input.integration,
          integration: input.integration,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        // Shouldn't happen for direct user actions, but handle gracefully
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Key creation requires approval on this pod",
        });
      }

      const integrationHub = integrationHubId(input.integration);
      const scope =
        INTEGRATION_HUB_SCOPES[input.integration] ??
        INTEGRATION_HUB_SCOPES.custom;
      const keyName = `${input.integration.charAt(0).toUpperCase() + input.integration.slice(1)} — ${new Date().toISOString().slice(0, 10)}`;

      if (input.strategy === "replace_existing") {
        await db
          .update(apiKeys)
          .set({
            isActive: false,
            revokedAt: new Date(),
            revokedBy: ctx.userId,
            revokedReason: `Replaced by ${input.integration} reconnect`,
          })
          .where(
            and(
              eq(apiKeys.userId, ctx.userId),
              eq(apiKeys.hubId, integrationHub),
              eq(apiKeys.keyType, "hub_inbound"),
              eq(apiKeys.isActive, true)
            )
          );
      }

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      const registration = await createAndVerifyHubInboundKey(
        apiKeyRepo,
        {
          keyName,
          // hubId marks this as a Hub Protocol key (traceable in audit logs).
          hubId: integrationHub,
          scope,
          userId: ctx.userId,
        },
        ctx.userId,
        ctx.userId
      );
      const { apiKey, plainKey } = registration;
      const registrationTrace = toRegistrationTrace(flowId, registration);
      if (registration.outcome !== "CONNECTED_VERIFIED") {
        auditLog({
          subjectType: "apiKey",
          action: "create",
          phase: "failed",
          subjectId: apiKey.id,
          userId: ctx.userId,
          workspaceId: resolvedWorkspaceId,
          data: {
            keyName,
            integration: input.integration,
            strategy: input.strategy,
            ...registrationTrace,
          },
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Key was issued but verification failed. Flow: ${flowId}`,
        });
      }

      auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "completed",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: resolvedWorkspaceId,
        data: {
          keyName,
          integration: input.integration,
          strategy: input.strategy,
          ...registrationTrace,
        },
      });

      emitSideEffects({
        subjectType: "apiKey",
        action: "create",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: resolvedWorkspaceId,
      });

      const podUrl =
        process.env.PUBLIC_URL?.replace(/\/$/, "") || "http://localhost:4000";

      return {
        apiKey: plainKey, // plaintext, shown once
        keyId: apiKey.id,
        podUrl,
        workspaceId: resolvedWorkspaceId ?? null,
        integration: input.integration,
        strategy: input.strategy,
        registration: registrationTrace,
      };
    }),

  /**
   * beginMcpConnect — mint a one-time CONSENT CODE for the CP-MCP pod-accept gate.
   *
   * MCP-OAUTH-AND-CONNECT-PLAN §2-3. Session-authed: the caller is the human who
   * clicked "Allow" on pod-admin `/connect`. This does NOT mint the agent key —
   * it only records consent as a short-lived, single-use code (stored as a
   * sha256 hash, like api_keys.key_lookup_hash) and returns the RAW code once.
   * pod-admin then top-level-navigates to the CP callback with `?code=<code>`
   * (only the code, never a key). The CP later redeems it server-to-server at
   * POST /api/hub/mcp/redeem, where the pod mints the `claude-web` agent key.
   * Minting on redeem (not here) means no plaintext key touches the browser.
   */
  beginMcpConnect: protectedProcedure
    .input(
      z.object({
        agentType: z.literal("claude-web"),
        // CP-grammar scopes (e.g. ["mcp:read","mcp:write"]); mapped to pod grammar
        // at redeem. Stored verbatim so the redeem side owns the translation.
        scopes: z.array(z.string()).max(32).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Validate the caller is a real human — a consent code binds the acting
      // human to the CP grant; an agent user must never author its own consent.
      const caller = await db.query.users.findFirst({
        where: eq(users.id, ctx.userId),
        columns: { id: true, userType: true },
      });
      if (!caller || caller.userType !== "human") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only a human pod user can authorize an MCP connection.",
        });
      }

      // High-entropy one-time code — returned raw ONCE, only its hash is stored.
      const code = randomBytes(32).toString("base64url");
      const codeHash = createHash("sha256").update(code).digest("hex");

      // ~10 minute TTL — long enough for the CP callback round-trip, short enough
      // to bound replay exposure.
      const MCP_CONNECT_CODE_TTL_MS = 10 * 60 * 1000;
      const expiresAt = new Date(Date.now() + MCP_CONNECT_CODE_TTL_MS);

      await db.insert(mcpConnectCodes).values({
        codeHash,
        podUserId: ctx.userId,
        scopes: input.scopes ?? [],
        agentType: input.agentType,
        expiresAt,
      });

      auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "completed",
        subjectId: codeHash.slice(0, 12),
        userId: ctx.userId,
        data: {
          kind: "mcp_connect_code",
          agentType: input.agentType,
          scopes: input.scopes ?? [],
        },
      });

      return { code, expiresAt: expiresAt.toISOString() };
    }),

  /**
   * getOAuthConsentContext — what pod-admin's `/oauth/consent` screen renders.
   *
   * Path B (pod-as-authorization-server). The pod's own `GET /authorize` bounced
   * the browser here; this resolves the registered client so the screen shows
   * the client's REAL name, REAL redirect host and REAL granted scopes rather
   * than anything carried in the (user-rewritable) query string.
   *
   * Session-authed like `beginMcpConnect` — the consent screen is only reachable
   * with a valid Kratos session, and this call re-establishes who is deciding.
   */
  getOAuthConsentContext: protectedProcedure
    .input(oauthAuthorizeParamsSchema)
    .query(async ({ input }) => {
      try {
        return await getOAuthConsentContext(input);
      } catch (err) {
        throw toConsentTrpcError(err);
      }
    }),

  /**
   * decideOAuthAuthorization — the human clicked Allow or Deny.
   *
   * On Allow this mints the authorization code bound to the PKCE challenge, with
   * `userId` = THIS caller. That id becomes the access token's `linkedUserId` at
   * /token, which is the only thing that makes Claude's writes land as governed
   * proposals rather than silently auto-applying as the operator.
   *
   * Returns the absolute URL to navigate to — built server-side from the
   * client's REGISTERED redirect_uri, never from user input, so this can never
   * become an open redirect.
   */
  decideOAuthAuthorization: protectedProcedure
    .input(oauthAuthorizeParamsSchema.extend({ approve: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await decideOAuthAuthorization(input, ctx.userId);
        auditLog({
          subjectType: "apiKey",
          action: "create",
          phase: "completed",
          subjectId: input.clientId,
          userId: ctx.userId,
          data: {
            kind: "pod_oauth_authorization",
            approve: input.approve,
            scopes: input.scope ?? null,
          },
        });
        return result;
      } catch (err) {
        throw toConsentTrpcError(err);
      }
    }),

  /**
   * List workspace keys (Workspace Owner/Admin only)
   */
  listWorkspaceKeys: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Check permissions
      const membership = await db.query.workspaceMembers.findFirst({
        where: (members, { and, eq }) =>
          and(
            eq(members.workspaceId, input.workspaceId),
            eq(members.userId, ctx.userId)
          ),
      });

      if (!membership || !["owner", "admin"].includes(membership.role)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Insufficient permissions",
        });
      }

      // Get all members of workspace
      const members = await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.workspaceId, input.workspaceId),
        columns: { userId: true },
      });

      const memberIds = members.map((m) => m.userId);

      if (memberIds.length === 0) {
        return [];
      }

      // Get keys for these users
      const keys = await db.query.apiKeys.findMany({
        where: (apiKeys, { inArray }) => inArray(apiKeys.userId, memberIds),
        orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
        with: {
          user: true,
        },
      });

      return keys.map((key) => ({
        id: key.id,
        keyName: key.keyName,
        keyPrefix: key.keyPrefix,
        hubId: key.hubId,
        scope: key.scope,
        isActive: key.isActive,
        expiresAt: key.expiresAt,
        lastUsedAt: key.lastUsedAt,
        usageCount: key.usageCount,
        createdAt: key.createdAt,
        user: {
          id: key.user.id,
          email: key.user.email,
          name: key.user.name,
        },
      }));
    }),

  /**
   * Workspace-admin: list every API key tagged to ctx.workspaceId.
   *
   * Unlike `listWorkspaceKeys` (which infers workspace association from
   * member->user->keys), this procedure reads the explicit `workspace_id`
   * column on `api_keys`. Only keys minted via `createForWorkspace` show up
   * here — legacy pod-wide / user-scoped keys (workspace_id = NULL) are
   * intentionally excluded so the UI only displays keys it can manage.
   *
   * Auth: workspaceProcedure verifies membership; we further require
   * admin/owner role for any key-management surface.
   */
  listForWorkspace: workspaceProcedure.query(async ({ ctx }) => {
    if (!["owner", "admin"].includes(ctx.workspaceRole)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Workspace admin role required",
      });
    }

    const keys = await db.query.apiKeys.findMany({
      where: eq(apiKeys.workspaceId, ctx.workspaceId),
      orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
    });

    return keys.map((key) => ({
      id: key.id,
      keyName: key.keyName,
      keyPrefix: key.keyPrefix,
      keyType: key.keyType,
      hubId: key.hubId,
      scope: key.scope,
      isActive: key.isActive,
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
      usageCount: key.usageCount,
      createdAt: key.createdAt,
      createdBy: key.createdBy,
      revokedAt: key.revokedAt,
      revokedReason: key.revokedReason,
      workspaceId: key.workspaceId,
    }));
  }),

  /**
   * Workspace-admin: create a new API key tagged to ctx.workspaceId.
   *
   * The key is bound to the current workspace via `api_keys.workspace_id`
   * so subsequent listForWorkspace / revokeForWorkspace calls only see and
   * touch keys that belong to this workspace.
   *
   * SECURITY: The plaintext key is returned ONCE. The caller is the owner
   * of the key (`userId = ctx.userId`).
   */
  createForWorkspace: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        scopes: z
          .array(z.enum([...API_KEY_SCOPES] as [string, ...string[]]))
          .min(1),
        expiresAt: z.date().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!["owner", "admin"].includes(ctx.workspaceRole)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Workspace admin role required",
        });
      }

      const id = randomUUID();

      // Permission check (mirrors `create`) — workspace-scoped this time.
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        subjectType: "apiKey",
        action: "create",
        data: { id, keyName: input.name },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          id,
          key: null as unknown as string,
          keyPrefix: "",
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      // Workspace-scoped keys are user PATs (not hub-inbound).
      const keyPrefix = "synap_user_";
      const key = generateApiKey(keyPrefix);

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      const apiKey = await apiKeyRepo.create(
        {
          keyName: input.name,
          keyPrefix,
          key,
          scope: input.scopes,
          expiresAt: input.expiresAt,
          userId: ctx.userId,
          keyType: "user_pat",
          workspaceId: ctx.workspaceId,
        },
        ctx.userId
      );

      auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "completed",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        data: { keyName: input.name, keyPrefix, scope: "workspace" },
      });

      emitSideEffects({
        subjectType: "apiKey",
        action: "create",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return {
        id: apiKey.id,
        key, // displayed ONCE
        keyPrefix,
        status: "created" as const,
        message: "Save this key securely. It will not be displayed again.",
      };
    }),

  /**
   * Workspace-admin: revoke an API key that belongs to ctx.workspaceId.
   *
   * Anti-cross-workspace mistake: we read the key first and FAIL if its
   * `workspace_id` does not match `ctx.workspaceId`. This prevents an admin
   * of workspace A from revoking a key owned by workspace B even if they
   * happen to know its UUID.
   */
  revokeForWorkspace: workspaceProcedure
    .input(z.object({ keyId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      if (!["owner", "admin"].includes(ctx.workspaceRole)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Workspace admin role required",
        });
      }

      const key = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, input.keyId),
      });

      if (!key) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "API key not found",
        });
      }

      // Cross-workspace defense: a workspace admin can only revoke keys
      // that were minted to THIS workspace. Pod-wide / user-scoped /
      // other-workspace keys are off-limits via this surface.
      if (key.workspaceId !== ctx.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "API key does not belong to this workspace",
        });
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        subjectType: "apiKey",
        action: "delete",
        data: { id: input.keyId },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      await apiKeyRepo.revoke(
        input.keyId,
        ctx.userId,
        "Revoked via workspace admin"
      );

      auditLog({
        subjectType: "apiKey",
        action: "delete",
        phase: "completed",
        subjectId: input.keyId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        data: { scope: "workspace" },
      });

      emitSideEffects({
        subjectType: "apiKey",
        action: "delete",
        subjectId: input.keyId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return { status: "revoked" as const };
    }),
});
