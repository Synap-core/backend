/**
 * Local Storage Provider
 *
 * Filesystem-backed storage for LOCAL_MODE (embedded Electron pod).
 * Writes files to a configurable local directory (default: ~/.synap/files).
 *
 * Selected when STORAGE_PROVIDER=local or config.server.localMode=true.
 * No network, no credentials — works fully offline.
 *
 * Signed URLs are synthesised as file:// URIs because there is no HTTP
 * server fronting the storage in local mode. Callers that need HTTP access
 * should proxy through the pod's /api/files endpoint instead.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type {
  IFileStorage,
  FileMetadata,
  UploadOptions,
  FileInfo,
} from "./interface.js";
import { buildEntityPath } from "./utils.js";

export interface LocalStorageConfig {
  /**
   * Root directory for all stored files.
   * Defaults to ~/.synap/files when omitted.
   */
  rootDir?: string;
}

/**
 * Filesystem-backed storage provider for LOCAL_MODE pods.
 */
export class LocalStorageProvider implements IFileStorage {
  private readonly rootDir: string;

  constructor(config: LocalStorageConfig = {}) {
    this.rootDir = config.rootDir ?? path.join(os.homedir(), ".synap", "files");
  }

  /** Resolve a storage path to an absolute filesystem path. */
  private resolve(storagePath: string): string {
    // Normalise to prevent path-traversal (e.g. ../../etc/passwd)
    const normalised = path
      .normalize(storagePath)
      .replace(/^(\.\.(\/|\\|$))+/, "");
    return path.join(this.rootDir, normalised);
  }

  /** Ensure the parent directory of an absolute path exists. */
  private async ensureDir(absPath: string): Promise<void> {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
  }

  async upload(
    storagePath: string,
    content: string | Buffer,
    _options?: UploadOptions
  ): Promise<FileMetadata> {
    const absPath = this.resolve(storagePath);
    await this.ensureDir(absPath);

    const buf =
      typeof content === "string" ? Buffer.from(content, "utf-8") : content;

    await fs.writeFile(absPath, buf);

    const checksum = createHash("sha256").update(buf).digest("hex");

    return {
      url: `file://${absPath}`,
      path: storagePath,
      size: buf.length,
      checksum: `sha256:${checksum}`,
      uploadedAt: new Date(),
    };
  }

  async download(storagePath: string): Promise<string> {
    const absPath = this.resolve(storagePath);
    try {
      return await fs.readFile(absPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`File not found: ${storagePath}`);
      }
      throw err;
    }
  }

  async downloadBuffer(storagePath: string): Promise<Buffer> {
    const absPath = this.resolve(storagePath);
    try {
      return await fs.readFile(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`File not found: ${storagePath}`);
      }
      throw err;
    }
  }

  async delete(storagePath: string): Promise<void> {
    const absPath = this.resolve(storagePath);
    try {
      await fs.unlink(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return; // Already gone — treat as success
      }
      throw err;
    }
  }

  async exists(storagePath: string): Promise<boolean> {
    const absPath = this.resolve(storagePath);
    try {
      await fs.access(absPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }

  async getMetadata(storagePath: string): Promise<FileInfo> {
    const absPath = this.resolve(storagePath);
    try {
      const stat = await fs.stat(absPath);
      return {
        size: stat.size,
        lastModified: stat.mtime,
        contentType: "application/octet-stream",
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`File not found: ${storagePath}`);
      }
      throw err;
    }
  }

  /**
   * In local mode there is no HTTP server fronting the storage, so we return
   * a file:// URI. Callers that need an HTTP URL should use the pod's
   * /api/files proxy endpoint instead.
   */
  async getSignedUrl(
    storagePath: string,
    _expiresIn?: number
  ): Promise<string> {
    const absPath = this.resolve(storagePath);
    return `file://${absPath}`;
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
