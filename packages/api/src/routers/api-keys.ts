/**
 * API Keys Router
 * 
 * Hub Protocol V1.0 - Phase 2
 * 
 * tRPC router for managing API keys (create, list, revoke, rotate).
 */

import { router, protectedProcedure } from '../trpc.js';
import { z } from 'zod';
import { apiKeyService } from '../services/api-keys.js';
import { API_KEY_SCOPES, type ApiKeyScope } from '@synap/database';
import { TRPCError } from '@trpc/server';

/**
 * Validation schemas
 */
const CreateApiKeyInputSchema = z.object({
  keyName: z.string().min(1, 'Key name is required').max(100, 'Key name too long'),
  scope: z.array(z.enum([...API_KEY_SCOPES] as [string, ...string[]])).min(1, 'At least one scope required'),
  hubId: z.string().optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

const RevokeApiKeyInputSchema = z.object({
  keyId: z.string().uuid('Invalid key ID'),
  reason: z.string().optional(),
});

const RotateApiKeyInputSchema = z.object({
  keyId: z.string().uuid('Invalid key ID'),
});

/**
 * API Keys Router
 */
export const apiKeysRouter = router({
  /**
   * Create a new API key
   * 
   * Generates a new API key with bcrypt hashing and returns it.
   * ⚠️ The key is displayed ONCE and cannot be retrieved later.
   * 
   * @input keyName - User-friendly name for the key
   * @input scope - Array of permissions
   * @input hubId - Optional Hub ID (for Hub keys)
   * @input expiresInDays - Optional expiration in days
   * @returns The generated key, key ID, and metadata
   */
  create: protectedProcedure
    .input(CreateApiKeyInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { key, keyId } = await apiKeyService.generateApiKey(
          ctx.userId,
          input.keyName,
          input.scope as ApiKeyScope[],
          input.hubId,
          input.expiresInDays
        );
        
        return {
          success: true,
          key, // ⚠️ Displayed ONCE
          keyId,
          message: '⚠️ Save this key securely. It will not be displayed again.',
        };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to create API key',
        });
      }
    }),
  
  /**
   * List API keys for the current user
   * 
   * Returns all API keys (active and revoked) without the hash.
   * 
   * @returns Array of key records with metadata
   */
  list: protectedProcedure
    .query(async ({ ctx }) => {
      try {
        const keys = await apiKeyService.listUserKeys(ctx.userId);
        
        // Remove sensitive fields
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
          rotationScheduledAt: key.rotationScheduledAt,
          createdAt: key.createdAt,
          revokedAt: key.revokedAt,
          revokedReason: key.revokedReason,
        }));
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to list API keys',
        });
      }
    }),
  
  /**
   * Revoke an API key
   * 
   * Deactivates a key immediately. All future requests with this key will fail.
   * 
   * @input keyId - Key ID to revoke
   * @input reason - Optional reason for revocation
   * @returns Success confirmation
   */
  revoke: protectedProcedure
    .input(RevokeApiKeyInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await apiKeyService.revokeApiKey(
          input.keyId,
          ctx.userId,
          input.reason
        );
        
        return {
          success: true,
          message: 'API key revoked successfully',
        };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to revoke API key',
        });
      }
    }),
  
  /**
   * Rotate an API key
   * 
   * Creates a new key with the same properties and revokes the old one.
   * Useful for security best practices (rotate keys every 90 days).
   * 
   * @input keyId - Key ID to rotate
   * @returns The new key and key ID
   */
  rotate: protectedProcedure
    .input(RotateApiKeyInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { newKey, newKeyId } = await apiKeyService.rotateApiKey(
          input.keyId,
          ctx.userId
        );
        
        return {
          success: true,
          newKey, // ⚠️ Displayed ONCE
          newKeyId,
          message: '⚠️ Save this key securely. The old key has been revoked.',
        };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to rotate API key',
        });
      }
    }),
});

