/**
 * Cloudflare R2 Storage Provider
 *
 * Implements IFileStorage using Cloudflare R2 (S3-compatible).
 *
 * R2 is production-ready with:
 * - Zero egress fees
 * - S3-compatible API
 * - 15x cheaper than PostgreSQL storage
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  IFileStorage,
  FileMetadata,
  UploadOptions,
  FileInfo,
  SignedUploadOptions,
} from "./interface.js";
import { buildEntityPath } from "./utils.js";
import { fileChecksum } from "./checksum.js";

export interface R2Config {
  /** Cloudflare account ID */
  accountId: string;
  /** R2 access key ID */
  accessKeyId: string;
  /** R2 secret access key */
  secretAccessKey: string;
  /** R2 bucket name */
  bucketName: string;
  /** Public URL base (optional, defaults to r2.dev) */
  publicUrl?: string;
}

/**
 * Cloudflare R2 Storage Provider
 *
 * Uses AWS SDK with custom endpoint to communicate with R2.
 */
export class R2StorageProvider implements IFileStorage {
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
      // This client also presigns upload URLs (getSignedUploadUrl). With the
      // SDK's default flexible checksums a presigned PUT carries the CRC32 of
      // the EMPTY body, so every real PUT is refused. Checksum only when an
      // operation requires one.
      requestChecksumCalculation: "WHEN_REQUIRED",
    });

    this.bucketName = config.bucketName;
    this.publicUrl = config.publicUrl || `https://${config.bucketName}.r2.dev`;
  }

  async upload(
    path: string,
    content: string | Buffer,
    options?: UploadOptions
  ): Promise<FileMetadata> {
    const body =
      typeof content === "string" ? Buffer.from(content, "utf-8") : content;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: path,
        Body: body,
        ContentType: options?.contentType || "application/octet-stream",
        Metadata: options?.metadata,
      })
    );

    return {
      url: await this.objectUrl(path),
      path,
      size: body.length,
      checksum: fileChecksum(body),
      uploadedAt: new Date(),
    };
  }

  async download(path: string): Promise<string> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      })
    );

    if (!response.Body) {
      throw new Error(`File not found: ${path}`);
    }

    return await response.Body.transformToString();
  }

  async downloadBuffer(path: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      })
    );

    if (!response.Body) {
      throw new Error(`File not found: ${path}`);
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }

  async delete(path: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      })
    );
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: path,
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async getMetadata(path: string): Promise<FileInfo> {
    const response = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      })
    );

    return {
      size: response.ContentLength || 0,
      lastModified: response.LastModified || new Date(),
      contentType: response.ContentType || "application/octet-stream",
    };
  }

  async getSignedUrl(path: string, expiresIn: number = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: path,
    });

    return await getSignedUrl(this.client, command, { expiresIn });
  }

  async objectUrl(path: string): Promise<string> {
    return `${this.publicUrl}/${path}`;
  }

  /** R2's S3 endpoint is public, so the URL it signs is client-reachable. */
  async getSignedUploadUrl(
    path: string,
    options: SignedUploadOptions
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: path,
      ContentType: options.contentType,
      ContentLength: options.contentLength,
    });

    return await getSignedUrl(this.client, command, {
      expiresIn: options.expiresIn ?? 900,
      // Content-Length is signed by default; Content-Type is not unless asked.
      signableHeaders: new Set(["content-type"]),
    });
  }

  buildPath(
    userId: string,
    entityType: string,
    entityId: string,
    extension: string = "md"
  ): string {
    return buildEntityPath(userId, entityType, entityId, extension);
  }
}
