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
  SignedUploadOptions,
} from "./interface.js";
import { StorageUploadUnavailableError } from "./interface.js";
import { buildEntityPath } from "./utils.js";
import { fileChecksum } from "./checksum.js";

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
  /**
   * Signs URLs handed to CLIENTS, against the configured PUBLIC endpoint.
   *
   * SigV4 signs the `host` header, so a URL signed by `client` (endpoint
   * `http://minio:9000`, the compose-internal host) names a host no browser or
   * CLI can resolve — and rewriting the host afterwards breaks the signature.
   * A second client, configured with `publicUrl`, signs for the host the
   * client will actually call; the edge proxy forwards `/<bucket>/*` to MinIO's
   * S3 API (port 9000) with the Host header preserved, so MinIO recomputes the
   * same signature. `null` = no public URL configured: GET signing keeps its
   * historical internal-host behavior and upload presigning refuses (typed).
   * Signing is local (no network call), so this client never talks to MinIO.
   */
  private publicSigner: S3Client | null;
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

    this.publicSigner = config.publicUrl
      ? new S3Client({
          region: config.region || "us-east-1",
          endpoint: config.publicUrl,
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
          forcePathStyle: config.forcePathStyle !== false,
        })
      : null;

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
        })
      );
      this.bucketInitialized = true;
      return;
    } catch {
      // Bucket doesn't exist
      if (this.createBucketIfNotExists) {
        try {
          // Create bucket
          await this.client.send(
            new CreateBucketCommand({
              Bucket: this.bucketName,
            })
          );
          this.bucketInitialized = true;
        } catch (createError) {
          throw new Error(
            `Failed to create MinIO bucket "${this.bucketName}": ${createError instanceof Error ? createError.message : "Unknown error"}`
          );
        }
      } else {
        throw new Error(
          `MinIO bucket "${this.bucketName}" does not exist. Set createBucketIfNotExists=true or create it manually.`
        );
      }
    }
  }

  async upload(
    path: string,
    content: string | Buffer,
    options?: UploadOptions
  ): Promise<FileMetadata> {
    await this.ensureBucket();

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

    // For MinIO, public URL is endpoint + bucket + path
    // In local dev, this might be http://localhost:9000/bucket-name/path
    const url = await this.objectUrl(path);

    return {
      url,
      path,
      size: body.length,
      checksum: fileChecksum(body),
      uploadedAt: new Date(),
    };
  }

  async download(path: string): Promise<string> {
    await this.ensureBucket();

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
    await this.ensureBucket();

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
    await this.ensureBucket();

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      })
    );
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureBucket();

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
    await this.ensureBucket();

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
    await this.ensureBucket();

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: path,
    });

    return await getSignedUrl(this.publicSigner ?? this.client, command, {
      expiresIn,
    });
  }

  async objectUrl(path: string): Promise<string> {
    return `${this.publicUrl}/${this.bucketName}/${path}`;
  }

  async getSignedUploadUrl(
    path: string,
    options: SignedUploadOptions
  ): Promise<string> {
    if (!this.publicSigner) {
      throw new StorageUploadUnavailableError(
        "MinIO has no public URL configured (MINIO_PUBLIC_URL), so a presigned " +
          "upload URL would name the internal host. Set MINIO_PUBLIC_URL to the " +
          "pod origin and route /<bucket>/* to MinIO :9000."
      );
    }
    await this.ensureBucket();

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: path,
      ContentType: options.contentType,
      ContentLength: options.contentLength,
    });

    return await getSignedUrl(this.publicSigner, command, {
      expiresIn: options.expiresIn ?? 900,
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
