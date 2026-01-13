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
import { db, eq, desc, and } from "@synap/database";
import {
  chatThreads,
  conversationMessages,
  insertChatThreadSchema,
} from "@synap/database/schema";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import { randomUUID } from "crypto";
import { createHash } from "crypto";

/**
 * Infinite Chat Router (Week 2 implementation)
 *
 * Uses insertChatThreadSchema from database for true SSOT.
 */
export const infiniteChatRouter = router({
  /**
   * Create a new chat thread - TRUE SSOT using .omit()
   */
  createThread: protectedProcedure
    .input(
      insertChatThreadSchema.omit({
        id: true, // Auto-generated UUID
        userId: true, // From context (ctx.userId)
        title: true, // Generated after first message
        threadType: true, // Derived from parentThreadId
        status: true, // Has default value 'active'
        contextSummary: true, // Updated as thread progresses
        metadata: true, // Optional runtime metadata
        createdAt: true, // Auto-generated timestamp
        updatedAt: true, // Auto-generated timestamp
        mergedAt: true, // Only set when merged
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const threadId = randomUUID();

      const [thread] = await db
        .insert(chatThreads)
        .values({
          id: threadId,
          userId: ctx.userId,
          projectId: input.projectId,
          parentThreadId: input.parentThreadId,
          branchPurpose: input.branchPurpose,
          agentId: input.agentId,
          agentType: input.agentType, // NEW: Agent type for multi-agent routing
          agentConfig: input.agentConfig, // NEW: Custom agent configuration
          threadType: input.parentThreadId ? "branch" : "main",
          status: "active",
        })
        .returning();

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
      }),
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
        capability: 'chat'
      });

      // Stream from Intelligence Service (now dynamic)
      let fullContent = "";
      const aiSteps: any[] = [];
      let hubResponse: any = null;

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
            hubResponse = { ...hubResponse, entities: chunk.entities };
          } else if (chunk.type === "branch_decision" && chunk.decision) {
            // ✅ ADDED: Handle branch decision from stream
            hubResponse = { ...hubResponse, branchDecision: chunk.decision };
          } else if (chunk.type === "complete") {
            // ✅ FIXED: Extract data from complete event
            if (chunk.data) {
              hubResponse = chunk.data;
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
          streamError,
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

        fullContent = hubResponse.content;
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
          aiSteps:
            aiSteps.length > 0 ? aiSteps : hubResponse?.thinkingSteps || [],
          tokens: hubResponse?.usage?.totalTokens,
        } as any,
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
        }
      }

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
            branchPurpose: branchDecision.purpose,
            agentId: branchDecision.agentId || "research-agent",
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
   * Get messages for a thread
   */
  getMessages: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        limit: z.number().min(1).max(100).default(50),
      }),
    )
    .query(async ({ input }) => {
      const messages = await db.query.conversationMessages.findMany({
        where: eq(conversationMessages.threadId, input.threadId),
        orderBy: [desc(conversationMessages.timestamp)],
        limit: input.limit + 1,
      });

      const hasMore = messages.length > input.limit;

      return {
        messages: hasMore ? messages.slice(0, -1) : messages,
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
      }),
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
          eq(chatThreads.status, "active"),
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
      }),
    )
    .query(async ({ input }) => {
      const branches = await db.query.chatThreads.findMany({
        where: eq(chatThreads.parentThreadId, input.parentThreadId),
        orderBy: [desc(chatThreads.createdAt)],
      });

      return { branches };
    }),

  /**
   * Merge branch
   */
  mergeBranch: protectedProcedure
    .input(
      z.object({
        branchId: z.string().uuid(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const branch = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, input.branchId),
      });

      if (!branch || branch.threadType !== "branch") {
        throw new Error("Branch not found");
      }

      const messages = await db.query.conversationMessages.findMany({
        where: eq(conversationMessages.threadId, input.branchId),
        orderBy: [desc(conversationMessages.timestamp)],
      });

      const summary = `Branch: ${branch.branchPurpose}\nCompleted with ${messages.length} messages.`;

      if (branch.parentThreadId) {
        await db
          .update(chatThreads)
          .set({
            contextSummary: summary,
            updatedAt: new Date(),
          })
          .where(eq(chatThreads.id, branch.parentThreadId));

        await db.insert(conversationMessages).values({
          threadId: branch.parentThreadId,
          role: "system",
          content: `✅ ${branch.branchPurpose}: ${summary}`,
          userId: ctx.userId,
          previousHash: "",
          hash: randomUUID(),
        });
      }

      await db
        .update(chatThreads)
        .set({
          status: "merged",
          mergedAt: new Date(),
        })
        .where(eq(chatThreads.id, input.branchId));

      return { summary };
    }),
});
