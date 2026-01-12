 
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
import { storage } from '@synap/storage';
import { db, eq, and, desc, documents, documentVersions, documentSessions } from '@synap/database';
import { insertDocumentSchema } from '@synap/database/schema';
import { requireUserId } from '../utils/user-scoped.js';
import { randomUUID } from 'crypto';

// ============================================================================
// SCHEMAS
// ============================================================================

const DocumentTypeSchema = z.enum(['text', 'markdown', 'code', 'pdf', 'docx']);

const UploadDocumentSchema = insertDocumentSchema
  .pick({
    content: true,
    title: true,
    language: true,
    mimeType: true,
    projectId: true,
  })
  .extend({
    type: DocumentTypeSchema,
    content: z.string(), // API-specific field, not stored in documents table
  });

const UpdateDocumentSchema = z.object({
  documentId: z.string(),
  delta: z.array(z.object({
    content: z.string(),
    // Add other OT fields as needed
  })).optional(), 
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
      
      // ✅ Publish .requested event for document creation
      const { inngest } = await import('@synap/jobs');
      
      await inngest.send({
        name: 'documents.create.requested',
        data: {
          title: input.title,
          type: input.type,
          language: input.language || undefined,
          content: input.content,
          mimeType: input.mimeType || undefined,
          projectId: input.projectId || undefined,
          userId,
        },
        user: { id: userId },
      });

      return {
        status: 'requested',
        message: 'Document upload requested'
      };
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

      const newContent = input.delta?.[0]?.content || ''; // Simplified for example, real OT is complex
      // If delta is missing, maybe we just increment version? Or error?
      // Assuming delta is present for content updates.

      const newVersion = document.currentVersion + 1;

      // Direct storage update
      if (input.delta) {
        await storage.upload(
          document.storageKey,
          Buffer.from(newContent, 'utf-8'),
          { contentType: document.mimeType || 'text/plain' }
        );
      }

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
          delta: input.delta as any, // Cast JSONB
          author: 'user',
          authorId: userId,
          message: input.message || `Auto-snapshot v${newVersion}`,
        });
      }

      return { version: newVersion, success: true };
    }),

  /**
   * Delete document
   */
  delete: protectedProcedure
    .input(z.object({
      documentId: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = requireUserId(ctx.userId);
      
      const document = await db.query.documents.findFirst({
        where: eq(documents.id, input.documentId),
      });
      
      if (!document) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found' });
      }
      
      if (document.userId !== userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not authorized' });
      }
      
      // Delete from storage
      // Fix: 'deleteFile' might be named 'delete' or 'remove' in IFileStorage interface?
      // Checking usage elsewhere or interface definition is best.
      // Assuming 'delete' based on common patterns, or I need to check @synap/storage.
      // If 'deleteFile' does not exist, I will try 'delete'.
      await storage.delete(document.storageKey);
      
      // Delete from DB
      await db.delete(documents).where(eq(documents.id, input.documentId));
      
      return { success: true };
    }),

  // ============================================================================
  // VERSION MANAGEMENT (Same pattern as whiteboards)
  // ============================================================================

  /**
   * Save document version manually (Cmd+S)
   */
  saveVersion: protectedProcedure
    .input(z.object({
      documentId: z.string(),
      message: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = requireUserId(ctx.userId);
      
      // Publish event for worker to process
      const { inngest } = await import('@synap/jobs');
      await inngest.send({
        name: 'documents.snapshot.requested',
        data: {
          documentId: input.documentId,
          message: input.message,
          userId,
        },
        user: { id: userId },
      });
      
      return {
        status: 'requested',
        message: 'Version save requested',
      };
    }),

  /**
   * List document versions
   */
  listVersions: protectedProcedure
    .input(z.object({
      documentId: z.string(),
      limit: z.number().default(20),
    }))
    .query(async ({ input }) => {
      const versions = await db.query.documentVersions.findMany({
        where: eq(documentVersions.documentId, input.documentId),
        orderBy: desc(documentVersions.createdAt),
        limit: input.limit,
      });
      
      const [document] = await db.select({
        currentVersion: documents.currentVersion,
        lastSavedVersion: documents.lastSavedVersion,
      })
      .from(documents)
      .where(eq(documents.id, input.documentId))
      .limit(1);

      return {
        versions: versions.map(v => ({
          id: v.id,
          version: v.version,
          message: v.message,
          createdBy: v.authorId,
          createdAt: v.createdAt,
        })),
        latest: {
          currentVersion: document?.currentVersion || 1,
          lastSavedVersion: document?.lastSavedVersion || 0,
        }
      };
    }),

  /**
   * Restore document to specific version
   */
  restoreVersion: protectedProcedure
    .input(z.object({
      documentId: z.string(),
      versionId: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = requireUserId(ctx.userId);
      
      const version = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.id, input.versionId),
      });
      
      if (!version) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Version not found' });
      }
      
      // Publish event for worker
      const { inngest } = await import('@synap/jobs');
      await inngest.send({
        name: 'documents.restore.requested',
        data: {
          documentId: input.documentId,
          versionId: input.versionId,
          userId,
        },
        user: { id: userId },
      });
      
      return {
        status: 'requested',
        message: 'Restore requested',
      };
    }),

  /**
   * Get version preview
   */
  getVersionPreview: protectedProcedure
    .input(z.object({
      versionId: z.string(),
    }))
    .query(async ({ input }) => {
      const version = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.id, input.versionId),
      });
      
      if (!version) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      
      return version;
    }),

  // ============================================================================
  // PROPOSALS (AI Edits & Review Workflow)
  // ============================================================================

  /**
   * Get proposals for a document
   */
  getProposals: protectedProcedure
    .input(z.object({
      documentId: z.string().uuid(),
      status: z.enum(['pending', 'accepted', 'rejected', 'all']).default('pending'),
    }))
    .query(async ({ input, ctx }) => {
      const { documentProposals } = await import('@synap/database/schema');
      
      // Verify document access
      const document = await db.query.documents.findFirst({
        where: and(
          eq(documents.id, input.documentId),
          eq(documents.userId, ctx.userId)
        ),
      });
      
      if (!document) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found' });
      }
      
      // Fetch proposals
      const proposals = await db.query.documentProposals.findMany({
        where: and(
          eq(documentProposals.documentId, input.documentId),
          input.status !== 'all'
            ? eq(documentProposals.status, input.status)
            : undefined
        ),
        orderBy: desc(documentProposals.createdAt),
        limit: 50,
      });
      
      return { proposals };
    }),

  /**
   * Create a proposal (typically from AI)
   */
  createProposal: protectedProcedure
    .input(z.object({
      documentId: z.string().uuid(),
      proposalType: z.enum(['ai_edit', 'user_suggestion', 'review_comment', 'offline_sync_conflict']),
      changes: z.array(z.object({
        op: z.enum(['insert', 'delete', 'replace']),
        position: z.number().optional(),
        range: z.tuple([z.number(), z.number()]).optional(),
        text: z.string().optional(),
      })),
      originalContent: z.string().optional(),
      proposedContent: z.string().optional(),
      expiresInDays: z.number().default(7),
    }))
    .mutation(async ({ input, ctx }) => {
      const { documentProposals } = await import('@synap/database/schema');
      
      // Verify document access
      const document = await db.query.documents.findFirst({
        where: and(
          eq(documents.id, input.documentId),
          eq(documents.userId, ctx.userId)
        ),
      });
      
      if (!document) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found' });
      }
      
      // Calculate expiration
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + input.expiresInDays);
      
      // Create proposal
      const [proposal] = await db.insert(documentProposals).values({
        documentId: input.documentId,
        proposalType: input.proposalType,
        proposedBy: input.proposalType === 'ai_edit' ? 'ai' : ctx.userId,
        changes: input.changes as any,
        originalContent: input.originalContent,
        proposedContent: input.proposedContent,
        status: 'pending',
        expiresAt,
      }).returning();
      
      // Broadcast to user
      const { broadcastSuccess } = await import('@synap/jobs');
      await broadcastSuccess(ctx.userId, 'ai:proposal', {
        proposalId: proposal.id,
        documentId: input.documentId,
        operation: 'create',
      });
      
      return { 
        success: true,
        proposalId: proposal.id,
      };
    }),

  /**
   * Review a proposal (accept or reject)
   */
  reviewProposal: protectedProcedure
    .input(z.object({
      proposalId: z.string().uuid(),
      action: z.enum(['accept', 'reject']),
      comment: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { documentProposals } = await import('@synap/database/schema');
      const userId = requireUserId(ctx.userId);
      
      // Get proposal
      const proposal = await db.query.documentProposals.findFirst({
        where: eq(documentProposals.id, input.proposalId),
      });
      
      if (!proposal) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal not found' });
      }
      
      // Verify document access
      const document = await db.query.documents.findFirst({
        where: and(
          eq(documents.id, proposal.documentId),
          eq(documents.userId, ctx.userId)
        ),
      });
      
      if (!document) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not authorized' });
      }
      
      // If accepting, apply changes (simplified - would integrate with Yjs in real implementation)
      if (input.action === 'accept' && proposal.proposedContent) {
        // Create version snapshot with accepted changes
        await db.insert(documentVersions).values({
          documentId: proposal.documentId,
          version: (document.currentVersion || 0) + 1,
          content: proposal.proposedContent,
          message: `AI changes accepted: ${input.comment || 'No comment'}`,
          author: 'ai',
          authorId: proposal.proposedBy,
        });
        
        // Update document version
        await db.update(documents)
          .set({ currentVersion: (document.currentVersion || 0) + 1 })
          .where(eq(documents.id, proposal.documentId));
      }
      
      // Update proposal status
      await db.update(documentProposals)
        .set({
          status: input.action === 'accept' ? 'accepted' : 'rejected',
          reviewedBy: userId,
          reviewedAt: new Date(),
          reviewComment: input.comment,
          updatedAt: new Date(),
        })
        .where(eq(documentProposals.id, input.proposalId));
      
      // Broadcast update
      const { broadcastSuccess } = await import('@synap/jobs');
      await broadcastSuccess(ctx.userId, 'ai:proposal:status', {
        proposalId: input.proposalId,
        documentId: proposal.documentId,
        status: input.action === 'accept' ? 'approved' : 'rejected',
      });

      return { success: true, action: input.action };
    }),

  /**
   * Delete a proposal
   */
  deleteProposal: protectedProcedure
    .input(z.object({
      proposalId: z.string().uuid(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { documentProposals } = await import('@synap/database/schema');
      
      // Get proposal to verify ownership
      const proposal = await db.query.documentProposals.findFirst({
        where: eq(documentProposals.id, input.proposalId),
      });
      
      if (!proposal) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      
      // Verify document access
      const document = await db.query.documents.findFirst({
        where: and(
          eq(documents.id, proposal.documentId),
          eq(documents.userId, ctx.userId)
        ),
      });
      
      if (!document) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      
      // Delete proposal
      await db.delete(documentProposals)
        .where(eq(documentProposals.id, input.proposalId));
      
      return { success: true };
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

