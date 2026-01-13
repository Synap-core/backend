/**
 * MinIO Storage Provider
 *
 * Implements IFileStorage using MinIO (local S3-compatible server).
 *
 * MinIO is perfect for local-first development:
 * - Runs in Docker container
 * - Uses local folder as storage backend
 * - 100% S3-compatible API
 * - Zero cloud dependencies
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  IFileStorage,
  FileMetadata,
  UploadOptions,
  FileInfo,
} from "./interface.js";
import { calculateFileChecksum, buildEntityPath } from "./utils.js";

export interface MinIOConfig {
  /** MinIO endpoint URL (e.g., "http://localhost:9000") */
  endpoint: string;
  /** MinIO access key */
  accessKeyId: string;
  /** MinIO secret key */
  secretAccessKey: string;
  /** Bucket name */
  bucketName: string;
  /** Public URL base (optional, for local dev: "http://localhost:9000") */
  publicUrl?: string;
  /** Whether to create bucket if it doesn't exist (default: true) */
  createBucketIfNotExists?: boolean;
  /** Region (default: "us-east-1") */
  region?: string;
  /** Use path-style addressing (default: true for MinIO) */
  forcePathStyle?: boolean;
}

/**
 * MinIO Storage Provider
 *
 * Uses AWS SDK to communicate with local MinIO server.
 * Automatically creates bucket on first use if configured.
 */
export class MinIOStorageProvider implements IFileStorage {
  private client: S3Client;
  private bucketName: string;
  private publicUrl: string;
  private createBucketIfNotExists: boolean;
  private bucketInitialized: boolean = false;

  constructor(config: MinIOConfig) {
    this.client = new S3Client({
      region: config.region || "us-east-1",
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle !== false, // MinIO requires path-style
    });

    this.bucketName = config.bucketName;
    this.publicUrl = config.publicUrl || config.endpoint;
    this.createBucketIfNotExists = config.createBucketIfNotExists !== false;
  }

  /**
   * Ensure bucket exists (called before first operation)
   */
  private async ensureBucket(): Promise<void> {
    if (this.bucketInitialized) {
      return;
    }

    try {
      // Check if bucket exists
      await this.client.send(
        new HeadBucketCommand({
          Bucket: this.bucketName,
        }),
      );
      this.bucketInitialized = true;
      return;
    } catch (error) {
      // Bucket doesn't exist
      if (this.createBucketIfNotExists) {
        try {
          // Create bucket
          await this.client.send(
            new CreateBucketCommand({
              Bucket: this.bucketName,
            }),
          );
          this.bucketInitialized = true;
        } catch (createError) {
          throw new Error(
            `Failed to create MinIO bucket "${this.bucketName}": ${createError instanceof Error ? createError.message : "Unknown error"}`,
          );
        }
      } else {
        throw new Error(
          `MinIO bucket "${this.bucketName}" does not exist. Set createBucketIfNotExists=true or create it manually.`,
        );
      }
    }
  }

  async upload(
    path: string,
    content: string | Buffer,
    options?: UploadOptions,
  ): Promise<FileMetadata> {
    await this.ensureBucket();

    const body =
      typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    const checksum = calculateFileChecksum(body);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: path,
        Body: body,
        ContentType: options?.contentType || "application/octet-stream",
        Metadata: options?.metadata,
      }),
    );

    // For MinIO, public URL is endpoint + bucket + path
    // In local dev, this might be http://localhost:9000/bucket-name/path
    const url = `${this.publicUrl}/${this.bucketName}/${path}`;

    return {
      url,
      path,
      size: body.length,
      checksum: `sha256:${checksum}`,
      uploadedAt: new Date(),
    };
  }

  async download(path: string): Promise<string> {
    await this.ensureBucket();

    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      }),
    );

    if (!response.Body) {
      throw new Error(`File not found: ${path}`);
    }

    return await response.Body.transformToString();
  }

  async downloadBuffer(path: string): Promise<Buffer> {
    await this.ensureBucket();

    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      }),
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
    await this.ensureBucket();

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      }),
    );
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureBucket();

    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: path,
        }),
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  async getMetadata(path: string): Promise<FileInfo> {
    await this.ensureBucket();

    const response = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      }),
    );

    return {
      size: response.ContentLength || 0,
      lastModified: response.LastModified || new Date(),
      contentType: response.ContentType || "application/octet-stream",
    };
  }

  async getSignedUrl(path: string, expiresIn: number = 3600): Promise<string> {
    await this.ensureBucket();

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: path,
    });

    return await getSignedUrl(this.client, command, { expiresIn });
  }

  buildPath(
    userId: string,
    entityType: string,
    entityId: string,
    extension: string = "md",
  ): string {
    return buildEntityPath(userId, entityType, entityId, extension);
  }
}
