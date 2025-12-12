/**
 * Content Facade
 * 
 * Unified API for creating content using schema-driven events:
 * - Entities: Notes, tasks, projects (→ entities.create.requested)
 * - Documents: PDFs, code files (→ documents.create.requested)
 * 
 * Supports metadata for AI context and tags.
 */

import type { AppRouter } from '@synap/api';
import type { TRPCClient } from '@trpc/client';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Entity types supported by the entities worker
 */
export type EntityType = 'note' | 'task' | 'project' | 'contact' | 'meeting' | 'idea';

/**
 * Options for creating an entity (note, task, project, etc.)
 */
export interface CreateEntityOptions {
  /** Type of entity to create */
  entityType: EntityType;
  /** Main content (for notes: markdown, for tasks: description) */
  content?: string;
  /** Title of the entity */
  title?: string;
  /** Additional metadata (type-specific: dueDate for tasks, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * Legacy: Options for creating a note (kept for backward compatibility)
 * @deprecated Use CreateEntityOptions with entityType: 'note' instead
 */
export interface CreateNoteOptions {
  content: string;
  type?: 'note' | 'task';
  metadata?: {
    title?: string;
    tags?: string[];
  };
}

/**
 * Options for uploading a file
 */
export interface UploadFileOptions {
  file: File | Buffer;
  filename: string;
  contentType: string;
  targetType: 'note' | 'document';
  metadata?: {
    title?: string;
    description?: string;
    tags?: string[];
  };
}

/**
 * Result of a content creation request
 */
export interface CreateResult {
  success: boolean;
  status: 'pending' | 'completed';
  requestId: string;
  entityId?: string;
  documentId?: string;
}

// ============================================================================
// FACADE
// ============================================================================

export class ContentFacade {
  constructor(private rpc: TRPCClient<AppRouter>) {}

  /**
   * Create entity (note, task, project, etc.)
   * 
   * This is the new schema-driven API that uses the consolidated entities worker.
   * 
   * @example
   * ```ts
   * // Create a note
   * await client.content.createEntity({
   *   entityType: 'note',
   *   content: '# My Note\n\nContent here...',
   *   title: 'My Note',
   * });
   * 
   * // Create a task with metadata
   * await client.content.createEntity({
   *   entityType: 'task',
   *   content: 'Implement feature X',
   *   title: 'Feature X',
   *   metadata: {
   *     dueDate: '2024-12-31',
   *     priority: 1,
   *     tags: ['dev', 'urgent'],
   *   },
   * });
   * ```
   */
  async createEntity(options: CreateEntityOptions): Promise<CreateResult> {
    const contentRouter = this.rpc.content as any;
    
    return contentRouter.createFromText.mutate({
      content: options.content || '',
      targetType: options.entityType === 'note' || options.entityType === 'task' 
        ? options.entityType 
        : 'note', // Map other types to note for now
      metadata: {
        title: options.title,
        entityType: options.entityType, // Pass entityType in metadata
        ...options.metadata,
      },
    });
  }

  /**
   * Create note from text input
   * 
   * @deprecated Use createEntity({ entityType: 'note', ... }) instead
   * 
   * @example
   * ```ts
   * await client.content.createNote({
   *   content: "# Project Ideas\n\nBuild a knowledge graph...",
   *   type: 'note',
   *   metadata: { title: 'Q1 Ideas', tags: ['planning'] }
   * });
   * ```
   */
  async createNote(options: CreateNoteOptions): Promise<CreateResult> {
    const contentRouter = this.rpc.content as any;
    
    return contentRouter.createFromText.mutate({
      content: options.content,
      targetType: options.type || 'note',
      metadata: options.metadata,
    });
  }

  /**
   * Upload file (direct upload or AI-generated)
   * 
   * @example
   * ```ts
   * // Upload PDF as document
   * await client.content.uploadFile({
   *   file: pdfBuffer,
   *   filename: 'report.pdf',
   *   contentType: 'application/pdf',
   *   targetType: 'document'
   * });
   * 
   * // Upload markdown as note
   * await client.content.uploadFile({
   *   file: markdownFile,
   *   filename: 'ideas.md',
   *   contentType: 'text/markdown',
   *   targetType: 'note'
   * });
   * ```
   */
  async uploadFile(options: UploadFileOptions): Promise<CreateResult> {
    const contentRouter = this.rpc.content as any;
    
    // Convert File to Buffer if needed
    const buffer = options.file instanceof File
      ? await this.fileToBuffer(options.file)
      : options.file;
    
    return contentRouter.createFromFile.mutate({
      file: buffer.toString('base64'),
      filename: options.filename,
      contentType: options.contentType,
      targetType: options.targetType,
      metadata: options.metadata,
    });
  }

  /**
   * Helper: Convert File to Buffer (browser/Node.js compatible)
   */
  private async fileToBuffer(file: File): Promise<Buffer> {
    if (typeof globalThis !== 'undefined' && typeof (globalThis as any).window !== 'undefined') {
      // Browser environment
      const arrayBuffer = await file.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
    // Node.js environment (File is already Buffer-like)
    return file as any;
  }
}
