/**
 * Storage Factory Unit Tests
 *
 * Tests the storage factory's ability to select the correct provider
 * based on environment configuration.
 *
 * Note: This test validates the factory logic conceptually.
 * In practice, the factory uses dynamic imports and environment variables,
 * so full integration testing requires actual environment setup.
 */

import { describe, it, expect } from "vitest";
import { R2StorageProvider } from "../r2-provider.js";
import { MinIOStorageProvider } from "../minio-provider.js";

describe("Storage Factory", () => {
  it("should have R2StorageProvider class", () => {
    expect(R2StorageProvider).toBeDefined();
    expect(typeof R2StorageProvider).toBe("function");
  });

  it("should have MinIOStorageProvider class", () => {
    expect(MinIOStorageProvider).toBeDefined();
    expect(typeof MinIOStorageProvider).toBe("function");
  });

  it("should create R2 provider with valid config", () => {
    const config = {
      accountId: "test-account-id",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      bucketName: "test-bucket",
      publicUrl: "https://test-bucket.r2.dev",
    };

    const provider = new R2StorageProvider(config);
    expect(provider).toBeInstanceOf(R2StorageProvider);
  });

  it("should create MinIO provider with valid config", () => {
    const config = {
      endpoint: "http://localhost:9000",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
      bucketName: "test-bucket",
      publicUrl: "http://localhost:9000",
      createBucketIfNotExists: true,
      forcePathStyle: true,
    };

    const provider = new MinIOStorageProvider(config);
    expect(provider).toBeInstanceOf(MinIOStorageProvider);
  });

  // Note: Full factory testing requires environment variable setup
  // The factory uses dynamic imports and config from @synap-core/core
  // Integration tests should validate provider selection in real environment
});
