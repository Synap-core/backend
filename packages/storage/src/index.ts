/**
 * @synap/storage - File storage abstractions
 * 
 * Provides unified storage interface for:
 * - Cloudflare R2 (production)
 * - MinIO (local development)
 * - AWS S3 (alternative, via S3-compatible providers)
 * 
 * Usage:
 * ```typescript
 * import { storage } from '@synap/storage';
 * 
 * // Upload
 * const result = await storage.upload('path/to/file.md', 'content');
 * 
 * // Download
 * const content = await storage.download('path/to/file.md');
 * ```
 */

// Export interface and factory (recommended)
export * from './interface.js';
export { createFileStorageProvider, storage } from './factory.js';

// Export providers (for advanced usage)
export { R2StorageProvider, type R2Config } from './r2-provider.js';
export { MinIOStorageProvider, type MinIOConfig } from './minio-provider.js';

// Backward compatibility: Export old R2Storage class
// @deprecated Use IFileStorage interface and createFileStorageProvider() instead
export { R2Storage } from './r2.js';
export { r2 } from './r2.js';

