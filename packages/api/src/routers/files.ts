/**
 * Files Router - File Storage API
 *
 * Provides API for browsing and managing files in MinIO/S3 storage.
 * Used by the Admin UI Files page.
 */

import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import {
  S3Client,
  ListObjectsV2Command,
  ListBucketsCommand,
  type Bucket,
  type _Object,
  type CommonPrefix,
} from "@aws-sdk/client-s3";
import { storage } from "@synap/storage";

// Get MinIO client from environment
const getS3Client = (): S3Client => {
  return new S3Client({
    region: process.env.MINIO_REGION || "us-east-1",
    endpoint: process.env.MINIO_ENDPOINT || "http://localhost:9000",
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY || "minioadmin",
      secretAccessKey: process.env.MINIO_SECRET_KEY || "minioadmin",
    },
    forcePathStyle: true,
  });
};

const defaultBucket = process.env.MINIO_BUCKET || "synap-storage";

export const filesRouter = router({
  /**
   * List buckets
   */
  listBuckets: publicProcedure.query(async () => {
    try {
      const client = getS3Client();
      const response = await client.send(new ListBucketsCommand({}));

      return {
        buckets: (response.Buckets || []).map((b: Bucket) => ({
          name: b.Name || "unknown",
          createdAt: b.CreationDate?.toISOString() || null,
        })),
      };
    } catch (error) {
      console.error("Failed to list buckets:", error);
      return { buckets: [] };
    }
  }),

  /**
   * List files in a bucket with optional prefix
   */
  listFiles: publicProcedure
    .input(
      z.object({
        bucket: z.string().default(defaultBucket),
        prefix: z.string().optional(),
        maxKeys: z.number().default(100),
      })
    )
    .query(async ({ input }) => {
      try {
        const client = getS3Client();
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: input.bucket,
            Prefix: input.prefix || "",
            MaxKeys: input.maxKeys,
            Delimiter: "/", // For folder-like navigation
          })
        );

        // Get "folders" (common prefixes)
        const folders = (response.CommonPrefixes || []).map(
          (cp: CommonPrefix) => ({
            type: "folder" as const,
            name:
              cp.Prefix?.replace(input.prefix || "", "").replace(/\/$/, "") ||
              "",
            path: cp.Prefix || "",
          })
        );

        // Get files
        const files = (response.Contents || [])
          .filter((obj: _Object) => obj.Key !== input.prefix) // Exclude the prefix itself
          .map((obj: _Object) => ({
            type: "file" as const,
            name: obj.Key?.replace(input.prefix || "", "") || "",
            path: obj.Key || "",
            size: obj.Size || 0,
            lastModified: obj.LastModified?.toISOString() || null,
          }));

        return {
          items: [...folders, ...files],
          totalItems: folders.length + files.length,
          prefix: input.prefix || "",
          bucket: input.bucket,
          isTruncated: response.IsTruncated || false,
        };
      } catch (error) {
        console.error("Failed to list files:", error);
        return {
          items: [],
          totalItems: 0,
          prefix: input.prefix || "",
          bucket: input.bucket,
          isTruncated: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }),

  /**
   * Get file metadata
   */
  getFileMetadata: publicProcedure
    .input(
      z.object({
        path: z.string(),
      })
    )
    .query(async ({ input }) => {
      try {
        const metadata = await storage.getMetadata(input.path);
        return {
          success: true,
          path: input.path,
          size: metadata.size,
          lastModified: metadata.lastModified.toISOString(),
          contentType: metadata.contentType,
        };
      } catch (error) {
        return {
          success: false,
          path: input.path,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }),

  /**
   * Get signed download URL
   */
  getDownloadUrl: publicProcedure
    .input(
      z.object({
        path: z.string(),
        expiresIn: z.number().default(3600), // 1 hour default
      })
    )
    .query(async ({ input }) => {
      try {
        const url = await storage.getSignedUrl(input.path, input.expiresIn);
        return {
          success: true,
          url,
          expiresIn: input.expiresIn,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }),

  /**
   * Check if file exists
   */
  exists: publicProcedure
    .input(
      z.object({
        path: z.string(),
      })
    )
    .query(async ({ input }) => {
      const exists = await storage.exists(input.path);
      return { exists, path: input.path };
    }),

  /**
   * Delete a file
   */
  deleteFile: publicProcedure
    .input(
      z.object({
        path: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        await storage.delete(input.path);
        return { success: true, path: input.path };
      } catch (error) {
        return {
          success: false,
          path: input.path,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }),
});
