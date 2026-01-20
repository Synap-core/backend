/**
 * MinIO Storage Provider Unit Tests
 *
 * Tests the MinIOStorageProvider implementation using mocks.
 * Validates upload, download, delete, exists, getMetadata, and bucket creation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MinIOStorageProvider, type MinIOConfig } from "../minio-provider.js";
import {
  type S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

// Mock AWS SDK
vi.mock("@aws-sdk/client-s3", () => {
  const mockSend = vi.fn();
  return {
    S3Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
    })),
    PutObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    DeleteObjectCommand: vi.fn(),
    HeadObjectCommand: vi.fn(),
    CreateBucketCommand: vi.fn(),
    HeadBucketCommand: vi.fn(),
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi
    .fn()
    .mockResolvedValue(
      "https://localhost:9000/bucket/file.md?signature=abc123"
    ),
}));

describe("MinIOStorageProvider", () => {
  const config: MinIOConfig = {
    endpoint: "http://localhost:9000",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
    bucketName: "test-bucket",
    publicUrl: "http://localhost:9000",
    createBucketIfNotExists: true,
    forcePathStyle: true,
  };

  let provider: MinIOStorageProvider;
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new MinIOStorageProvider(config);
    const client = (provider as any).client as S3Client;
    mockSend = (client as any).send;
    // Reset bucket initialization flag
    (provider as any).bucketInitialized = false;
  });

  describe("bucket initialization", () => {
    it("should create bucket if it does not exist", async () => {
      const path = "users/123/notes/456.md";
      const content = "# Test Note";

      // First call: bucket doesn't exist
      mockSend
        .mockRejectedValueOnce(new Error("Not found")) // HeadBucketCommand fails
        .mockResolvedValueOnce({}) // CreateBucketCommand succeeds
        .mockResolvedValueOnce({}); // PutObjectCommand succeeds

      await provider.upload(path, content);

      expect(HeadBucketCommand).toHaveBeenCalled();
      expect(CreateBucketCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
      });
    });

    it("should not create bucket if it already exists", async () => {
      const path = "users/123/notes/456.md";
      const content = "# Test Note";

      // Bucket exists
      mockSend
        .mockResolvedValueOnce({}) // HeadBucketCommand succeeds
        .mockResolvedValueOnce({}); // PutObjectCommand succeeds

      await provider.upload(path, content);

      expect(HeadBucketCommand).toHaveBeenCalled();
      expect(CreateBucketCommand).not.toHaveBeenCalled();
    });
  });

  describe("upload", () => {
    it("should upload content successfully", async () => {
      const path = "users/123/notes/456.md";
      const content = "# Test Note\n\nContent here.";

      mockSend
        .mockResolvedValueOnce({}) // HeadBucketCommand
        .mockResolvedValueOnce({}); // PutObjectCommand

      const result = await provider.upload(path, content, {
        contentType: "text/markdown",
      });

      expect(result).toMatchObject({
        path,
        size: expect.any(Number),
        checksum: expect.stringMatching(/^sha256:/),
        uploadedAt: expect.any(Date),
      });
      expect(result.url).toContain("test-bucket");
      expect(PutObjectCommand).toHaveBeenCalled();
    });
  });

  describe("download", () => {
    it("should download file as string", async () => {
      const path = "users/123/notes/456.md";
      const content = "# Test Note\n\nContent here.";

      mockSend
        .mockResolvedValueOnce({}) // HeadBucketCommand
        .mockResolvedValueOnce({
          Body: {
            transformToString: vi.fn().mockResolvedValue(content),
          },
        }); // GetObjectCommand

      const result = await provider.download(path);

      expect(result).toBe(content);
    });
  });

  describe("delete", () => {
    it("should delete file successfully", async () => {
      const path = "users/123/notes/456.md";

      mockSend
        .mockResolvedValueOnce({}) // HeadBucketCommand
        .mockResolvedValueOnce({}); // DeleteObjectCommand

      await provider.delete(path);

      expect(DeleteObjectCommand).toHaveBeenCalled();
    });
  });

  describe("exists", () => {
    it("should return true if file exists", async () => {
      const path = "users/123/notes/456.md";

      mockSend
        .mockResolvedValueOnce({}) // HeadBucketCommand
        .mockResolvedValueOnce({}); // HeadObjectCommand

      const result = await provider.exists(path);

      expect(result).toBe(true);
    });

    it("should return false if file does not exist", async () => {
      const path = "users/123/notes/nonexistent.md";

      mockSend
        .mockResolvedValueOnce({}) // HeadBucketCommand
        .mockRejectedValueOnce(new Error("Not found")); // HeadObjectCommand

      const result = await provider.exists(path);

      expect(result).toBe(false);
    });
  });

  describe("getMetadata", () => {
    it("should return file metadata", async () => {
      const path = "users/123/notes/456.md";
      const lastModified = new Date();

      mockSend
        .mockResolvedValueOnce({}) // HeadBucketCommand
        .mockResolvedValueOnce({
          ContentLength: 1024,
          LastModified: lastModified,
          ContentType: "text/markdown",
        }); // HeadObjectCommand

      const result = await provider.getMetadata(path);

      expect(result).toEqual({
        size: 1024,
        lastModified,
        contentType: "text/markdown",
      });
    });
  });

  describe("buildPath", () => {
    it("should build standardized path", () => {
      const path = provider.buildPath("user-123", "note", "entity-456", "md");

      expect(path).toBe("users/user-123/notes/entity-456.md");
    });
  });
});
