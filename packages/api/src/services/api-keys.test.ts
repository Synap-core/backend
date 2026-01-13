/**
 * API Key Service - Tests Unitaires
 *
 * Tests pour la gestion des clés API avec bcrypt
 */

import { describe, it, expect, afterEach } from "vitest";
import { apiKeyService } from "./api-keys.js";
import { db } from "@synap/database";
import { apiKeys } from "@synap/database";
import { eq } from "@synap/database";
import bcrypt from "bcrypt";

describe("ApiKeyService", () => {
  const testUserId = "test-user-123";
  const testHubId = "synap-hub-test";

  // Cleanup after each test
  afterEach(async () => {
    await db.delete(apiKeys).where(eq(apiKeys.userId, testUserId));
  });

  describe("generateApiKey", () => {
    it("should generate a valid Hub key with correct prefix", async () => {
      const { key, keyId } = await apiKeyService.generateApiKey(
        testUserId,
        "Test Hub Key",
        ["preferences", "notes"],
        testHubId,
      );

      expect(key).toBeDefined();
      expect(key).toContain("synap_hub_test_");
      expect(keyId).toBeDefined();

      // Verify key was stored in DB
      const [storedKey] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, keyId));

      expect(storedKey).toBeDefined();
      expect(storedKey.userId).toBe(testUserId);
      expect(storedKey.keyPrefix).toBe("synap_hub_test_");
      expect(storedKey.hubId).toBe(testHubId);
      expect(storedKey.scope).toEqual(["preferences", "notes"]);
      expect(storedKey.isActive).toBe(true);

      // Verify hash was created (not plain text)
      expect(storedKey.keyHash).not.toBe(key);
      const isValid = await bcrypt.compare(key, storedKey.keyHash);
      expect(isValid).toBe(true);
    });

    it("should generate a User key with correct prefix when no hubId", async () => {
      const { key, keyId } = await apiKeyService.generateApiKey(
        testUserId,
        "Test User Key",
        ["preferences"],
      );

      expect(key).toContain("synap_user_");

      const [storedKey] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, keyId));

      expect(storedKey.keyPrefix).toBe("synap_user_");
      expect(storedKey.hubId).toBeNull();
    });

    it("should set expiration date when expiresInDays is provided", async () => {
      const { keyId } = await apiKeyService.generateApiKey(
        testUserId,
        "Expiring Key",
        ["preferences"],
        undefined,
        30, // 30 days
      );

      const [storedKey] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, keyId));

      expect(storedKey.expiresAt).toBeDefined();

      // Check that expiration is approximately 30 days from now
      const now = new Date();
      const expected = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const diff = Math.abs(
        storedKey.expiresAt!.getTime() - expected.getTime(),
      );
      expect(diff).toBeLessThan(1000); // Within 1 second
    });

    it("should set rotation scheduled date (90 days)", async () => {
      const { keyId } = await apiKeyService.generateApiKey(
        testUserId,
        "Test Key",
        ["preferences"],
      );

      const [storedKey] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, keyId));

      expect(storedKey.rotationScheduledAt).toBeDefined();

      // Check that rotation is approximately 90 days from now
      const now = new Date();
      const expected = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      const diff = Math.abs(
        storedKey.rotationScheduledAt!.getTime() - expected.getTime(),
      );
      expect(diff).toBeLessThan(1000); // Within 1 second
    });
  });

  describe("validateApiKey", () => {
    it("should validate a correct API key", async () => {
      // Generate key
      const { key, keyId } = await apiKeyService.generateApiKey(
        testUserId,
        "Test Key",
        ["preferences"],
      );

      // Validate
      const validatedKey = await apiKeyService.validateApiKey(key);

      expect(validatedKey).toBeDefined();
      expect(validatedKey!.id).toBe(keyId);
      expect(validatedKey!.userId).toBe(testUserId);
      expect(validatedKey!.isActive).toBe(true);
    });

    it("should return null for invalid API key", async () => {
      const invalidKey = "synap_hub_test_invalidkeyinvalidkeyinvalidkey";
      const validatedKey = await apiKeyService.validateApiKey(invalidKey);

      expect(validatedKey).toBeNull();
    });

    it("should return null for revoked API key", async () => {
      // Generate and revoke key
      const { key, keyId } = await apiKeyService.generateApiKey(
        testUserId,
        "Test Key",
        ["preferences"],
      );

      await apiKeyService.revokeApiKey(keyId, testUserId);

      // Try to validate
      const validatedKey = await apiKeyService.validateApiKey(key);

      expect(validatedKey).toBeNull();
    });

    it("should update last_used_at and usage_count on validation", async () => {
      // Generate key
      const { key, keyId } = await apiKeyService.generateApiKey(
        testUserId,
        "Test Key",
        ["preferences"],
      );

      // Get initial values
      const [initialKey] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, keyId));

      expect(initialKey.lastUsedAt).toBeNull();
      expect(initialKey.usageCount).toBe(0);

      // Validate (first use)
      await apiKeyService.validateApiKey(key);

      // Check updated values
      const [updatedKey] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, keyId));

      expect(updatedKey.lastUsedAt).toBeDefined();
      expect(updatedKey.usageCount).toBe(1);

      // Validate again (second use)
      await apiKeyService.validateApiKey(key);

      const [secondUpdate] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, keyId));

      expect(secondUpdate.usageCount).toBe(2);
    });
  });

  describe("revokeApiKey", () => {
    it("should revoke an API key", async () => {
      // Generate key
      const { keyId } = await apiKeyService.generateApiKey(
        testUserId,
        "Test Key",
        ["preferences"],
      );

      // Revoke
      await apiKeyService.revokeApiKey(keyId, testUserId, "Test revocation");

      // Check DB
      const [revokedKey] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, keyId));

      expect(revokedKey.isActive).toBe(false);
      expect(revokedKey.revokedAt).toBeDefined();
      expect(revokedKey.revokedBy).toBe(testUserId);
      expect(revokedKey.revokedReason).toBe("Test revocation");
    });
  });

  describe("rotateApiKey", () => {
    it("should create a new key and revoke the old one", async () => {
      // Generate original key
      const { key: oldKey, keyId: oldKeyId } =
        await apiKeyService.generateApiKey(
          testUserId,
          "Original Key",
          ["preferences", "notes"],
          testHubId,
        );

      // Rotate
      const { newKey, newKeyId } = await apiKeyService.rotateApiKey(
        oldKeyId,
        testUserId,
      );

      // Verify new key
      expect(newKey).toBeDefined();
      expect(newKey).not.toBe(oldKey);
      expect(newKeyId).not.toBe(oldKeyId);

      const [newKeyRecord] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, newKeyId));

      expect(newKeyRecord.isActive).toBe(true);
      expect(newKeyRecord.rotatedFromId).toBe(oldKeyId);
      expect(newKeyRecord.scope).toEqual(["preferences", "notes"]);
      expect(newKeyRecord.hubId).toBe(testHubId);

      // Verify old key is revoked
      const [oldKeyRecord] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, oldKeyId));

      expect(oldKeyRecord.isActive).toBe(false);
      expect(oldKeyRecord.revokedReason).toContain("Rotated");
    });

    it("should throw error if key not found", async () => {
      await expect(
        apiKeyService.rotateApiKey(
          "00000000-0000-0000-0000-000000000000",
          testUserId,
        ),
      ).rejects.toThrow("API key not found");
    });

    it("should throw error if key is already inactive", async () => {
      // Generate and revoke key
      const { keyId } = await apiKeyService.generateApiKey(
        testUserId,
        "Test Key",
        ["preferences"],
      );

      await apiKeyService.revokeApiKey(keyId, testUserId);

      // Try to rotate
      await expect(
        apiKeyService.rotateApiKey(keyId, testUserId),
      ).rejects.toThrow("Cannot rotate an inactive key");
    });
  });

  describe("listUserKeys", () => {
    it("should list all keys for a user", async () => {
      // Generate multiple keys
      await apiKeyService.generateApiKey(testUserId, "Key 1", ["preferences"]);
      await apiKeyService.generateApiKey(testUserId, "Key 2", ["notes"]);
      await apiKeyService.generateApiKey(testUserId, "Key 3", ["tasks"]);

      // List
      const keys = await apiKeyService.listUserKeys(testUserId);

      expect(keys).toHaveLength(3);
      expect(keys[0].keyName).toBe("Key 3"); // Most recent first
      expect(keys[1].keyName).toBe("Key 2");
      expect(keys[2].keyName).toBe("Key 1");
    });

    it("should return empty array if no keys", async () => {
      const keys = await apiKeyService.listUserKeys("non-existent-user");
      expect(keys).toHaveLength(0);
    });
  });

  describe("checkRateLimit", () => {
    it("should allow requests within limit", () => {
      const keyId = "test-key-id";

      // First request should pass
      expect(apiKeyService.checkRateLimit(keyId, "generate")).toBe(true);

      // Second request should pass
      expect(apiKeyService.checkRateLimit(keyId, "generate")).toBe(true);
    });

    it("should block requests exceeding limit", () => {
      const keyId = "test-key-id-2";

      // Make 10 requests (limit for 'generate')
      for (let i = 0; i < 10; i++) {
        expect(apiKeyService.checkRateLimit(keyId, "generate")).toBe(true);
      }

      // 11th request should fail
      expect(apiKeyService.checkRateLimit(keyId, "generate")).toBe(false);
    });

    it("should reset limit after window", async () => {
      const keyId = "test-key-id-3";

      // Make 10 requests (limit for 'generate')
      for (let i = 0; i < 10; i++) {
        apiKeyService.checkRateLimit(keyId, "generate");
      }

      // Should be blocked
      expect(apiKeyService.checkRateLimit(keyId, "generate")).toBe(false);

      // Wait for window to reset (61 seconds)
      await new Promise((resolve) => setTimeout(resolve, 61000));

      // Should work again
      expect(apiKeyService.checkRateLimit(keyId, "generate")).toBe(true);
    }, 70000); // Set timeout to 70 seconds for this test
  });
});
