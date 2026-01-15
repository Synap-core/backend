/**
 * API Keys Router
 *
 * Hub Protocol V1.0 - Phase 2
 *
 * Event-driven API key management with bcrypt hashing.
 * ⚠️ SECURITY: Keys are displayed ONCE and never stored in plaintext.
 */

import { router, protectedProcedure } from "../trpc.js";
import { z } from "zod";
import { API_KEY_SCOPES } from "@synap/database/schema";
import { db, eq, apiKeys } from "@synap/database";
import { emitRequestEvent } from "../utils/emit-event.js";
import { randomUUID, randomBytes } from "crypto";

/**
 * Generate API key with proper prefix
 */
function generateApiKey(prefix: string): string {
  const randomPart = randomBytes(32).toString('hex');
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
        scope: z.array(z.enum([...API_KEY_SCOPES] as [string, ...string[]])).min(1),
        hubId: z.string().optional(),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const id = randomUUID();
      
      // Determine key prefix
      const keyPrefix = input.hubId 
        ? (process.env.NODE_ENV === 'production' ? 'synap_hub_live_' : 'synap_hub_test_')
        : 'synap_user_';
      
      // Generate key (plaintext - will be hashed in executor)
      const key = generateApiKey(keyPrefix);
      
      // Calculate expiration
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : undefined;

      await emitRequestEvent({
        type: "api_keys.create.requested",
        subjectId: id,
        subjectType: "api_key",
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
      }),
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
        type: "api_keys.revoke.requested",
        subjectId: input.keyId,
        subjectType: "api_key",
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
      }),
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
        type: "api_keys.rotate.requested",
        subjectId: input.keyId,
        subjectType: "api_key",
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
});
