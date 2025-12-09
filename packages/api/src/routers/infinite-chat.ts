/**
 * Infinite Chat Router - tRPC routes for infinite chat with branching
 * 
 * Handles:
 * - Thread management (chat_threads table)
 * - Message sending/receiving with Intelligence Hub
 * - Entity extraction
 * - Branching logic
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { db, eq, desc, and } from '@synap/database';
import { chatThreads, conversationMessages, entities } from '@synap/database/schema';
import { intelligenceHubClient } from '../clients/intelligence-hub.js';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';

/**
 * Infinite Chat Router (Week 2 implementation)
 */
export const infiniteChatRouter = router({
  /**
   * Create a new chat thread
   */
  createThread: protectedProcedure
    .input(z.object({
      projectId: z.string().uuid().optional(),
      parentThreadId: z.string().uuid().optional(),
      branchPurpose: z.string().optional(),
      agentId: z.string().default('orchestrator'),
    }))
    .mutation(async ({ input, ctx }) => {
      const threadId = randomUUID();
      
      const [thread] = await db.insert(chatThreads).values({
        id: threadId,
        userId: ctx.userId,
        projectId: input.projectId,
        parentThreadId: input.parentThreadId,
        branchPurpose: input.branchPurpose,
        agentId: input.agentId,
        threadType: input.parentThreadId ? 'branch' : 'main',
        status: 'active',
      }).returning();
      
      return { threadId, thread };
    }),
  
  /**
   * Send message to Intelligence Hub and get AI response
   */
  sendMessage: protectedProcedure
    .input(z.object({
      threadId: z.string().uuid(),
      content: z.string().min(1),
    }))
    .mutation(async ({ input, ctx }) => {
      const { threadId, content } = input;
      
      // Get thread
      const thread = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, threadId),
      });
      
      if (!thread) {
        throw new Error('Thread not found');
      }
      
      // Save user message
      const userMessageId = randomUUID();
      const userMessageHash = createHash('sha256')
        .update(`${userMessageId}${content}`)
        .digest('hex');
      
      await db.insert(conversationMessages).values({
        id: userMessageId,
        threadId,
        role: 'user',
        content,
        userId: ctx.userId,
        previousHash: '',
        hash: userMessageHash,
      });
      
      // Call Intelligence Hub
      const hubResponse = await intelligenceHubClient.sendMessage({
        query: content,
        threadId,
        userId: ctx.userId,
        agentId: thread.agentId ?? 'orchestrator',
        projectId: thread.projectId ?? undefined,
      });
      
      // Save assistant message
      const assistantMessageId = randomUUID();
      const assistantMessageHash = createHash('sha256')
        .update(`${assistantMessageId}${hubResponse.content}${userMessageHash}`)
        .digest('hex');
      
      await db.insert(conversationMessages).values({
        id: assistantMessageId,
        threadId,
        role: 'assistant',
        content: hubResponse.content,
        userId: ctx.userId,
        previousHash: userMessageHash,
        hash: assistantMessageHash,
        metadata: hubResponse.usage ? {
          tokens: hubResponse.usage.totalTokens,
        } : undefined,
      });
      
      // Create entities (without the non-existent columns)
      const createdEntities = [];
      if (hubResponse.entities?.length > 0) {
        for (const entity of hubResponse.entities) {
          const [created] = await db.insert(entities).values({
            userId: ctx.userId,
            type: entity.type,
            title: entity.title,
            preview: entity.description,
          }).returning();
          
          createdEntities.push(created);
        }
      }
      
      // Create branch if decided
      let branchThread = undefined;
      if (hubResponse.branchDecision?.shouldBranch) {
        const branchId = randomUUID();
        const [branch] = await db.insert(chatThreads).values({
          id: branchId,
          userId: ctx.userId,
          projectId: thread.projectId,
          parentThreadId: threadId,
          branchedFromMessageId: assistantMessageId,
          branchPurpose: hubResponse.branchDecision.purpose,
          agentId: hubResponse.branchDecision.agentId || 'research-agent',
          threadType: 'branch',
          status: 'active',
        }).returning();
        
        branchThread = branch;
      }
      
      await db.update(chatThreads)
        .set({ updatedAt: new Date() })
        .where(eq(chatThreads.id, threadId));
      
      return {
        messageId: assistantMessageId,
        content: hubResponse.content,
        entities: createdEntities,
        branchDecision: hubResponse.branchDecision,
        branchThread,
        thinkingSteps: hubResponse.thinkingSteps,
      };
    }),
  
  /**
   * Get messages for a thread
   */
  getMessages: protectedProcedure
    .input(z.object({
      threadId: z.string().uuid(),
      limit: z.number().min(1).max(100).default(50),
    }))
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
    .input(z.object({
      projectId: z.string().uuid().optional(),
      threadType: z.enum(['main', 'branch']).optional(),
      limit: z.number().min(1).max(100).default(20),
    }))
    .query(async ({ input, ctx }) => {
      const threads = await db.query.chatThreads.findMany({
        where: and(
          eq(chatThreads.userId, ctx.userId),
          input.projectId ? eq(chatThreads.projectId, input.projectId) : undefined,
          input.threadType ? eq(chatThreads.threadType, input.threadType) : undefined,
          eq(chatThreads.status, 'active')
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
    .input(z.object({
      parentThreadId: z.string().uuid(),
    }))
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
    .input(z.object({
      branchId: z.string().uuid(),
    }))
    .mutation(async ({ input, ctx }) => {
      const branch = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, input.branchId),
      });
      
      if (!branch || branch.threadType !== 'branch') {
        throw new Error('Branch not found');
      }
      
      const messages = await db.query.conversationMessages.findMany({
        where: eq(conversationMessages.threadId, input.branchId),
        orderBy: [desc(conversationMessages.timestamp)],
      });
      
      const summary = `Branch: ${branch.branchPurpose}\nCompleted with ${messages.length} messages.`;
      
      if (branch.parentThreadId) {
        await db.update(chatThreads)
          .set({
            contextSummary: summary,
            updatedAt: new Date(),
          })
          .where(eq(chatThreads.id, branch.parentThreadId));
        
        await db.insert(conversationMessages).values({
          threadId: branch.parentThreadId,
          role: 'system',
          content: `✅ ${branch.branchPurpose}: ${summary}`,
          userId: ctx.userId,
          previousHash: '',
          hash: randomUUID(),
        });
      }
      
      await db.update(chatThreads)
        .set({
          status: 'merged',
          mergedAt: new Date(),
        })
        .where(eq(chatThreads.id, input.branchId));
      
      return { summary };
    }),
});
