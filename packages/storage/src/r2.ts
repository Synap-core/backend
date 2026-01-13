/**
 * Cloudflare R2 Storage Client
 *
 * R2 is S3-compatible object storage with zero egress fees.
 * We use AWS SDK with a custom endpoint.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "crypto";

// ============================================================================
// TYPES
// ============================================================================

export interface FileMetadata {
  url: string;
  path: string;
  size: number;
  checksum: string;
  uploadedAt: Date;
}

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl?: string;
}

// ============================================================================
// R2 STORAGE CLASS
// ============================================================================

export class R2Storage {
  private client: S3Client;
  private bucketName: string;
  private publicUrl: string;

  constructor(config: R2Config) {
    this.client = new S3Client({
      region: "auto", // R2 uses 'auto' region
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    this.bucketName = config.bucketName;
    this.publicUrl = config.publicUrl || `https://${config.bucketName}.r2.dev`;
  }

  // ==========================================================================
  // UPLOAD
  // ==========================================================================

  /**
   * Upload file to R2
   *
   * @example
   * ```typescript
   * const result = await r2.upload(
   *   'users/123/notes/456.md',
   *   'Note content',
   *   { contentType: 'text/markdown' }
   * );
   * console.log(result.url); // https://r2.../users/123/notes/456.md
   * ```
   */
  async upload(
    key: string,
    content: string | Buffer,
    options?: UploadOptions,
  ): Promise<FileMetadata> {
    const body =
      typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    const checksum = this.calculateChecksum(body);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: options?.contentType || "application/octet-stream",
        Metadata: options?.metadata,
      }),
    );

    return {
      url: `${this.publicUrl}/${key}`,
      path: key,
      size: body.length,
      checksum: `sha256:${checksum}`,
      uploadedAt: new Date(),
    };
  }

  // ==========================================================================
  // DOWNLOAD
  // ==========================================================================

  /**
   * Download file as string
   *
   * @example
   * ```typescript
   * const content = await r2.download('users/123/notes/456.md');
   * console.log(content); // "Note content"
   * ```
   */
  async download(key: string): Promise<string> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error(`File not found: ${key}`);
    }

    return await response.Body.transformToString();
  }

  /**
   * Download file as Buffer (for binary files)
   */
  async downloadBuffer(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error(`File not found: ${key}`);
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }

  // ==========================================================================
  // DELETE
  // ==========================================================================

  /**
   * Delete file from R2
   */
  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );
  }

  // ==========================================================================
  // METADATA
  // ==========================================================================

  /**
   * Check if file exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get file metadata without downloading
   */
  async getMetadata(key: string): Promise<{
    size: number;
    lastModified: Date;
    contentType: string;
  }> {
    const response = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    return {
      size: response.ContentLength || 0,
      lastModified: response.LastModified || new Date(),
      contentType: response.ContentType || "application/octet-stream",
    };
  }

  // ==========================================================================
  // SIGNED URLS
  // ==========================================================================

  /**
   * Generate signed URL for temporary access
   *
   * @param expiresIn - Expiration time in seconds (default: 1 hour)
   *
   * @example
   * ```typescript
   * const url = await r2.getSignedUrl('private/doc.pdf', 3600);
   * // Valid for 1 hour
   * ```
   */
  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    return await getSignedUrl(this.client, command, { expiresIn });
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /**
   * Calculate SHA256 checksum
   */
  private calculateChecksum(data: Buffer): string {
    return createHash("sha256").update(data).digest("base64");
  }

  /**
   * Build file path for user entity
   *
   * @example
   * ```typescript
   * R2Storage.buildPath('user-123', 'note', 'entity-456', 'md')
   * // Returns: "users/user-123/notes/entity-456.md"
   * ```
   */
  static buildPath(
    userId: string,
    entityType: string,
    entityId: string,
    extension: string = "md",
  ): string {
    return `users/${userId}/${entityType}s/${entityId}.${extension}`;
  }
}

// ============================================================================
// SINGLETON INSTANCE (uses env vars)
// ============================================================================

/**
 * Default R2 instance configured from environment variables
 *
 * Required env vars:
 * - R2_ACCOUNT_ID
 * - R2_ACCESS_KEY_ID
 * - R2_SECRET_ACCESS_KEY
 * - R2_BUCKET_NAME
 * - R2_PUBLIC_URL (optional)
 */
export const r2 = new R2Storage({
  accountId: process.env.R2_ACCOUNT_ID || "",
  accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  bucketName: process.env.R2_BUCKET_NAME || "synap-storage",
  publicUrl: process.env.R2_PUBLIC_URL,
});
