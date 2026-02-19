/**
 * Secrets Vault Router
 *
 * Secure storage for passwords, API keys, and sensitive credentials.
 *
 * Security Model:
 * - Client-side encryption (AES-256-GCM)
 * - Server never sees plaintext secrets
 * - Zero-knowledge architecture
 * - Complete audit trail
 */

import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  db,
  sql,
  eq,
  secretVaultKeys,
  SECRET_TYPES,
  SecretsVaultRepository,
  EventRepository,
  encryptionService,
} from "@synap/database";

// ============================================================================
// Validation Schemas
// ============================================================================

const secretTypeSchema = z.enum(SECRET_TYPES);

const createSecretSchema = z.object({
  name: z.string().min(1).max(255),
  type: secretTypeSchema,
  url: z.string().url().optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(1000).optional(),
  iconUrl: z.string().url().optional(),
  encryptedData: z.string(), // Client-encrypted JSON blob
  iv: z.string(), // Base64 IV
  authTag: z.string(), // Base64 auth tag
  passwordStrength: z.number().min(0).max(4).optional(),
  tags: z.array(z.string().max(100)).optional(),
  workspaceId: z.string().uuid().optional(),
});

const updateSecretSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  url: z.string().url().optional().nullable(),
  category: z.string().max(100).optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  iconUrl: z.string().url().optional().nullable(),
  encryptedData: z.string().optional(),
  iv: z.string().optional(),
  authTag: z.string().optional(),
  isFavorite: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  passwordStrength: z.number().min(0).max(4).optional(),
  tags: z.array(z.string().max(100)).optional(),
});

const shareSecretSchema = z
  .object({
    secretId: z.string().uuid(),
    sharedWithUserId: z.string().optional(),
    sharedWithWorkspaceId: z.string().uuid().optional(),
    permission: z.enum(["read", "write"]).default("read"),
    expiresAt: z.date().optional(),
  })
  .refine((data) => data.sharedWithUserId || data.sharedWithWorkspaceId, {
    message: "Must specify user or workspace to share with",
  });

const setupVaultSchema = z.object({
  salt: z.string(),
  keyDerivationAlgorithm: z.string(),
  keyDerivationParams: z.object({
    N: z.number(),
    r: z.number(),
    p: z.number(),
  }),
  verificationCipher: z.string(),
  verificationIv: z.string(),
  verificationTag: z.string(),
  recoveryKeyHash: z.string().optional(),
});

// ============================================================================
// Helper to get repository
// ============================================================================

function getRepository(): SecretsVaultRepository {
  const eventRepo = new EventRepository(sql);
  return new SecretsVaultRepository(db, eventRepo);
}

// ============================================================================
// Router
// ============================================================================

export const secretsVaultRouter = router({
  // ==========================================================================
  // Vault Setup & Unlock
  // ==========================================================================

  /**
   * Check if vault is set up for current user
   */
  hasVault: protectedProcedure.query(async ({ ctx }) => {
    const repo = getRepository();
    return repo.hasVaultSetup(ctx.userId);
  }),

  /**
   * Get vault metadata (for client-side password verification)
   */
  getVaultMetadata: protectedProcedure.query(async ({ ctx }) => {
    const repo = getRepository();
    const metadata = await repo.getVaultKeyMetadata(ctx.userId);

    if (!metadata) {
      return null;
    }

    return {
      salt: metadata.salt,
      keyDerivationAlgorithm: metadata.keyDerivationAlgorithm,
      keyDerivationParams: metadata.keyDerivationParams,
      verificationCipher: metadata.verificationCipher,
      verificationIv: metadata.verificationIv,
      verificationTag: metadata.verificationTag,
      hasRecoveryKey: !!metadata.recoveryKeyHash,
    };
  }),

  /**
   * Setup vault with master password
   * Client generates the key derivation params and verification cipher
   */
  setupVault: protectedProcedure
    .input(setupVaultSchema)
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();

      const hasVault = await repo.hasVaultSetup(ctx.userId);
      if (hasVault) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Vault already set up",
        });
      }

      await repo.setupVault(ctx.userId, {
        salt: input.salt,
        keyDerivationAlgorithm: input.keyDerivationAlgorithm,
        keyDerivationParams: input.keyDerivationParams,
        verificationCipher: input.verificationCipher,
        verificationIv: input.verificationIv,
        verificationTag: input.verificationTag,
        recoveryKeyHash: input.recoveryKeyHash,
      });

      return { success: true };
    }),

  /**
   * Record vault unlock (for audit trail)
   */
  recordUnlock: protectedProcedure.mutation(async ({ ctx }) => {
    const repo = getRepository();
    await repo.recordVaultUnlock(ctx.userId);
    return { success: true };
  }),

  /**
   * Generate recovery key (server-side for security)
   */
  generateRecoveryKey: protectedProcedure.mutation(async ({ ctx }) => {
    const recoveryKey = encryptionService.generateRecoveryKey();
    const hash = await encryptionService.hashRecoveryKey(recoveryKey);

    // Store hash in vault keys
    await db
      .update(secretVaultKeys)
      .set({
        recoveryKeyHash: hash,
        recoveryKeyCreatedAt: new Date(),
      })
      .where(eq(secretVaultKeys.userId, ctx.userId));

    // Return the recovery key ONCE (user must save it)
    return {
      recoveryKey,
      message:
        "Save this recovery key securely. It will not be displayed again.",
    };
  }),

  // ==========================================================================
  // Secret CRUD
  // ==========================================================================

  /**
   * List secrets (metadata only, not decrypted)
   */
  list: protectedProcedure
    .input(
      z
        .object({
          type: secretTypeSchema.optional(),
          category: z.string().optional(),
          search: z.string().optional(),
          tags: z.array(z.string()).optional(),
          includeDeleted: z.boolean().optional(),
          limit: z.number().int().min(1).max(500).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const repo = getRepository();
      const secrets = await repo.list(ctx.userId, input ?? {});

      // Return secrets without exposing encrypted data in list
      return secrets.map((secret: any) => ({
        id: secret.id,
        name: secret.name,
        type: secret.type,
        url: secret.url,
        category: secret.category,
        description: secret.description,
        iconUrl: secret.iconUrl,
        isFavorite: secret.isFavorite,
        isShared: secret.isShared,
        isCompromised: secret.isCompromised,
        passwordStrength: secret.passwordStrength,
        lastAccessedAt: secret.lastAccessedAt,
        accessCount: secret.accessCount,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
        tags: secret.tags?.map((t: any) => t.tag) ?? [],
      }));
    }),

  /**
   * Get a single secret (includes encrypted data for client decryption)
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const repo = getRepository();
      const secret = await repo.findById(input.id, ctx.userId);

      if (!secret) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Secret not found",
        });
      }

      // Record access
      await repo.recordAccess(input.id, ctx.userId);

      return {
        id: secret.id,
        name: secret.name,
        type: secret.type,
        url: secret.url,
        category: secret.category,
        description: secret.description,
        iconUrl: secret.iconUrl,
        encryptedData: secret.encryptedData,
        iv: secret.iv,
        authTag: secret.authTag,
        encryptionVersion: secret.encryptionVersion,
        isFavorite: secret.isFavorite,
        isShared: secret.isShared,
        isCompromised: secret.isCompromised,
        passwordStrength: secret.passwordStrength,
        passwordLastChanged: secret.passwordLastChanged,
        lastAccessedAt: secret.lastAccessedAt,
        accessCount: secret.accessCount,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
        tags: (secret as any).tags?.map((t: any) => t.tag) ?? [],
      };
    }),

  /**
   * Create a new secret
   */
  create: protectedProcedure
    .input(createSecretSchema)
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();

      // Verify vault is set up
      const hasVault = await repo.hasVaultSetup(ctx.userId);
      if (!hasVault) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Vault not set up. Please set up your vault first.",
        });
      }

      const secret = await repo.create(
        {
          name: input.name,
          type: input.type,
          url: input.url,
          category: input.category,
          description: input.description,
          iconUrl: input.iconUrl,
          encryptedData: input.encryptedData,
          iv: input.iv,
          authTag: input.authTag,
          passwordStrength: input.passwordStrength,
          tags: input.tags,
          workspaceId: input.workspaceId,
        },
        ctx.userId
      );

      return {
        id: secret.id,
        name: secret.name,
        type: secret.type,
        createdAt: secret.createdAt,
      };
    }),

  /**
   * Update a secret
   */
  update: protectedProcedure
    .input(updateSecretSchema)
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      const { id, ...updateData } = input;

      const secret = await repo.update(id, updateData, ctx.userId);

      return {
        id: secret.id,
        name: secret.name,
        updatedAt: secret.updatedAt,
      };
    }),

  /**
   * Delete a secret (soft delete)
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      await repo.delete(input.id, ctx.userId);
      return { success: true };
    }),

  /**
   * Permanently delete a secret
   */
  permanentDelete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      await repo.permanentDelete(input.id, ctx.userId);
      return { success: true };
    }),

  /**
   * Restore a deleted secret
   */
  restore: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      await repo.restore(input.id, ctx.userId);
      return { success: true };
    }),

  // ==========================================================================
  // Autofill & Quick Access
  // ==========================================================================

  /**
   * Find secrets by URL (for autofill)
   */
  findByUrl: protectedProcedure
    .input(z.object({ url: z.string() }))
    .query(async ({ ctx, input }) => {
      const repo = getRepository();
      const secrets = await repo.findByUrl(ctx.userId, input.url);

      return secrets.map((secret: any) => ({
        id: secret.id,
        name: secret.name,
        type: secret.type,
        url: secret.url,
        encryptedData: secret.encryptedData,
        iv: secret.iv,
        authTag: secret.authTag,
      }));
    }),

  /**
   * Record copy to clipboard (for audit)
   */
  recordCopy: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      await repo.recordCopy(input.id, ctx.userId);
      return { success: true };
    }),

  // ==========================================================================
  // Organization
  // ==========================================================================

  /**
   * Get all categories
   */
  getCategories: protectedProcedure.query(async ({ ctx }) => {
    const repo = getRepository();
    return repo.getCategories(ctx.userId);
  }),

  /**
   * Get all tags
   */
  getTags: protectedProcedure.query(async ({ ctx }) => {
    const repo = getRepository();
    return repo.getTags(ctx.userId);
  }),

  // ==========================================================================
  // Sharing
  // ==========================================================================

  /**
   * Share a secret
   */
  share: protectedProcedure
    .input(shareSecretSchema)
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      const share = await repo.share(
        {
          secretId: input.secretId,
          sharedWithUserId: input.sharedWithUserId,
          sharedWithWorkspaceId: input.sharedWithWorkspaceId,
          permission: input.permission,
          expiresAt: input.expiresAt,
        },
        ctx.userId
      );

      return {
        id: share.id,
        secretId: share.secretId,
        permission: share.permission,
      };
    }),

  /**
   * Revoke a share
   */
  revokeShare: protectedProcedure
    .input(z.object({ shareId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      await repo.revokeShare(input.shareId, ctx.userId);
      return { success: true };
    }),

  /**
   * Get secrets shared with me
   */
  sharedWithMe: protectedProcedure.query(async ({ ctx }) => {
    const repo = getRepository();
    const shares = await repo.getSharedWithMe(ctx.userId);

    return shares.map((share: any) => ({
      shareId: share.id,
      permission: share.permission,
      sharedBy: share.sharedBy,
      expiresAt: share.expiresAt,
      secret: {
        id: share.secret.id,
        name: share.secret.name,
        type: share.secret.type,
        url: share.secret.url,
        encryptedData: share.secret.encryptedData,
        iv: share.secret.iv,
        authTag: share.secret.authTag,
      },
    }));
  }),

  // ==========================================================================
  // Audit & Security
  // ==========================================================================

  /**
   * Get audit log for a secret
   */
  getAuditLog: protectedProcedure
    .input(
      z.object({
        secretId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const repo = getRepository();
      return repo.getAuditLog(input.secretId, ctx.userId, input.limit);
    }),

  /**
   * Get security stats (compromised, weak passwords, old passwords)
   */
  getSecurityStats: protectedProcedure.query(async ({ ctx }) => {
    const repo = getRepository();

    const [compromised, weakPasswords, oldPasswords, total] = await Promise.all(
      [
        repo.getCompromisedCount(ctx.userId),
        repo.getWeakPasswordsCount(ctx.userId),
        repo.getOldPasswordsCount(ctx.userId, 90),
        repo.list(ctx.userId, { limit: 1 }).then((r: unknown[]) => r.length),
      ]
    );

    return {
      compromised,
      weakPasswords,
      oldPasswords,
      total,
    };
  }),

  /**
   * Mark a secret as compromised
   */
  markCompromised: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      await repo.markCompromised(input.id, ctx.userId);
      return { success: true };
    }),
});
