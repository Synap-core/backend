/**
 * R2 Storage Provider Unit Tests
 * 
 * Tests the R2StorageProvider implementation using mocks.
 * Validates upload, download, delete, exists, getMetadata, and getSignedUrl operations.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { R2StorageProvider, type R2Config } from '../r2-provider.js';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

// Mock AWS SDK
vi.mock('@aws-sdk/client-s3', () => {
  const mockSend = vi.fn();
  return {
    S3Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
    })),
    PutObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    DeleteObjectCommand: vi.fn(),
    HeadObjectCommand: vi.fn(),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com/file.md?signature=abc123'),
}));

describe('R2StorageProvider', () => {
  const config: R2Config = {
    accountId: 'test-account-id',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    bucketName: 'test-bucket',
    publicUrl: 'https://test-bucket.r2.dev',
  };

  let provider: R2StorageProvider;
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new R2StorageProvider(config);
    // Get the mock send function from the S3Client instance
    const client = (provider as any).client as S3Client;
    mockSend = (client as any).send;
  });

  describe('upload', () => {
    it('should upload string content successfully', async () => {
      const content = '# Test Note\n\nThis is test content.';
      const path = 'users/123/notes/456.md';

      mockSend.mockResolvedValue({});

      const result = await provider.upload(path, content, {
        contentType: 'text/markdown',
      });

      expect(result).toMatchObject({
        path,
        size: expect.any(Number),
        checksum: expect.stringMatching(/^sha256:/),
        uploadedAt: expect.any(Date),
      });
      expect(result.url).toBe('https://test-bucket.r2.dev/users/123/notes/456.md');
      expect(result.size).toBeGreaterThan(0);
      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: 'test-bucket',
          Key: path,
          Body: expect.any(Buffer),
          ContentType: 'text/markdown',
        })
      );
    });

    it('should upload Buffer content successfully', async () => {
      const content = Buffer.from('Binary content');
      const path = 'users/123/files/binary.bin';

      mockSend.mockResolvedValue({});

      const result = await provider.upload(path, content, {
        contentType: 'application/octet-stream',
      });

      expect(result.path).toBe(path);
      expect(result.size).toBe(content.length);
      expect(PutObjectCommand).toHaveBeenCalled();
    });

    it('should calculate checksum correctly', async () => {
      const content = 'Test content';
      const path = 'test.md';

      mockSend.mockResolvedValue({});

      const result1 = await provider.upload(path, content);
      const result2 = await provider.upload(path, content);

      // Same content should produce same checksum
      expect(result1.checksum).toBe(result2.checksum);
    });
  });

  describe('download', () => {
    it('should download file as string', async () => {
      const path = 'users/123/notes/456.md';
      const content = '# Test Note\n\nContent here.';

      mockSend.mockResolvedValue({
        Body: {
          transformToString: vi.fn().mockResolvedValue(content),
        },
      });

      const result = await provider.download(path);

      expect(result).toBe(content);
      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: path,
      });
    });

    it('should throw error if file not found', async () => {
      const path = 'users/123/notes/nonexistent.md';

      mockSend.mockResolvedValue({
        Body: null,
      });

      await expect(provider.download(path)).rejects.toThrow('File not found');
    });
  });

  describe('downloadBuffer', () => {
    it('should download file as Buffer', async () => {
      const path = 'users/123/files/image.png';
      const chunks = [Buffer.from('chunk1'), Buffer.from('chunk2')];

      mockSend.mockResolvedValue({
        Body: (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })(),
      });

      const result = await provider.downloadBuffer(path);

      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('delete', () => {
    it('should delete file successfully', async () => {
      const path = 'users/123/notes/456.md';

      mockSend.mockResolvedValue({});

      await provider.delete(path);

      expect(DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: path,
      });
    });
  });

  describe('exists', () => {
    it('should return true if file exists', async () => {
      const path = 'users/123/notes/456.md';

      mockSend.mockResolvedValue({});

      const result = await provider.exists(path);

      expect(result).toBe(true);
      expect(HeadObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: path,
      });
    });

    it('should return false if file does not exist', async () => {
      const path = 'users/123/notes/nonexistent.md';

      mockSend.mockRejectedValue(new Error('Not found'));

      const result = await provider.exists(path);

      expect(result).toBe(false);
    });
  });

  describe('getMetadata', () => {
    it('should return file metadata', async () => {
      const path = 'users/123/notes/456.md';
      const lastModified = new Date();

      mockSend.mockResolvedValue({
        ContentLength: 1024,
        LastModified: lastModified,
        ContentType: 'text/markdown',
      });

      const result = await provider.getMetadata(path);

      expect(result).toEqual({
        size: 1024,
        lastModified,
        contentType: 'text/markdown',
      });
    });
  });

  describe('getSignedUrl', () => {
    it('should generate signed URL', async () => {
      const path = 'users/123/notes/456.md';
      const expiresIn = 3600;

      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      const result = await provider.getSignedUrl(path, expiresIn);

      expect(result).toBe('https://signed-url.example.com/file.md?signature=abc123');
      expect(getSignedUrl).toHaveBeenCalled();
    });
  });

  describe('buildPath', () => {
    it('should build standardized path', () => {
      const path = provider.buildPath('user-123', 'note', 'entity-456', 'md');

      expect(path).toBe('users/user-123/notes/entity-456.md');
    });

    it('should use default extension', () => {
      const path = provider.buildPath('user-123', 'note', 'entity-456');

      expect(path).toBe('users/user-123/notes/entity-456.md');
    });
  });
});

