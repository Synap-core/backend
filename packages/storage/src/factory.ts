/**
 * Storage Factory - Provider Selection
 *
 * Creates the appropriate storage provider based on environment configuration.
 *
 * Supported providers:
 * - "r2" (default): Cloudflare R2 (production)
 * - "minio": MinIO (local development)
 *
 * Uses centralized config from @synap-core/core for type-safe configuration.
 */

import type { IFileStorage } from "./interface.js";
import { R2StorageProvider, type R2Config } from "./r2-provider.js";
import { MinIOStorageProvider, type MinIOConfig } from "./minio-provider.js";
import { ValidationError, InternalServerError } from "@synap-core/types";

// Import config using dynamic import to avoid circular dependencies
// This will be resolved when the module loads
let _config: (typeof import("@synap-core/core"))["config"] | null = null;
let _configPromise: Promise<
  (typeof import("@synap-core/core"))["config"]
> | null = null;

async function loadConfig(): Promise<
  (typeof import("@synap-core/core"))["config"]
> {
  if (!_configPromise) {
    _configPromise = import("@synap-core/core").then((module) => {
      _config = module.config;
      return module.config;
    });
  }
  return _configPromise;
}

function getConfig(): (typeof import("@synap-core/core"))["config"] {
  if (_config) {
    return _config;
  }
  // If config isn't loaded yet, we need to load it synchronously
  // This is a fallback - in practice config should be loaded before this is called
  throw new InternalServerError(
    "Config not loaded. Please ensure @synap-core/core is imported before using storage.",
  );
}

/**
 * Create storage provider based on environment configuration
 *
 * @returns Configured storage provider instance
 * @throws Error if required environment variables are missing
 *
 * @example
 * ```typescript
 * const storage = createFileStorageProvider();
 * await storage.upload('path/to/file.md', 'content');
 * ```
 */
export function createFileStorageProvider(): IFileStorage {
  const config = getConfig();
  const provider = config.storage.provider;

  switch (provider) {
    case "r2": {
      // Validate R2 configuration
      if (
        !config.storage.r2AccountId ||
        !config.storage.r2AccessKeyId ||
        !config.storage.r2SecretAccessKey
      ) {
        throw new ValidationError(
          "R2 storage requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY environment variables",
          { provider: "r2" },
        );
      }

      const r2Config: R2Config = {
        accountId: config.storage.r2AccountId,
        accessKeyId: config.storage.r2AccessKeyId,
        secretAccessKey: config.storage.r2SecretAccessKey,
        bucketName: config.storage.r2BucketName,
        publicUrl: config.storage.r2PublicUrl,
      };

      return new R2StorageProvider(r2Config);
    }

    case "minio": {
      const minioConfig: MinIOConfig = {
        endpoint: config.storage.minioEndpoint,
        accessKeyId: config.storage.minioAccessKeyId,
        secretAccessKey: config.storage.minioSecretAccessKey,
        bucketName: config.storage.minioBucketName,
        publicUrl: config.storage.minioPublicUrl,
        createBucketIfNotExists: true,
        forcePathStyle: true,
      };

      return new MinIOStorageProvider(minioConfig);
    }

    default:
      throw new ValidationError(
        `Unknown storage provider: ${provider}. Supported providers: "r2", "minio"`,
        { provider },
      );
  }
}

/**
 * Default storage instance (singleton)
 *
 * Created on first access using environment variables.
 * Uses lazy initialization to handle async config loading.
 *
 * @example
 * ```typescript
 * import { storage } from '@synap/storage';
 * await storage.upload('path/to/file.md', 'content');
 * ```
 */
let _storageInstance: IFileStorage | null = null;
let _initPromise: Promise<IFileStorage> | null = null;

// Initialize storage - will be called on first access
async function initStorage(): Promise<IFileStorage> {
  if (_storageInstance) {
    return _storageInstance;
  }
  if (!_initPromise) {
    _initPromise = loadConfig().then(() => createFileStorageProvider());
    _storageInstance = await _initPromise;
  } else {
    _storageInstance = await _initPromise;
  }
  return _storageInstance;
}

// Export storage with lazy initialization
// For synchronous methods like buildPath, we initialize immediately if possible
export const storage: IFileStorage = new Proxy({} as IFileStorage, {
  get(_target, prop) {
    // Try to get config synchronously first (if already loaded)
    if (!_config) {
      // Config not loaded - return async function
      return async (...args: unknown[]) => {
        const instance = await initStorage();
        const method = (instance as unknown as Record<string, unknown>)[
          prop as string
        ];
        if (typeof method === "function") {
          return method.apply(instance, args);
        }
        return method;
      };
    }

    // Config is loaded - can create instance synchronously
    if (!_storageInstance) {
      _storageInstance = createFileStorageProvider();
    }

    const value = (_storageInstance as unknown as Record<string, unknown>)[
      prop as string
    ];
    if (typeof value === "function") {
      return value.bind(_storageInstance);
    }
    return value;
  },
}) as IFileStorage;

// Pre-initialize config in the background
loadConfig().catch(() => {
  // Config will be loaded on first access
});
