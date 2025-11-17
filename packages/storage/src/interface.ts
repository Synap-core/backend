/**
 * Storage Interface - Provider-Agnostic File Storage
 * 
 * This interface allows the application to work with any S3-compatible storage:
 * - Cloudflare R2 (production)
 * - MinIO (local development)
 * - AWS S3 (alternative)
 * 
 * All implementations must be S3-compatible to use the AWS SDK.
 */

/**
 * File metadata returned after upload
 */
export interface FileMetadata {
  /** Public URL to access the file */
  url: string;
  /** Storage path/key (e.g., "users/123/notes/456.md") */
  path: string;
  /** File size in bytes */
  size: number;
  /** SHA256 checksum for integrity verification */
  checksum: string;
  /** Upload timestamp */
  uploadedAt: Date;
}

/**
 * Options for file upload
 */
export interface UploadOptions {
  /** MIME type (e.g., "text/markdown", "application/pdf") */
  contentType?: string;
  /** Custom metadata key-value pairs */
  metadata?: Record<string, string>;
}

/**
 * File metadata without downloading the file
 */
export interface FileInfo {
  /** File size in bytes */
  size: number;
  /** Last modified timestamp */
  lastModified: Date;
  /** MIME type */
  contentType: string;
}

/**
 * Storage provider interface
 * 
 * All implementations must be S3-compatible and use the AWS SDK.
 */
export interface IFileStorage {
  /**
   * Upload a file to storage
   * 
   * @param path - Storage path/key (e.g., "users/123/notes/456.md")
   * @param content - File content as string or Buffer
   * @param options - Upload options (content type, metadata)
   * @returns File metadata including URL and checksum
   * 
   * @example
   * ```typescript
   * const result = await storage.upload(
   *   'users/123/notes/456.md',
   *   '# My Note\n\nContent here',
   *   { contentType: 'text/markdown' }
   * );
   * console.log(result.url); // Public URL
   * ```
   */
  upload(
    path: string,
    content: string | Buffer,
    options?: UploadOptions
  ): Promise<FileMetadata>;

  /**
   * Download a file as string (for text files)
   * 
   * @param path - Storage path/key
   * @returns File content as string
   * @throws Error if file not found
   * 
   * @example
   * ```typescript
   * const content = await storage.download('users/123/notes/456.md');
   * ```
   */
  download(path: string): Promise<string>;

  /**
   * Download a file as Buffer (for binary files)
   * 
   * @param path - Storage path/key
   * @returns File content as Buffer
   * @throws Error if file not found
   * 
   * @example
   * ```typescript
   * const buffer = await storage.downloadBuffer('users/123/files/image.png');
   * ```
   */
  downloadBuffer(path: string): Promise<Buffer>;

  /**
   * Delete a file from storage
   * 
   * @param path - Storage path/key
   * @throws Error if deletion fails
   * 
   * @example
   * ```typescript
   * await storage.delete('users/123/notes/456.md');
   * ```
   */
  delete(path: string): Promise<void>;

  /**
   * Check if a file exists
   * 
   * @param path - Storage path/key
   * @returns true if file exists, false otherwise
   * 
   * @example
   * ```typescript
   * if (await storage.exists('users/123/notes/456.md')) {
   *   // File exists
   * }
   * ```
   */
  exists(path: string): Promise<boolean>;

  /**
   * Get file metadata without downloading
   * 
   * @param path - Storage path/key
   * @returns File metadata (size, last modified, content type)
   * @throws Error if file not found
   * 
   * @example
   * ```typescript
   * const info = await storage.getMetadata('users/123/notes/456.md');
   * console.log(info.size); // File size in bytes
   * ```
   */
  getMetadata(path: string): Promise<FileInfo>;

  /**
   * Generate a signed URL for temporary access
   * 
   * @param path - Storage path/key
   * @param expiresIn - Expiration time in seconds (default: 3600 = 1 hour)
   * @returns Signed URL valid for the specified duration
   * 
   * @example
   * ```typescript
   * const url = await storage.getSignedUrl('users/123/private/doc.pdf', 3600);
   * // URL valid for 1 hour
   * ```
   */
  getSignedUrl(path: string, expiresIn?: number): Promise<string>;

  /**
   * Build a standardized file path for user entities
   * 
   * @param userId - User ID
   * @param entityType - Entity type (e.g., "note", "task", "project")
   * @param entityId - Entity ID
   * @param extension - File extension (default: "md")
   * @returns Standardized path (e.g., "users/123/notes/456.md")
   * 
   * @example
   * ```typescript
   * const path = storage.buildPath('user-123', 'note', 'entity-456', 'md');
   * // Returns: "users/user-123/notes/entity-456.md"
   * ```
   */
  buildPath(
    userId: string,
    entityType: string,
    entityId: string,
    extension?: string
  ): string;
}

