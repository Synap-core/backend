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

/** Options for {@link IFileStorage.getSignedUploadUrl}. */
export interface SignedUploadOptions {
  /** Signed — the PUT must send exactly this Content-Type. */
  contentType: string;
  /** Signed — the PUT must send exactly this many bytes. */
  contentLength: number;
  /** Seconds until the URL expires (default 900 = 15 min). */
  expiresIn?: number;
}

/**
 * This storage backend cannot issue a client-reachable presigned upload URL.
 * A typed refusal, so a caller can answer "use the small-file door" instead of
 * handing a client a URL on an internal host it can never reach.
 */
export class StorageUploadUnavailableError extends Error {
  readonly code = "STORAGE_UPLOAD_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "StorageUploadUnavailableError";
  }
}

/** Options for {@link IFileStorage.downloadStream}. */
export interface DownloadStreamOptions {
  /**
   * Refuse an object larger than this many bytes with
   * {@link StorageObjectTooLargeError}: before any byte is read when the store
   * reports the object's length, and again as the bytes pass (a length that
   * lied still cannot get more than `maxBytes` through).
   */
  maxBytes?: number;
}

/** An object opened for reading, by {@link IFileStorage.downloadStream}. */
export interface DownloadStream {
  /**
   * The object's bytes, read on demand. Iterate it once. Throws
   * {@link StorageObjectTooLargeError} past `maxBytes`.
   */
  body: AsyncIterable<Uint8Array>;
  /** The object's length as the store reported it; null when it did not say. */
  size: number | null;
  /** The stored MIME type (`application/octet-stream` when none is stored). */
  contentType: string;
  /**
   * Release the connection or file handle without reading the body (the
   * caller decided not to send it). Idempotent; harmless after a full read.
   */
  cancel(): void;
}

/** The object does not exist (a definite "not there", never a network failure). */
export class StorageObjectNotFoundError extends Error {
  readonly code = "STORAGE_OBJECT_NOT_FOUND";
  constructor(readonly path: string) {
    super(`File not found: ${path}`);
    this.name = "StorageObjectNotFoundError";
  }
}

/**
 * The object is larger than the reader allowed. `size` is the stored length
 * when the refusal came before reading, else the bytes seen when the cap
 * passed.
 */
export class StorageObjectTooLargeError extends Error {
  readonly code = "STORAGE_OBJECT_TOO_LARGE";
  constructor(
    readonly path: string,
    readonly size: number,
    readonly maxBytes: number
  ) {
    super(
      `File ${path} is ${size} bytes, over the ${maxBytes}-byte limit for this read`
    );
    this.name = "StorageObjectTooLargeError";
  }
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
   * Upload a file from a STREAM — the body is never held whole in memory (a
   * 1 GB video copied from the web goes chunk by chunk into storage).
   *
   * S3-compatible backends run a multipart upload (fixed-size parts, R2's
   * rule; one plain PUT when the body is smaller than one part) and ABORT it
   * when the body errors, so a refused or failed stream leaves no object and
   * no dangling parts. The local backend writes a temp file and renames it
   * into place only on success.
   *
   * `size` and `checksum` (`sha256:<hex>`, {@link fileChecksum}'s encoding)
   * are computed over the bytes as they pass.
   *
   * @param body - Any async iterable of byte chunks (a Node `Readable` is one).
   *   Throwing from it (e.g. a byte cap passed) aborts the upload with that error.
   */
  uploadStream(
    path: string,
    body: AsyncIterable<Uint8Array>,
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
   * Open a file for reading as a STREAM: the bytes are never held whole in
   * memory (a 100 MB video goes chunk by chunk to wherever the caller pipes
   * it).
   *
   * @param path - Storage path/key
   * @param options - `maxBytes`: refuse a larger object (typed)
   * @throws {@link StorageObjectNotFoundError} when the object does not exist
   * @throws {@link StorageObjectTooLargeError} when it is over `maxBytes`
   */
  downloadStream(
    path: string,
    options?: DownloadStreamOptions
  ): Promise<DownloadStream>;

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
   * The canonical (unsigned) storage URL of an object — the same value
   * `upload()` returns as `FileMetadata.url`. Used when the bytes arrived by a
   * presigned PUT, so the `documents` row records the same `storageUrl` an
   * API-side upload would have.
   */
  objectUrl(path: string): Promise<string>;

  /**
   * Generate a presigned PUT URL so a client can upload bytes DIRECTLY to
   * object storage (the large-file lane — the API never buffers the body).
   *
   * `contentType` and `contentLength` are SIGNED (`X-Amz-SignedHeaders`
   * includes `content-length;content-type`): the store refuses a PUT whose
   * Content-Type or Content-Length differs, so the declared size/type the pod
   * validated is the only one that can land. The URL carries NO
   * `x-amz-checksum-*` params (the signer is built with
   * `requestChecksumCalculation: "WHEN_REQUIRED"`).
   *
   * Throws {@link StorageUploadUnavailableError} when this backend cannot hand
   * out a URL a client can actually reach (local filesystem; MinIO with no
   * configured public URL). Never returns an unreachable URL.
   */
  getSignedUploadUrl(
    path: string,
    options: SignedUploadOptions
  ): Promise<string>;

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
