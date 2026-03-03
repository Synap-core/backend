/**
 * Secrets Vault Repository
 *
 * Handles CRUD operations for encrypted secrets with complete audit trail.
 * Security-critical: All secrets are stored encrypted, never in plaintext.
 */

import { eq, and, isNull, ilike, desc, sql, inArray } from "drizzle-orm";
import {
  secrets,
  secretTags,
  secretShares,
  secretAuditLog,
  secretVaultKeys,
  type Secret,
  type SecretTag,
  type SecretShare,
  type SecretAuditAction,
  type SecretType,
} from "../schema/index.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";

// ============================================================================
// Input Types
// ============================================================================

export interface CreateSecretInput {
  name: string;
  type: SecretType;
  url?: string;
  category?: string;
  description?: string;
  iconUrl?: string;
  encryptedData: string;
  iv: string;
  authTag: string;
  encryptionVersion?: number;
  passwordStrength?: number;
  tags?: string[];
  workspaceId?: string;
}

export interface UpdateSecretInput {
  name?: string;
  url?: string | null;
  category?: string | null;
  description?: string | null;
  iconUrl?: string | null;
  encryptedData?: string;
  iv?: string;
  authTag?: string;
  isFavorite?: boolean;
  sortOrder?: number;
  passwordStrength?: number;
  passwordLastChanged?: Date;
  tags?: string[];
}

export interface ShareSecretInput {
  secretId: string;
  sharedWithUserId?: string;
  sharedWithWorkspaceId?: string;
  permission: "read" | "write";
  expiresAt?: Date;
}

export interface SetupVaultInput {
  salt: string;
  keyDerivationAlgorithm: string;
  keyDerivationParams: Record<string, unknown>;
  verificationCipher: string;
  verificationIv: string;
  verificationTag: string;
  recoveryKeyHash?: string;
}

export interface ListSecretsOptions {
  type?: SecretType;
  category?: string;
  search?: string;
  tags?: string[];
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Repository
// ============================================================================

export class SecretsVaultRepository extends BaseRepository<
  Secret,
  CreateSecretInput,
  UpdateSecretInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, {
      subjectType: "secret",
      pluralName: "secrets",
    });
  }

  // ==========================================================================
  // Vault Setup
  // ==========================================================================

  /**
   * Check if user has set up their vault
   */
  async hasVaultSetup(userId: string): Promise<boolean> {
    const vaultKey = await this.db.query.secretVaultKeys.findFirst({
      where: eq(secretVaultKeys.userId, userId),
    });
    return !!vaultKey;
  }

  /**
   * Get vault key metadata for password verification
   */
  async getVaultKeyMetadata(userId: string) {
    return this.db.query.secretVaultKeys.findFirst({
      where: eq(secretVaultKeys.userId, userId),
    });
  }

  /**
   * Setup vault for a new user
   */
  async setupVault(userId: string, data: SetupVaultInput) {
    const existing = await this.hasVaultSetup(userId);
    if (existing) {
      throw new Error("Vault already set up for this user");
    }

    const [vaultKey] = await this.db
      .insert(secretVaultKeys)
      .values({
        userId,
        salt: data.salt,
        keyDerivationAlgorithm: data.keyDerivationAlgorithm,
        keyDerivationParams: data.keyDerivationParams,
        verificationCipher: data.verificationCipher,
        verificationIv: data.verificationIv,
        verificationTag: data.verificationTag,
        recoveryKeyHash: data.recoveryKeyHash,
        recoveryKeyCreatedAt: data.recoveryKeyHash ? new Date() : undefined,
      })
      .returning();

    return vaultKey;
  }

  /**
   * Update last unlocked timestamp
   */
  async recordVaultUnlock(userId: string) {
    await this.db
      .update(secretVaultKeys)
      .set({ lastUnlockedAt: new Date() })
      .where(eq(secretVaultKeys.userId, userId));
  }

  // ==========================================================================
  // Secret CRUD
  // ==========================================================================

  /**
   * Create a new secret
   */
  async create(data: CreateSecretInput, userId: string): Promise<Secret> {
    const [secret] = await this.db
      .insert(secrets)
      .values({
        userId,
        workspaceId: data.workspaceId,
        name: data.name,
        type: data.type,
        url: data.url,
        category: data.category,
        description: data.description,
        iconUrl: data.iconUrl,
        encryptedData: data.encryptedData,
        iv: data.iv,
        authTag: data.authTag,
        encryptionVersion: data.encryptionVersion ?? 1,
        passwordStrength: data.passwordStrength,
        passwordLastChanged:
          data.passwordStrength !== undefined ? new Date() : undefined,
      })
      .returning();

    // Add tags if provided
    if (data.tags && data.tags.length > 0) {
      await this.db.insert(secretTags).values(
        data.tags.map((tag) => ({
          secretId: secret.id,
          tag,
        }))
      );
    }

    // Log audit event
    await this.logAudit(secret.id, userId, "created");

    // Emit event
    await this.emitCompleted("create", secret, userId);

    return secret;
  }

  // ==========================================================================
  // Server-Side Encrypted Secrets (service bootstrap credentials)
  // ==========================================================================

  /**
   * Store a server-side encrypted secret (encryptionMode = 'server').
   *
   * The caller is responsible for encrypting `encryptedData`/`iv`/`authTag`
   * with the server key (see server-vault.ts). This method only inserts the
   * already-encrypted blob — it never handles plaintext.
   *
   * Idempotent: if a server-side secret for this userId + serviceId already
   * exists it is replaced (upsert on conflict).
   */
  async upsertServerSide(
    data: {
      userId: string;
      serviceId: string;
      name: string;
      type: SecretType;
      category?: string;
      description?: string;
      encryptedData: string;
      iv: string;
      authTag: string;
    },
    actorUserId: string
  ): Promise<Secret> {
    // Soft-delete any existing server-side secret for this service
    await this.db
      .update(secrets)
      .set({ deletedAt: new Date(), deletedBy: actorUserId })
      .where(
        and(
          eq(secrets.userId, data.userId),
          eq(secrets.serviceId, data.serviceId),
          eq(secrets.encryptionMode, "server"),
          isNull(secrets.deletedAt)
        )
      );

    const [secret] = await this.db
      .insert(secrets)
      .values({
        userId: data.userId,
        name: data.name,
        type: data.type,
        category: data.category ?? "intelligence-services",
        description: data.description,
        encryptedData: data.encryptedData,
        iv: data.iv,
        authTag: data.authTag,
        encryptionVersion: 1,
        encryptionMode: "server",
        serviceId: data.serviceId,
      })
      .returning();

    await this.logAudit(secret.id, actorUserId, "created");
    return secret;
  }

  /**
   * Find the server-side encrypted secret for a given agent user + serviceId.
   * Returns null if not found or already soft-deleted.
   */
  async findServerSide(
    userId: string,
    serviceId: string
  ): Promise<Secret | null> {
    const result = await this.db.query.secrets.findFirst({
      where: and(
        eq(secrets.userId, userId),
        eq(secrets.serviceId, serviceId),
        eq(secrets.encryptionMode, "server"),
        isNull(secrets.deletedAt)
      ),
    });
    return result ?? null;
  }

  /**
   * Soft-delete all server-side secrets for a given agent user (on deprovision).
   */
  async deleteServerSideForUser(
    userId: string,
    actorUserId: string
  ): Promise<void> {
    await this.db
      .update(secrets)
      .set({ deletedAt: new Date(), deletedBy: actorUserId })
      .where(
        and(
          eq(secrets.userId, userId),
          eq(secrets.encryptionMode, "server"),
          isNull(secrets.deletedAt)
        )
      );
  }

  /**
   * Update an existing secret
   */
  async update(
    id: string,
    data: UpdateSecretInput,
    userId: string
  ): Promise<Secret> {
    // Build update object (only include defined fields)
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.url !== undefined) updateData.url = data.url;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.description !== undefined)
      updateData.description = data.description;
    if (data.iconUrl !== undefined) updateData.iconUrl = data.iconUrl;
    if (data.encryptedData !== undefined)
      updateData.encryptedData = data.encryptedData;
    if (data.iv !== undefined) updateData.iv = data.iv;
    if (data.authTag !== undefined) updateData.authTag = data.authTag;
    if (data.isFavorite !== undefined) updateData.isFavorite = data.isFavorite;
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
    if (data.passwordStrength !== undefined)
      updateData.passwordStrength = data.passwordStrength;
    if (data.passwordLastChanged !== undefined)
      updateData.passwordLastChanged = data.passwordLastChanged;

    const [secret] = await this.db
      .update(secrets)
      .set(updateData)
      .where(and(eq(secrets.id, id), eq(secrets.userId, userId)))
      .returning();

    if (!secret) {
      throw new Error("Secret not found or access denied");
    }

    // Update tags if provided
    if (data.tags !== undefined) {
      // Remove existing tags
      await this.db.delete(secretTags).where(eq(secretTags.secretId, id));

      // Add new tags
      if (data.tags.length > 0) {
        await this.db.insert(secretTags).values(
          data.tags.map((tag) => ({
            secretId: id,
            tag,
          }))
        );
      }
    }

    // Log audit event
    await this.logAudit(id, userId, "updated");

    // Emit event
    await this.emitCompleted("update", secret, userId);

    return secret;
  }

  /**
   * Soft delete a secret
   */
  async delete(id: string, userId: string): Promise<void> {
    const [secret] = await this.db
      .update(secrets)
      .set({
        deletedAt: new Date(),
        deletedBy: userId,
      })
      .where(and(eq(secrets.id, id), eq(secrets.userId, userId)))
      .returning();

    if (!secret) {
      throw new Error("Secret not found or access denied");
    }

    // Log audit event
    await this.logAudit(id, userId, "deleted");

    // Emit event
    await this.emitCompleted("delete", { id }, userId);
  }

  /**
   * Permanently delete a secret (hard delete)
   */
  async permanentDelete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(secrets)
      .where(and(eq(secrets.id, id), eq(secrets.userId, userId)))
      .returning();

    if (result.length === 0) {
      throw new Error("Secret not found or access denied");
    }
  }

  /**
   * Restore a soft-deleted secret
   */
  async restore(id: string, userId: string): Promise<Secret> {
    const [secret] = await this.db
      .update(secrets)
      .set({
        deletedAt: null,
        deletedBy: null,
      })
      .where(and(eq(secrets.id, id), eq(secrets.userId, userId)))
      .returning();

    if (!secret) {
      throw new Error("Secret not found or access denied");
    }

    return secret;
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  /**
   * Get a single secret by ID
   */
  async findById(id: string, userId: string): Promise<Secret | null> {
    const secret = await this.db.query.secrets.findFirst({
      where: and(
        eq(secrets.id, id),
        eq(secrets.userId, userId),
        isNull(secrets.deletedAt)
      ),
      with: {
        tags: true,
      },
    });

    return secret ?? null;
  }

  /**
   * List secrets for a user with filters
   */
  async list(userId: string, options: ListSecretsOptions = {}) {
    const conditions = [eq(secrets.userId, userId)];

    if (!options.includeDeleted) {
      conditions.push(isNull(secrets.deletedAt));
    }

    if (options.type) {
      conditions.push(eq(secrets.type, options.type));
    }

    if (options.category) {
      conditions.push(eq(secrets.category, options.category));
    }

    if (options.search) {
      conditions.push(ilike(secrets.name, `%${options.search}%`));
    }

    const result = await this.db.query.secrets.findMany({
      where: and(...conditions),
      with: {
        tags: true,
      },
      orderBy: [desc(secrets.isFavorite), desc(secrets.updatedAt)],
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
    });

    // Filter by tags if specified
    if (options.tags && options.tags.length > 0) {
      return result.filter((secret: Secret & { tags: SecretTag[] }) =>
        options.tags!.some((tag) =>
          secret.tags.some((t: SecretTag) => t.tag === tag)
        )
      );
    }

    return result;
  }

  /**
   * Find secrets by URL (for autofill)
   */
  async findByUrl(userId: string, url: string) {
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;

      return this.db.query.secrets.findMany({
        where: and(
          eq(secrets.userId, userId),
          isNull(secrets.deletedAt),
          sql`${secrets.url} LIKE ${`%${domain}%`}`
        ),
        with: {
          tags: true,
        },
        orderBy: desc(secrets.lastAccessedAt),
      });
    } catch {
      // Invalid URL
      return [];
    }
  }

  /**
   * Get all unique categories for a user
   */
  async getCategories(userId: string): Promise<string[]> {
    const result = await this.db
      .selectDistinct({ category: secrets.category })
      .from(secrets)
      .where(
        and(
          eq(secrets.userId, userId),
          isNull(secrets.deletedAt),
          sql`${secrets.category} IS NOT NULL`
        )
      );

    return result
      .map((r: { category: string | null }) => r.category!)
      .filter(Boolean);
  }

  /**
   * Get all unique tags for a user
   */
  async getTags(userId: string): Promise<string[]> {
    const userSecretIds = this.db
      .select({ id: secrets.id })
      .from(secrets)
      .where(and(eq(secrets.userId, userId), isNull(secrets.deletedAt)));

    const result = await this.db
      .selectDistinct({ tag: secretTags.tag })
      .from(secretTags)
      .where(inArray(secretTags.secretId, userSecretIds));

    return result.map((r: { tag: string }) => r.tag);
  }

  // ==========================================================================
  // Access Tracking
  // ==========================================================================

  /**
   * Record secret access (for analytics and recent items)
   */
  async recordAccess(id: string, userId: string): Promise<void> {
    await this.db
      .update(secrets)
      .set({
        lastAccessedAt: new Date(),
        accessCount: sql`${secrets.accessCount} + 1`,
      })
      .where(eq(secrets.id, id));

    await this.logAudit(id, userId, "read");
  }

  /**
   * Record secret copy to clipboard
   */
  async recordCopy(id: string, userId: string): Promise<void> {
    await this.logAudit(id, userId, "copied");
  }

  // ==========================================================================
  // Sharing
  // ==========================================================================

  /**
   * Share a secret with a user or workspace
   */
  async share(data: ShareSecretInput, userId: string): Promise<SecretShare> {
    // Verify ownership
    const secret = await this.findById(data.secretId, userId);
    if (!secret) {
      throw new Error("Secret not found or access denied");
    }

    const [share] = await this.db
      .insert(secretShares)
      .values({
        secretId: data.secretId,
        sharedWithUserId: data.sharedWithUserId,
        sharedWithWorkspaceId: data.sharedWithWorkspaceId,
        permission: data.permission,
        sharedBy: userId,
        expiresAt: data.expiresAt,
      })
      .returning();

    // Mark secret as shared
    await this.db
      .update(secrets)
      .set({ isShared: true })
      .where(eq(secrets.id, data.secretId));

    await this.logAudit(data.secretId, userId, "shared", {
      sharedWithUserId: data.sharedWithUserId,
      sharedWithWorkspaceId: data.sharedWithWorkspaceId,
      permission: data.permission,
    });

    return share;
  }

  /**
   * Revoke a share
   */
  async revokeShare(shareId: string, userId: string): Promise<void> {
    const share = await this.db.query.secretShares.findFirst({
      where: eq(secretShares.id, shareId),
      with: {
        secret: true,
      },
    });

    if (!share || share.secret.userId !== userId) {
      throw new Error("Share not found or access denied");
    }

    await this.db
      .update(secretShares)
      .set({
        revokedAt: new Date(),
        revokedBy: userId,
      })
      .where(eq(secretShares.id, shareId));

    await this.logAudit(share.secretId, userId, "revoked", { shareId });
  }

  /**
   * Get secrets shared with a user
   */
  async getSharedWithMe(userId: string) {
    const shares = await this.db.query.secretShares.findMany({
      where: and(
        eq(secretShares.sharedWithUserId, userId),
        isNull(secretShares.revokedAt)
      ),
      with: {
        secret: {
          with: {
            tags: true,
          },
        },
      },
    });

    return shares.filter(
      (share: SecretShare & { secret: Secret }) =>
        !share.secret.deletedAt &&
        (!share.expiresAt || new Date(share.expiresAt) > new Date())
    );
  }

  // ==========================================================================
  // Audit Log
  // ==========================================================================

  /**
   * Log an audit event
   */
  async logAudit(
    secretId: string,
    userId: string,
    action: SecretAuditAction,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.db.insert(secretAuditLog).values({
      secretId,
      userId,
      action,
      metadata,
    });
  }

  /**
   * Get audit log for a secret
   */
  async getAuditLog(secretId: string, userId: string, limit = 50) {
    // Verify ownership
    const secret = await this.findById(secretId, userId);
    if (!secret) {
      throw new Error("Secret not found or access denied");
    }

    return this.db.query.secretAuditLog.findMany({
      where: eq(secretAuditLog.secretId, secretId),
      orderBy: desc(secretAuditLog.createdAt),
      limit,
    });
  }

  // ==========================================================================
  // Security
  // ==========================================================================

  /**
   * Mark a secret as compromised (e.g., found in breach database)
   */
  async markCompromised(id: string, userId: string): Promise<void> {
    await this.db
      .update(secrets)
      .set({
        isCompromised: true,
        compromisedAt: new Date(),
      })
      .where(and(eq(secrets.id, id), eq(secrets.userId, userId)));
  }

  /**
   * Get compromised secrets count
   */
  async getCompromisedCount(userId: string): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(secrets)
      .where(
        and(
          eq(secrets.userId, userId),
          eq(secrets.isCompromised, true),
          isNull(secrets.deletedAt)
        )
      );

    return result[0]?.count ?? 0;
  }

  /**
   * Get weak passwords count (strength < 3)
   */
  async getWeakPasswordsCount(userId: string): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(secrets)
      .where(
        and(
          eq(secrets.userId, userId),
          eq(secrets.type, "password"),
          sql`${secrets.passwordStrength} < 3`,
          isNull(secrets.deletedAt)
        )
      );

    return result[0]?.count ?? 0;
  }

  /**
   * Get secrets with old passwords (not changed in X days)
   */
  async getOldPasswordsCount(userId: string, days = 90): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(secrets)
      .where(
        and(
          eq(secrets.userId, userId),
          eq(secrets.type, "password"),
          sql`${secrets.passwordLastChanged} < ${cutoff}`,
          isNull(secrets.deletedAt)
        )
      );

    return result[0]?.count ?? 0;
  }
}
