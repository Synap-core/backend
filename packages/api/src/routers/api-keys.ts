/**
 * API Keys Router
 *
 * Synchronous CRUD with inline permission checks and bcrypt hashing.
 * SECURITY: Keys are displayed ONCE and never stored in plaintext.
 */

import { router, protectedProcedure, podAdminProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { API_KEY_SCOPES } from "@synap/database/schema";
import {
  db,
  and,
  eq,
  asc,
  getDb,
  EventRepository,
  ApiKeyRepository,
  sql,
} from "@synap/database";
import { apiKeys, workspaceMembers } from "@synap/database/schema";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/jobs";
import { randomUUID, randomBytes } from "crypto";
import {
  INTEGRATION_HUB_SCOPES,
  integrationHubId,
} from "../services/hub-integration-registration.js";
import { createAndVerifyHubInboundKey } from "../services/external-registration.js";
import { toRegistrationTrace } from "../services/external-registration.js";

/**
 * Generate API key with proper prefix
 */
function generateApiKey(prefix: string): string {
  const randomPart = randomBytes(32).toString("hex");
  return `${prefix}${randomPart}`;
}

export const apiKeysRouter = router({
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
      hubId: key.hubId,
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
   * Connect an integration — create a scoped Hub Protocol API key in one call.
   *
   * Called from the admin UI /connect page after the user authenticates.
   * Returns the key + podUrl + workspaceId so the caller can build a deeplink
   * or display a copy-paste flow — no separate agent provisioning required.
   */
  connectIntegration: protectedProcedure
    .input(
      z.object({
        integration: z.enum(["raycast", "cli", "openclaw", "custom"]),
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
});
