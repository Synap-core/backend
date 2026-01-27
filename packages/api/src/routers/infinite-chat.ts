/**
 * Infinite Chat Router - tRPC routes for infinite chat with branching
 *
 * Handles:
 * - Thread management (chat_threads table)
 * - Message sending/receiving with Intelligence Hub
 * - Entity extraction
 * - Branching logic
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { db, eq, desc, and, or, lt, inArray } from "@synap/database";
import {
  chatThreads,
  conversationMessages,
  threadEntities,
  threadDocuments,
} from "@synap/database/schema";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import type { AIStep, HubResponse } from "@synap-core/types";
import type { ChatThread } from "@synap/database/schema";

/**
 * Infinite Chat Router (Week 2 implementation)
 *
 * Uses insertChatThreadSchema from database for true SSOT.
 */
export const infiniteChatRouter = router({
  /**
   * Create a new chat thread - Uses event sourcing for branch operations
   * Now includes context inheritance for branches via event-sourced executor
   */
  createThread: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid().optional(),
        parentThreadId: z.string().uuid().optional(),
        branchPurpose: z.string().optional(),
        agentId: z.string().optional(),
        agentType: z
          .enum([
            "meta",
            "default",
            "prompting",
            "knowledge-search",
            "code",
            "writing",
            "action",
          ])
          .optional(),
        agentConfig: z.record(z.string(), z.any()).optional(),
        inheritContext: z.boolean().default(true), // NEW: Inherit parent context
      })
    )
    .mutation(async ({ input, ctx }) => {
      const threadId = randomUUID();

      // Get workspaceId from parent thread if branch, otherwise from projectId
      let workspaceId: string | undefined = input.projectId || undefined;
      if (input.parentThreadId) {
        const parentThread = await db.query.chatThreads.findFirst({
          where: eq(chatThreads.id, input.parentThreadId),
        });
        workspaceId = parentThread?.projectId || undefined;
      }

      // If this is a branch, use event sourcing
      if (input.parentThreadId) {
        const { emitRequestEvent } = await import("../utils/emit-event.js");

        await emitRequestEvent({
          type: "chat_threads.branch.requested",
          subjectId: input.parentThreadId,
          subjectType: "chat_thread",
          data: {
            id: threadId,
            userId: ctx.userId,
            projectId: input.projectId,
            parentThreadId: input.parentThreadId,
            branchPurpose: input.branchPurpose,
            agentId: input.agentId,
            agentType: input.agentType,
            agentConfig: input.agentConfig,
            inheritContext: input.inheritContext,
          },
          userId: ctx.userId,
          workspaceId,
        });

        // Return immediately, executor will process async
        return {
          threadId,
          status: "requested",
          message: "Branch creation requested",
        };
      }

      // For main threads, create directly (no event sourcing needed)
      const [thread] = await db
        .insert(chatThreads)
        .values({
          id: threadId,
          userId: ctx.userId,
          projectId: input.projectId,
          threadType: "main",
          status: "active",
        })
        .returning();

      // Emit real-time events
      ctx.socketIO?.emit("thread:created", {
        threadId,
        userId: ctx.userId,
      });

      return { threadId, thread };
    }),

  /**
   * Send message to Intelligence Hub and get AI response (with streaming)
   */
  sendMessage: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        content: z.string().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { threadId, content } = input;

      // Get thread
      const thread = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, threadId),
      });

      if (!thread) {
        throw new Error("Thread not found");
      }

      // Save user message
      const userMessageId = randomUUID();
      const userMessageHash = createHash("sha256")
        .update(`${userMessageId}${content}`)
        .digest("hex");

      await db.insert(conversationMessages).values({
        id: userMessageId,
        threadId,
        role: "user",
        content,
        userId: ctx.userId,
        previousHash: "",
        hash: userMessageHash,
      });

      // Resolve intelligence service dynamically
      const resolvedService = await resolveIntelligenceService({
        userId: ctx.userId,
        workspaceId: thread.projectId ?? undefined,
        capability: "chat",
      });

      // Stream from Intelligence Service (now dynamic)
      let fullContent = "";
      const aiSteps: AIStep[] = [];
      let hubResponse: Partial<HubResponse> = { content: "" };

      try {
        const stream = resolvedService.client.sendMessageStream({
          query: content,
          threadId,
          userId: ctx.userId,
          agentId: thread.agentId ?? "orchestrator",
          agentType: thread.agentType ?? "meta",
          projectId: thread.projectId ?? undefined,
        });

        for await (const chunk of stream) {
          if (chunk.type === "chunk" && chunk.content) {
            fullContent += chunk.content;

            // Emit via Socket.IO
            ctx.socketIO?.emit("chat:stream", {
              threadId,
              type: "chunk",
              content: chunk.content,
              isComplete: false,
            });
          } else if (chunk.type === "step" && chunk.step) {
            aiSteps.push(chunk.step);

            // Emit AI step
            ctx.socketIO?.emit("ai:step", {
              threadId,
              messageId: userMessageId,
              step: chunk.step,
            });
          } else if (chunk.type === "entities" && chunk.entities) {
            // ✅ ADDED: Handle entities from stream
            hubResponse.entities = chunk.entities;
          } else if (chunk.type === "branch_decision" && chunk.decision) {
            // ✅ ADDED: Handle branch decision from stream
            hubResponse.branchDecision = chunk.decision;
          } else if (chunk.type === "complete") {
            // ✅ FIXED: Extract data from complete event
            if (chunk.data) {
              hubResponse = {
                ...hubResponse,
                ...(chunk.data as Partial<HubResponse>),
              };
            }

            // Final emission
            ctx.socketIO?.emit("chat:stream", {
              threadId,
              type: "complete",
              isComplete: true,
            });
          }
        }
      } catch (streamError) {
        console.error(
          "Streaming error, falling back to non-streaming:",
          streamError
        );

        // ✅ ADDED: Notify frontend of streaming failure (Issue #9)
        ctx.socketIO?.emit("chat:stream:error", {
          threadId,
          error:
            streamError instanceof Error
              ? streamError.message
              : "Streaming failed",
          fallback: true,
        });

        // Fallback to non-streaming using the same resolved service
        hubResponse = await resolvedService.client.sendMessage({
          query: content,
          threadId,
          userId: ctx.userId,
          agentId: thread.agentId ?? "orchestrator",
          agentType: thread.agentType ?? "meta",
          projectId: thread.projectId ?? undefined,
        });

        fullContent = hubResponse.content || "";
      }

      // Save assistant message
      const assistantMessageId = randomUUID();
      const assistantMessageHash = createHash("sha256")
        .update(`${assistantMessageId}${fullContent}${userMessageHash}`)
        .digest("hex");

      await db.insert(conversationMessages).values({
        id: assistantMessageId,
        threadId,
        role: "assistant",
        content: fullContent,
        userId: ctx.userId,
        previousHash: userMessageHash,
        hash: assistantMessageHash,
        metadata: {
          aiSteps: aiSteps.length > 0 ? aiSteps : hubResponse?.aiSteps || [],
          tokens: hubResponse?.usage?.totalTokens,
        } as any, // Drizzle JSONB type is flexible
      });

      // Create entities via event chain for consistency
      const createdEntities = [];
      const entities = hubResponse?.entities || [];

      if (entities.length > 0) {
        const { inngest } = await import("@synap/jobs");

        for (const entity of entities) {
          // ✅ Publish .requested event
          await inngest.send({
            name: "entities.create.requested",
            data: {
              type: entity.type,
              title: entity.title,
              preview: entity.description,
              userId: ctx.userId,
              source: "chat-extraction",
            },
            user: { id: ctx.userId },
          });

          createdEntities.push({
            type: entity.type,
            title: entity.title,
            status: "requested",
          });

          // Link entity to thread once it's created (will be done by worker)
          // For now, we'll link it when the entity is actually created
          // This will be handled by the entity creation worker
        }
      }

      // Emit real-time event for new message
      ctx.socketIO?.emit("chat:message", {
        threadId,
        message: {
          id: assistantMessageId,
          threadId,
          role: "assistant",
          content: fullContent,
          userId: ctx.userId,
          timestamp: new Date(),
          previousHash: userMessageHash,
          hash: assistantMessageHash,
          metadata: {
            aiSteps: aiSteps.length > 0 ? aiSteps : hubResponse?.aiSteps || [],
            tokens: hubResponse?.usage?.totalTokens,
          },
        },
        userId: ctx.userId,
      });

      // Create branch if decided
      let branchThread = undefined;
      const branchDecision = hubResponse?.branchDecision;
      if (branchDecision?.shouldBranch) {
        const branchId = randomUUID();
        const [branch] = await db
          .insert(chatThreads)
          .values({
            id: branchId,
            userId: ctx.userId,
            projectId: thread.projectId,
            parentThreadId: threadId,
            branchedFromMessageId: assistantMessageId,
            branchPurpose:
              branchDecision.suggestedPurpose || branchDecision.reason,
            agentId: branchDecision.suggestedAgentType || "research-agent",
            threadType: "branch",
            status: "active",
          })
          .returning();

        branchThread = branch;
      }

      await db
        .update(chatThreads)
        .set({ updatedAt: new Date() })
        .where(eq(chatThreads.id, threadId));

      return {
        messageId: assistantMessageId,
        content: fullContent,
        entities: createdEntities,
        branchDecision,
        branchThread,
        aiSteps,
      };
    }),

  /**
   * Get messages for a thread (with cursor pagination)
   */
  getMessages: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        cursor: z.string().uuid().optional(), // Message ID for pagination
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ input }) => {
      const messages = await db.query.conversationMessages.findMany({
        where: and(
          eq(conversationMessages.threadId, input.threadId),
          input.cursor
            ? lt(conversationMessages.id, input.cursor) // Cursor-based pagination
            : undefined
        ),
        orderBy: [desc(conversationMessages.timestamp)],
        limit: input.limit + 1, // Fetch one extra to check if there's more
      });

      const hasMore = messages.length > input.limit;
      const nextCursor = hasMore ? messages[input.limit - 1].id : undefined;

      return {
        messages: hasMore ? messages.slice(0, -1) : messages,
        nextCursor,
        hasMore,
      };
    }),

  /**
   * List threads
   */
  listThreads: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid().optional(),
        threadType: z.enum(["main", "branch"]).optional(),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ input, ctx }) => {
      const threads = await db.query.chatThreads.findMany({
        where: and(
          eq(chatThreads.userId, ctx.userId),
          input.projectId
            ? eq(chatThreads.projectId, input.projectId)
            : undefined,
          input.threadType
            ? eq(chatThreads.threadType, input.threadType)
            : undefined,
          eq(chatThreads.status, "active")
        ),
        orderBy: [desc(chatThreads.updatedAt)],
        limit: input.limit,
      });

      return { threads };
    }),

  /**
   * Get branches for a thread
   */
  getBranches: protectedProcedure
    .input(
      z.object({
        parentThreadId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      const branches = await db.query.chatThreads.findMany({
        where: eq(chatThreads.parentThreadId, input.parentThreadId),
        orderBy: [desc(chatThreads.createdAt)],
      });

      return { branches };
    }),

  /**
   * Merge branch - Uses event sourcing
   */
  mergeBranch: protectedProcedure
    .input(
      z.object({
        branchId: z.string().uuid(),
        summary: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const branch = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, input.branchId),
      });

      if (!branch || branch.threadType !== "branch") {
        throw new Error("Branch not found");
      }

      if (!branch.parentThreadId) {
        throw new Error("Branch has no parent thread");
      }

      // Use event sourcing
      const { emitRequestEvent } = await import("../utils/emit-event.js");

      await emitRequestEvent({
        type: "chat_threads.merge.requested",
        subjectId: input.branchId,
        subjectType: "chat_thread",
        data: {
          branchId: input.branchId,
          parentThreadId: branch.parentThreadId,
          summary: input.summary,
          userId: ctx.userId,
        },
        userId: ctx.userId,
        workspaceId: branch.projectId || undefined,
      });

      // Return immediately, executor will process async
      return {
        status: "requested",
        message: "Branch merge requested",
      };
    }),

  /**
   * Get single thread with optional context and branches
   */
  getThread: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        includeContext: z.boolean().default(true), // Include entities/documents
        includeBranches: z.boolean().default(false), // Include branch tree
      })
    )
    .query(async ({ input, ctx }) => {
      // Get thread
      const thread = await db.query.chatThreads.findFirst({
        where: and(
          eq(chatThreads.id, input.threadId),
          eq(chatThreads.userId, ctx.userId)
        ),
      });

      if (!thread) {
        throw new Error("Thread not found");
      }

      // Get context (entities/documents) if requested
      let entities: (typeof threadEntities.$inferSelect)[] = [];
      let documents: (typeof threadDocuments.$inferSelect)[] = [];

      if (input.includeContext) {
        entities = await db.query.threadEntities.findMany({
          where: eq(threadEntities.threadId, input.threadId),
        });

        documents = await db.query.threadDocuments.findMany({
          where: eq(threadDocuments.threadId, input.threadId),
        });
      }

      // Get branch tree if requested
      let branchTree: any = null;
      if (input.includeBranches) {
        const allBranches = await db.query.chatThreads.findMany({
          where: or(
            eq(chatThreads.id, input.threadId),
            eq(chatThreads.parentThreadId, input.threadId)
          ),
        });

        // Build tree structure
        branchTree = buildBranchTree(allBranches, input.threadId);
      }

      return {
        thread,
        entities: input.includeContext ? entities : undefined,
        documents: input.includeContext ? documents : undefined,
        branchTree: input.includeBranches ? branchTree : undefined,
      };
    }),

  /**
   * Update thread metadata
   */
  updateThread: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        title: z.string().optional(),
        agentId: z.string().optional(),
        agentType: z
          .enum([
            "meta",
            "default",
            "prompting",
            "knowledge-search",
            "code",
            "writing",
            "action",
          ])
          .optional(),
        agentConfig: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify thread exists and user owns it
      const thread = await db.query.chatThreads.findFirst({
        where: and(
          eq(chatThreads.id, input.threadId),
          eq(chatThreads.userId, ctx.userId)
        ),
      });

      if (!thread) {
        throw new Error("Thread not found");
      }

      // Update thread directly (simple operation, no event sourcing needed)
      await db
        .update(chatThreads)
        .set({
          title: input.title,
          agentId: input.agentId,
          agentType: input.agentType,
          agentConfig: input.agentConfig,
          updatedAt: new Date(),
        })
        .where(eq(chatThreads.id, input.threadId));

      // Emit real-time event
      ctx.socketIO?.emit("thread:updated", {
        threadId: input.threadId,
        userId: ctx.userId,
      });

      return {
        status: "updated",
        threadId: input.threadId,
      };
    }),

  /**
   * Archive thread (soft delete)
   */
  archiveThread: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify thread exists and user owns it
      const thread = await db.query.chatThreads.findFirst({
        where: and(
          eq(chatThreads.id, input.threadId),
          eq(chatThreads.userId, ctx.userId)
        ),
      });

      if (!thread) {
        throw new Error("Thread not found");
      }

      // Update status to archived
      await db
        .update(chatThreads)
        .set({
          status: "archived",
          updatedAt: new Date(),
        })
        .where(eq(chatThreads.id, input.threadId));

      // Emit real-time event
      ctx.socketIO?.emit("thread:archived", {
        threadId: input.threadId,
        userId: ctx.userId,
      });

      return {
        status: "archived",
        threadId: input.threadId,
      };
    }),

  /**
   * Get branch tree structure (not flat list)
   */
  getBranchTree: protectedProcedure
    .input(
      z.object({
        rootThreadId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      // Get all threads in the tree (root + all descendants)
      const allThreads = await db.query.chatThreads.findMany({
        where: and(
          or(
            eq(chatThreads.id, input.rootThreadId),
            eq(chatThreads.parentThreadId, input.rootThreadId)
          ),
          eq(chatThreads.userId, ctx.userId)
        ),
      });

      // Build tree structure
      const tree = buildBranchTree(allThreads, input.rootThreadId);

      // Categorize branches
      const activeBranches = allThreads.filter(
        (t) => t.status === "active" && t.threadType === "branch"
      );
      const mergedBranches = allThreads.filter(
        (t) => t.status === "merged" && t.threadType === "branch"
      );

      return {
        tree,
        flatBranches: allThreads.filter((t) => t.threadType === "branch"),
        activeBranches,
        mergedBranches,
      };
    }),

  /**
   * Get thread context (entities and documents)
   */
  getThreadContext: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        relationshipTypes: z
          .array(
            z.enum([
              "used_as_context",
              "created",
              "updated",
              "referenced",
              "inherited_from_parent",
            ])
          )
          .optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      // Verify thread exists and user owns it
      const thread = await db.query.chatThreads.findFirst({
        where: and(
          eq(chatThreads.id, input.threadId),
          eq(chatThreads.userId, ctx.userId)
        ),
      });

      if (!thread) {
        throw new Error("Thread not found");
      }

      // Build where clause
      const whereClause = and(
        eq(threadEntities.threadId, input.threadId),
        input.relationshipTypes
          ? inArray(threadEntities.relationshipType, input.relationshipTypes)
          : undefined
      );

      // Get entities
      const entities = await db.query.threadEntities.findMany({
        where: whereClause,
      });

      // Get documents
      const documents = await db.query.threadDocuments.findMany({
        where: and(
          eq(threadDocuments.threadId, input.threadId),
          input.relationshipTypes
            ? inArray(threadDocuments.relationshipType, input.relationshipTypes)
            : undefined
        ),
      });

      return {
        entities,
        documents,
      };
    }),
});

/**
 * Helper function to build branch tree structure
 */
function buildBranchTree(
  threads: ChatThread[],
  rootId: string
): { thread: ChatThread; children: any[] } | null {
  const root = threads.find((t) => t.id === rootId);
  if (!root) return null;

  const children = threads
    .filter((t) => t.parentThreadId === rootId)
    .map((child) => buildBranchTree(threads, child.id))
    .filter(Boolean) as any[];

  return {
    thread: root,
    children,
  };
}
