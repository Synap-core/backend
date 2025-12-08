/**
 * Documents Router
 * Handles document upload, retrieval, updates, and collaborative sessions
 * 
 * Architecture: Hybrid approach
 * - AI operations (create via chat): Full events
 * - User edits (typing): Direct updates + session tracking
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { TRPCError } from '@trpc/server';
import { createLogger } from '@synap/core';
import { storage } from '@synap/storage';
import { db, eq, and, desc, documents, documentVersions, documentSessions } from '@synap/database';
import { requireUserId } from '../utils/user-scoped.js';
import { randomUUID } from 'crypto';

const logger = createLogger({ module: 'documents-router' });

// ============================================================================
// SCHEMAS
// ============================================================================

const DocumentTypeSchema = z.enum(['text', 'markdown', 'code', 'pdf', 'docx']);

const UploadDocumentSchema = z.object({
  title: z.string().min(1).max(255),
  type: DocumentTypeSchema,
  language: z.string().optional(),
  content: z.string(),
  mimeType: z.string().optional(),
  projectId: z.string().optional(),
});

const UpdateDocumentSchema = z.object({
  documentId: z.string(),
  delta: z.array(z.object({
    content: z.string(),
  })),
  version: z.number().int().positive(),
  message: z.string().optional(),
});

// ============================================================================
// ROUTER
// ============================================================================

export const documentsRouter = router({
  /**
   * Upload a new document
   */
  upload: protectedProcedure
    .input(UploadDocumentSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const log = logger.child({ userId, title: input.title });

      try {
        const fileName = `${randomUUID()}.${getExtension(input.type)}`;
        const storageKey = `documents/${userId}/${fileName}`;
        
        const buffer = input.type === 'pdf' || input.type === 'docx'
          ? Buffer.from(input.content, 'base64')
          : Buffer.from(input.content, 'utf-8');
        
        // Upload to storage - API is (path, content, options)
        const metadata = await storage.upload(
          storageKey,
          buffer,
          { contentType: input.mimeType || getMimeType(input.type) }
        );

        const [document] = await db.insert(documents).values({
          userId,
          title: input.title,
          type: input.type,
          language: input.language,
          storageUrl: metadata.url,
          storageKey,
          size: buffer.length,
          mimeType: input.mimeType || getMimeType(input.type),
          projectId: input.projectId,
          currentVersion: 1,
        }).returning();

        await db.insert(documentVersions).values({
          documentId: document.id,
          version: 1,
          content: input.content,
          author: 'user',
          authorId: userId,
          message: 'Initial upload',
        });

        log.info({ documentId: document.id }, 'Document uploaded');

        return {
          documentId: document.id,
          storageUrl: document.storageUrl,
          version: document.currentVersion,
        };
      } catch (error) {
        log.error({ err: error }, 'Upload failed');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to upload document',
        });
      }
    }),

  /**
   * Get document by ID
   */
  get: protectedProcedure
    .input(z.object({ documentId: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const [document] = await db
        .select()
        .from(documents)
        .where(and(
          eq(documents.id, input.documentId),
          eq(documents.userId, userId)
        ))
        .limit(1);

      if (!document) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Document not found',
        });
      }

      const contentBuffer = await storage.downloadBuffer(document.storageKey);
      const content = document.type === 'pdf' || document.type === 'docx'
        ? contentBuffer.toString('base64')
        : contentBuffer.toString('utf-8');

      return { document, content };
    }),

  /**
   * Update document (DIRECT UPDATE - no event)
   * Hybrid architecture: Performance optimized
   */
  update: protectedProcedure
    .input(UpdateDocumentSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const [document] = await db
        .select()
        .from(documents)
        .where(and(
          eq(documents.id, input.documentId),
          eq(documents.userId, userId)
        ))
        .limit(1);

      if (!document) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found' });
      }

      const newContent = input.delta[0]?.content || '';
      const newVersion = document.currentVersion + 1;

      // Direct storage update
      await storage.upload(
        document.storageKey,
        Buffer.from(newContent, 'utf-8'),
        { contentType: document.mimeType || 'text/plain' }
      );

      // Direct DB update
      await db.update(documents)
        .set({ currentVersion: newVersion, updatedAt: new Date() })
        .where(eq(documents.id, input.documentId));

      // Periodic snapshots (every 10 versions)
      if (newVersion % 10 === 0 || input.message) {
        await db.insert(documentVersions).values({
          documentId: input.documentId,
          version: newVersion,
          content: newContent,
          delta: input.delta,
          author: 'user',
          authorId: userId,
          message: input.message || `Auto-snapshot v${newVersion}`,
        });
      }

      return { version: newVersion, success: true };
    }),

  /**
   * Start editing session
   */
  startSession: protectedProcedure
    .input(z.object({ documentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const [document] = await db
        .select()
        .from(documents)
        .where(and(
          eq(documents.id, input.documentId),
          eq(documents.userId, userId)
        ))
        .limit(1);

      if (!document) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found' });
      }

      const chatThreadId = randomUUID();

      const [session] = await db.insert(documentSessions).values({
        documentId: input.documentId,
        userId,
        chatThreadId,
        isActive: true,
        activeCollaborators: [{ type: 'user', id: userId }],
      }).returning();

      return { sessionId: session.id, chatThreadId };
    }),

  /**
   * List user's documents
   */
  list: protectedProcedure
    .input(z.object({
      projectId: z.string().optional(),
      type: DocumentTypeSchema.optional(),
      limit: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const conditions = [eq(documents.userId, userId)];
      if (input.projectId) conditions.push(eq(documents.projectId, input.projectId));
      if (input.type) conditions.push(eq(documents.type, input.type));

      const docs = await db
        .select()
        .from(documents)
        .where(and(...conditions))
        .orderBy(desc(documents.updatedAt))
        .limit(input.limit);

      return { documents: docs, total: docs.length };
    }),
});

// ============================================================================
// HELPERS
// ============================================================================

function getExtension(type: string): string {
  const map: Record<string, string> = {
    text: 'txt',
    markdown: 'md',
    code: 'txt',
    pdf: 'pdf',
    docx: 'docx',
  };
  return map[type] || 'txt';
}

function getMimeType(type: string): string {
  const map: Record<string, string> = {
    text: 'text/plain',
    markdown: 'text/markdown',
    code: 'text/plain',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[type] || 'text/plain';
}
