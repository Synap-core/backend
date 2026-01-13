/**
 * API Key Service
 *
 * Hub Protocol V1.0 - Phase 2
 *
 * Service for managing API keys with bcrypt hashing, rotation, and rate limiting.
 * Based on industry best practices from GitHub, Stripe, and AWS.
 */

import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { db, sql as pgSql, drizzleSql as sql } from "@synap/database"; // pgSql = postgres.js, sql = Drizzle
import {
  apiKeys,
  KEY_PREFIXES,
  type ApiKeyRecord,
  type ApiKeyScope,
} from "@synap/database";
import { eq, and, or, isNull, gt } from "@synap/database";

/**
 * Bcrypt cost factor
 * Cost 12 = ~200ms validation time (good balance security/performance)
 */
const BCRYPT_COST_FACTOR = 12;

/**
 * Default rotation period (90 days)
 */
const DEFAULT_ROTATION_DAYS = 90;

/**
 * Rate limiting configuration
 */
const RATE_LIMITS = {
  generate: { limit: 10, window: 60000 }, // 10/min
  request: { limit: 100, window: 60000 }, // 100/min
  submit: { limit: 50, window: 60000 }, // 50/min
} as const;

/**
 * Rate limiter storage (in-memory, can be replaced with Redis)
 */
const rateLimiter = new Map<string, { count: number; resetAt: number }>();

/**
 * API Key Service
 */
export class ApiKeyService {
  /**
   * Generate a new API key
   *
   * @param userId - User ID who owns the key
   * @param keyName - User-friendly name for the key
   * @param scope - Array of permissions
   * @param hubId - Optional Hub ID (for Hub keys)
   * @param expiresInDays - Optional expiration in days
   * @returns The generated key and key ID
   *
   * @example
   * const { key, keyId } = await apiKeyService.generateApiKey(
   *   'user123',
   *   'Production Hub Key',
   *   ['preferences', 'notes', 'tasks'],
   *   'synap-hub-prod',
   *   90
   * );
   *
   * // ⚠️ Display the key to the user ONCE
   * console.log('Your API key:', key);
   */
  async generateApiKey(
    userId: string,
    keyName: string,
    scope: ApiKeyScope[],
    hubId?: string,
    expiresInDays?: number,
  ): Promise<{ key: string; keyId: string }> {
    // 1. Generate random key
    const randomPart = randomBytes(32).toString("base64url");

    // 2. Determine prefix based on hubId
    let prefix: string;
    if (hubId) {
      // Hub key (use live by default, test if hubId contains 'test' or 'dev')
      const isTest = hubId.includes("test") || hubId.includes("dev");
      prefix = isTest ? KEY_PREFIXES.HUB_TEST : KEY_PREFIXES.HUB_LIVE;
    } else {
      // User key
      prefix = KEY_PREFIXES.USER;
    }

    const fullKey = `${prefix}${randomPart}`;

    // 3. Hash with bcrypt
    const keyHash = await bcrypt.hash(fullKey, BCRYPT_COST_FACTOR);

    // 4. Calculate expiration and rotation dates
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const rotationScheduledAt = new Date(
      Date.now() + DEFAULT_ROTATION_DAYS * 24 * 60 * 60 * 1000,
    );

    // 5. Store in database
    const [keyRecord] = await db
      .insert(apiKeys)
      .values({
        userId,
        keyName,
        keyPrefix: prefix,
        keyHash,
        hubId: hubId || null,
        scope,
        expiresAt,
        rotationScheduledAt,
        isActive: true,
        createdBy: userId,
      })
      .returning({ id: apiKeys.id });

    // 6. Return the key (⚠️ displayed ONCE)
    return {
      key: fullKey,
      keyId: keyRecord.id,
    };
  }

  /**
   * Validate an API key
   *
   * Checks if the key is valid, active, and not expired.
   * Updates last_used_at and usage_count.
   *
   * @param apiKey - The full API key to validate
   * @returns The key record if valid, null otherwise
   */
  async validateApiKey(apiKey: string): Promise<ApiKeyRecord | null> {
    // 1. Extract prefix
    const prefix = this.extractPrefix(apiKey);
    if (!prefix) {
      return null;
    }

    // 2. Find active keys with this prefix
    const candidates = await db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.keyPrefix, prefix),
          eq(apiKeys.isActive, true),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
        ),
      );

    // 3. Compare hash for each candidate
    for (const candidate of candidates) {
      const isValid = await bcrypt.compare(apiKey, candidate.keyHash);
      if (isValid) {
        // 4. Update last_used_at and usage_count
        await db
          .update(apiKeys)
          .set({
            lastUsedAt: new Date(),
            usageCount: sql`${apiKeys.usageCount} + 1`,
          })
          .where(eq(apiKeys.id, candidate.id));

        return candidate;
      }
    }

    return null;
  }

  /**
   * Revoke an API key
   *
   * @param keyId - Key ID to revoke
   * @param userId - User ID performing the revocation
   * @param reason - Optional reason for revocation
   */
  async revokeApiKey(
    keyId: string,
    userId: string,
    reason?: string,
  ): Promise<void> {
    await db
      .update(apiKeys)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedBy: userId,
        revokedReason: reason || "Revoked by user",
      })
      .where(eq(apiKeys.id, keyId));
  }

  /**
   * Rotate an API key
   *
   * Creates a new key with the same properties and revokes the old one.
   *
   * @param keyId - Key ID to rotate
   * @param userId - User ID performing the rotation
   * @returns The new key and key ID
   */
  async rotateApiKey(
    keyId: string,
    userId: string,
  ): Promise<{ newKey: string; newKeyId: string }> {
    // 1. Get the existing key
    const [existingKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId));

    if (!existingKey) {
      throw new Error("API key not found");
    }

    if (!existingKey.isActive) {
      throw new Error("Cannot rotate an inactive key");
    }

    // 2. Generate new key with same properties
    const { key: newKey, keyId: newKeyId } = await this.generateApiKey(
      existingKey.userId,
      `${existingKey.keyName} (rotated)`,
      existingKey.scope as ApiKeyScope[],
      existingKey.hubId || undefined,
      existingKey.expiresAt
        ? Math.ceil(
            (existingKey.expiresAt.getTime() - Date.now()) /
              (24 * 60 * 60 * 1000),
          )
        : undefined,
    );

    // 3. Update new key to link to old key
    await db
      .update(apiKeys)
      .set({
        rotatedFromId: keyId,
      })
      .where(eq(apiKeys.id, newKeyId));

    // 4. Revoke the old key
    await this.revokeApiKey(keyId, userId, "Rotated to new key");

    return {
      newKey,
      newKeyId,
    };
  }

  /**
   * List API keys for a user
   *
   * @param userId - User ID
   * @returns Array of key records (without the hash)
   */
  async listUserKeys(userId: string): Promise<ApiKeyRecord[]> {
    return db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .orderBy(sql`${apiKeys.createdAt} DESC`);
  }

  /**
   * Check rate limit for an API key
   *
   * @param keyId - Key ID
   * @param action - Action type ('generate', 'request', or 'submit')
   * @returns true if within limit, false if exceeded
   */
  checkRateLimit(
    keyId: string,
    action: "generate" | "request" | "submit",
  ): boolean {
    const config = RATE_LIMITS[action];
    const now = Date.now();
    const cacheKey = `${keyId}:${action}`;

    const record = rateLimiter.get(cacheKey);

    if (!record || now > record.resetAt) {
      // Start new window
      rateLimiter.set(cacheKey, { count: 1, resetAt: now + config.window });
      return true;
    }

    if (record.count >= config.limit) {
      // Rate limit exceeded
      return false;
    }

    // Increment counter
    record.count++;
    return true;
  }

  /**
   * Extract prefix from API key
   *
   * @param apiKey - Full API key
   * @returns Prefix or null if invalid
   */
  private extractPrefix(apiKey: string): string | null {
    const prefixes = Object.values(KEY_PREFIXES) as string[];
    for (const prefix of prefixes) {
      if (apiKey.startsWith(prefix)) {
        return prefix;
      }
    }
    return null;
  }

  /**
   * Clean up expired keys
   *
   * Should be run periodically (e.g., daily cron job).
   *
   * @returns Number of keys cleaned up
   */
  async cleanupExpiredKeys(): Promise<number> {
    const result =
      await pgSql`SELECT cleanup_expired_api_keys() as cleanup_expired_api_keys`;
    return result[0]?.cleanup_expired_api_keys ?? 0;
  }

  /**
   * Get keys scheduled for rotation
   *
   * Returns keys where rotation_scheduled_at is in the past.
   *
   * @returns Array of key records that should be rotated
   */
  async getKeysScheduledForRotation(): Promise<ApiKeyRecord[]> {
    return db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.isActive, true),
          sql`${apiKeys.rotationScheduledAt} < NOW()`,
        ),
      );
  }
}

/**
 * Singleton instance
 */
export const apiKeyService = new ApiKeyService();
