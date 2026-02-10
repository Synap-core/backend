/**
 * API Keys Router
 *
 * Hub Protocol V1.0 - Phase 2
 *
 * Event-driven API key management with bcrypt hashing.
 * ⚠️ SECURITY: Keys are displayed ONCE and never stored in plaintext.
 */

import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { API_KEY_SCOPES } from "@synap/database/schema";
import { db, eq, and, apiKeys, workspaceMembers } from "@synap/database";
import { emitRequestEvent } from "../utils/emit-event.js";
import { randomUUID, randomBytes } from "crypto";

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
   * Event-driven: emits api_keys.create.requested
   *
   * ⚠️ SECURITY: The key is displayed ONCE and cannot be retrieved later.
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      const id = randomUUID();

      // Determine key prefix
      const keyPrefix = input.hubId
        ? process.env.NODE_ENV === "production"
          ? "synap_hub_live_"
          : "synap_hub_test_"
        : "synap_user_";

      // Generate key (plaintext - will be hashed in executor)
      const key = generateApiKey(keyPrefix);

      // Calculate expiration
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : undefined;

      await emitRequestEvent({
        subjectType: "apiKey",
        action: "create",
        subjectId: id,
        data: {
          id,
          keyName: input.keyName,
          keyPrefix,
          key, // Will be hashed in executor
          hubId: input.hubId,
          scope: input.scope,
          expiresAt,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      // Return key ONLY once (never stored in plaintext)
      return {
        id,
        key, // ⚠️ Displayed ONCE
        keyPrefix,
        status: "requested",
        message: "⚠️ Save this key securely. It will not be displayed again.",
      };
    }),

  /**
   * Revoke an API key
   * Event-driven: emits api_keys.revoke.requested
   */
  revoke: protectedProcedure
    .input(
      z.object({
        keyId: z.string().uuid(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify ownership
      const key = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, input.keyId),
      });

      if (!key || key.userId !== ctx.userId) {
        throw new Error("API key not found");
      }

      await emitRequestEvent({
        subjectType: "apiKey",
        action: "delete",
        subjectId: input.keyId,
        data: {
          id: input.keyId,
          reason: input.reason,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "API key revocation requested",
      };
    }),

  /**
   * Rotate an API key (create new, revoke old)
   * Event-driven: emits api_keys.rotate.requested
   */
  rotate: protectedProcedure
    .input(
      z.object({
        keyId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify ownership
      const oldKey = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, input.keyId),
      });

      if (!oldKey || oldKey.userId !== ctx.userId) {
        throw new Error("API key not found");
      }

      await emitRequestEvent({
        subjectType: "apiKey",
        action: "update",
        subjectId: input.keyId,
        data: {
          id: input.keyId,
          keyPrefix: oldKey.keyPrefix,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "API key rotation requested. New key will be generated.",
      };
    }),

  /**
   * List all system keys (System Admin only)
   */
  listSystemKeys: protectedProcedure.query(async ({ ctx }) => {
    // TODO: Implement proper system admin check
    const isSystemAdmin = false; // Replace with actual check

    if (!isSystemAdmin) {
      // For now, allow if user is owner of any workspace (temporary for demo)
      // Real implementation should check system role
      const ownedWorkspaces = await db.query.workspaceMembers.findFirst({
        where: (members, { and, eq }) =>
          and(eq(members.userId, ctx.userId), eq(members.role, "owner")),
      });

      if (!ownedWorkspaces) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Requires system admin privileges",
        });
      }
    }

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
