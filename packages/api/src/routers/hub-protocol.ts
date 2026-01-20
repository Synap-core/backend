/**
 * Hub Protocol Routes
 *
 * Dedicated endpoints for Intelligence Hub to access Data Pod
 * Protected by API key authentication with 'hub-protocol' scopes
 */

import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { scopedProcedure } from "../middleware/api-key-auth.js";
import { db, eq, desc, and, sql, sqlTemplate } from "@synap/database";
import {
  chatThreads,
  conversationMessages,
  entities,
  documents,
} from "@synap/database/schema";
import { intelligenceHubClient } from "../clients/intelligence-hub.js";

/**
 * Hub Protocol Router
 *
 * Service-to-service API for Intelligence Hub
 * All routes (except health) require API key with 'hub-protocol.read' or 'hub-protocol.write' scope
 */
export const hubProtocolRouter = router({
  /**
   * Health check (no auth required)
   */
  health: publicProcedure.query(() => {
    return { status: "ok", service: "hub-protocol" };
  }),

  /**
   * Get thread context (messages + metadata)
   * Requires: hub-protocol.read scope
   */
  getThreadContext: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        threadId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      // Get thread
      const thread = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, input.threadId),
      });

      if (!thread) {
        throw new Error("Thread not found");
      }

      // Get messages (last 50)
      const messages = await db.query.conversationMessages.findMany({
        where: eq(conversationMessages.threadId, input.threadId),
        orderBy: [desc(conversationMessages.timestamp)],
        limit: 50,
      });

      // Get recent entities for this user
      const recentEntities = await db.query.entities.findMany({
        where: eq(entities.userId, thread.userId),
        orderBy: [desc(entities.createdAt)],
        limit: 10,
      });

      return {
        thread: {
          id: thread.id,
          userId: thread.userId,
          projectId: thread.projectId,
          agentId: thread.agentId,
        },
        messages: messages.reverse().map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        })),
        recentEntities: recentEntities.map((e) => ({
          id: e.id,
          type: e.type,
          title: e.title,
        })),
      };
    }),

  /**
   * Get user context
   * Requires: hub-protocol.read scope
   */
  getUserContext: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
      })
    )
    .query(async ({ input }) => {
      // Get recent entities
      const recentEntities = await db.query.entities.findMany({
        where: eq(entities.userId, input.userId),
        orderBy: [desc(entities.createdAt)],
        limit: 20,
      });

      // Get recent threads
      const recentThreads = await db.query.chatThreads.findMany({
        where: eq(chatThreads.userId, input.userId),
        orderBy: [desc(chatThreads.updatedAt)],
        limit: 5,
      });

      return {
        userId: input.userId,
        preferences: {},
        recentActivity: [
          ...recentEntities.map((e) => ({
            type: "entity_created",
            timestamp: e.createdAt,
            data: { entityId: e.id, entityType: e.type },
          })),
          ...recentThreads.map((t) => ({
            type: "thread_updated",
            timestamp: t.updatedAt,
            data: { threadId: t.id },
          })),
        ]
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          .slice(0, 10),
      };
    }),

  /**
   * Get entities for user
   * Requires: hub-protocol.read scope
   */
  getEntities: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        type: z.string().optional(),
        limit: z.number().optional(),
      })
    )
    .query(async ({ input }) => {
      const results = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, input.userId),
          input.type ? eq(entities.type, input.type) : undefined
        ),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit || 50,
      });

      return results;
    }),

  /**
   * Create entity
   * Requires: hub-protocol.write scope
   */
  createEntity: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        type: z.string(),
        title: z.string(),
        description: z.string().optional(),
        // AI metadata for tracking AI-generated proposals
        aiMetadata: z
          .object({
            messageId: z.string().optional(),
            confidence: z.number().min(0).max(1).optional(),
            model: z.string().optional(),
            reasoning: z.string().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ input }) => {
      // \u2705 Publish .requested event
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "entities.create.requested",
        data: {
          entityType: input.type as any,
          title: input.title,
          preview: input.description,
          userId: input.userId,
          source: "ai", // Mark as AI-generated
          aiMetadata: input.aiMetadata, // Pass through AI metadata
        },
        user: { id: input.userId },
      });

      return {
        status: "requested",
        message: "Entity creation requested",
      };
    }),

  /**
   * Update thread context
   * Requires: hub-protocol.write scope
   */
  updateThreadContext: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        threadId: z.string().uuid(),
        contextSummary: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      await db
        .update(chatThreads)
        .set({
          contextSummary: input.contextSummary,
          updatedAt: new Date(),
        })
        .where(eq(chatThreads.id, input.threadId));

      return { success: true };
    }),

  // ============================================================================
  // NEW: Search & Data Access Endpoints (Phase 1)
  // ============================================================================

  /**
   * Search entities (delegates to search router)
   * Requires: hub-protocol.read scope
   */
  searchEntities: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        query: z.string(),
        type: z
          .enum([
            "note",
            "task",
            "document",
            "project",
            "contact",
            "meeting",
            "idea",
          ])
          .optional(),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ input }) => {
      // Call search.entities with proper context
      const results = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, input.userId),
          input.type ? eq(entities.type, input.type) : undefined,
          input.query
            ? // Simple ILIKE search on title and preview
              sqlTemplate`(${entities.title} ILIKE ${`%${input.query}%`} OR ${entities.preview} ILIKE ${`%${input.query}%`})`
            : undefined
        ),
        orderBy: [desc(entities.updatedAt)],
        limit: input.limit,
      });

      return { entities: results };
    }),

  /**
   * Search documents (simple text search)
   * Requires: hub-protocol.read scope
   */
  searchDocuments: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        query: z.string(),
        type: z.enum(["text", "markdown", "code", "pdf", "docx"]).optional(),
        limit: z.number().min(1).max(50).default(10),
      })
    )
    .query(async ({ input }) => {
      const { documents } = await import("@synap/database/schema");
      const { sqlTemplate: sql } = await import("@synap/database");

      // Simple ILIKE search on document titles
      const results = await db.query.documents.findMany({
        where: and(
          eq(documents.userId, input.userId),
          input.type ? eq(documents.type, input.type) : undefined,
          sql`${documents.title} ILIKE ${`%${input.query}%`}`
        ),
        orderBy: [desc(documents.updatedAt)],
        limit: input.limit,
      });

      // Return metadata only (no content)
      return {
        documents: results.map((d) => ({
          id: d.id,
          title: d.title,
          type: d.type,
          language: d.language,
          updatedAt: d.updatedAt,
          createdAt: d.createdAt,
        })),
      };
    }),

  /**
   * Vector search (semantic search across entities + documents)
   * Requires: hub-protocol.read scope
   */
  vectorSearch: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        query: z.string(),
        types: z.array(z.string()).optional(),
        limit: z.number().min(1).max(50).default(10),
      })
    )
    .query(async ({ input }) => {
      // 1. Generate embedding for query
      let embedding: number[];
      try {
        embedding = await intelligenceHubClient.generateEmbedding(input.query);
      } catch (error) {
        console.error("Failed to generate embedding:", error);
        // Return empty results if embedding fails
        return {
          results: [],
          embeddingGenerated: false,
        };
      }

      const embeddingStr = `[${embedding.join(",")}]`;

      // 2. Vector similarity search using pgvector
      const results = await sql`
        SELECT 
          e.id,
          e.type,
          e.title,
          e.preview,
          e.created_at,
          1 - (ev.embedding <=> ${embeddingStr}::vector) as similarity
        FROM entity_vectors ev
        JOIN entities e ON ev.entity_id = e.id
        WHERE 
          ev.user_id = ${input.userId}
          AND e.deleted_at IS NULL
          ${input.types ? sql`AND e.type = ANY(${input.types})` : sql``}
        ORDER BY similarity DESC
        LIMIT ${input.limit}
      `;

      return {
        results: results.map((r: any) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          preview: r.preview,
          similarity: r.similarity,
          createdAt: r.created_at,
        })),
        embeddingGenerated: true,
      };
    }),

  /**
   * Get document content by ID
   * Requires: hub-protocol.read scope
   */
  getDocument: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        documentId: z.string().uuid(),
        userId: z.string(),
      })
    )
    .query(async ({ input }) => {
      const { documents } = await import("@synap/database/schema");
      const { storage } = await import("@synap/storage");

      // Get document metadata
      const document = await db.query.documents.findFirst({
        where: and(
          eq(documents.id, input.documentId),
          eq(documents.userId, input.userId)
        ),
      });

      if (!document) {
        throw new Error("Document not found");
      }

      // Fetch content from storage
      const contentBuffer = await storage.downloadBuffer(document.storageKey);
      const content =
        document.type === "pdf" || document.type === "docx"
          ? contentBuffer.toString("base64")
          : contentBuffer.toString("utf-8");

      return {
        document: {
          id: document.id,
          title: document.title,
          type: document.type,
          language: document.language,
          content,
          updatedAt: document.updatedAt,
          createdAt: document.createdAt,
        },
      };
    }),

  /**
   * Update entity (delegates to entities router)
   * Requires: hub-protocol.write scope
   */
  updateEntity: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        entityId: z.string().uuid(),
        userId: z.string(),
        title: z.string().optional(),
        preview: z.string().optional(),
        metadata: z.record(z.any()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Publish .requested event (handled by existing Inngest worker)
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "entities.update.requested",
        data: {
          entityId: input.entityId,
          title: input.title,
          preview: input.preview,
          metadata: input.metadata,
        },
        user: { id: input.userId },
      });

      return {
        status: "requested",
        message: "Entity update requested",
      };
    }),

  /**
   * Create document proposal (for AI edits)
   * Requires: hub-protocol.write scope
   */
  createDocumentProposal: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        documentId: z.string().uuid(),
        userId: z.string(),
        proposalType: z
          .enum(["ai_edit", "user_suggestion", "review_comment"])
          .default("ai_edit"),
        changes: z.array(
          z.object({
            op: z.enum(["insert", "delete", "replace"]),
            position: z.number().optional(),
            range: z.tuple([z.number(), z.number()]).optional(),
            text: z.string().optional(),
          })
        ),
        proposedContent: z.string(),
        originalContent: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { proposals } = await import("@synap/database/schema");

      // Calculate expiration (7 days)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      // Create proposal in DB
      // Verify document exists and get scope
      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, input.documentId),
      });

      if (!doc) {
        throw new Error("Document not found");
      }

      // Try to find context (workspace) via entity
      const entity = await db.query.entities.findFirst({
        where: eq(entities.documentId, input.documentId),
      });

      const workspaceId = entity?.workspaceId || doc.projectId || input.userId;

      // Create proposal in DB
      const [proposal] = await db
        .insert(proposals)
        .values({
          workspaceId: workspaceId,
          targetType: "document",
          targetId: input.documentId,
          request: {
            proposalType: input.proposalType,
            proposedBy: "ai",
            changes: input.changes,
            originalContent: input.originalContent,
            proposedContent: input.proposedContent,
            expiresAt: expiresAt.toISOString(),
          },
          status: "pending",
        })
        .returning();

      // Broadcast to user (real-time notification)
      const { broadcastSuccess } = await import("@synap/jobs");
      await broadcastSuccess(input.userId, "ai:proposal", {
        proposalId: proposal.id,
        operation: "create",
      });

      return {
        status: "proposed",
        proposalId: proposal.id,
        message: "Document edit proposed, awaiting approval",
      };
    }),
});
