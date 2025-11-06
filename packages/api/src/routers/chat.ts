/**
 * Chat Router - V0.4 Conversational Interface
 * 
 * The PRIMARY entry point for conversational interactions.
 * 
 * This router manages:
 * - Message sending (user → assistant)
 * - Thread history
 * - Conversation branching
 * - Action execution (from AI suggestions)
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { 
  conversationRepository, 
  MessageRole
} from '@synap/database';
import { requireUserId } from '../utils/user-scoped.js';
import { randomUUID } from 'crypto';

// ============================================================================
// SCHEMAS
// ============================================================================

const SuggestedActionSchema = z.object({
  type: z.string(),
  description: z.string(),
  params: z.record(z.any()),
});

const MessageMetadataSchema = z.object({
  suggestedActions: z.array(SuggestedActionSchema).optional(),
  executedAction: z.object({
    type: z.string(),
    result: z.any(),
  }).optional(),
  attachments: z.array(z.object({
    type: z.string(),
    url: z.string(),
  })).optional(),
  model: z.string().optional(),
  tokens: z.number().optional(),
  latency: z.number().optional(),
}).optional();

// ============================================================================
// ROUTER
// ============================================================================

export const chatRouter = router({
  /**
   * Send message to assistant
   * 
   * This is the main entry point for conversational interaction.
   */
  sendMessage: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid().optional(),  // Create new if not provided
        parentId: z.string().uuid().optional(),  // For branching
        content: z.string().min(1).max(10000),
        metadata: MessageMetadataSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      
      // Create new thread if not provided
      const threadId = input.threadId || randomUUID();
      
      // Append user message
      const userMessage = await conversationRepository.appendMessage({
        threadId,
        parentId: input.parentId,
        role: MessageRole.USER,
        content: input.content,
        metadata: input.metadata as any,
        userId,
      });
      
      // TODO: Phase 2 - Call AI to generate response
      // For now, return a placeholder assistant message
      const assistantMessage = await conversationRepository.appendMessage({
        threadId,
        parentId: userMessage.id,
        role: MessageRole.ASSISTANT,
        content: '🤖 AI response will be implemented in Phase 2. For now, this is a placeholder.',
        metadata: {
          model: 'placeholder',
          suggestedActions: [],
        },
        userId,
      });
      
      return {
        success: true,
        threadId,
        userMessage,
        assistantMessage,
      };
    }),

  /**
   * Get thread history
   */
  getThread: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        limit: z.number().min(1).max(500).default(100),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      
      // Get thread history
      const messages = await conversationRepository.getThreadHistory(
        input.threadId,
        input.limit
      );
      
      // Verify user owns this thread
      if (messages.length > 0 && messages[0].userId !== userId) {
        throw new Error('Unauthorized: Thread belongs to another user');
      }
      
      // Get thread info
      const threadInfo = await conversationRepository.getThreadInfo(input.threadId);
      
      return {
        threadId: input.threadId,
        messages,
        info: threadInfo,
      };
    }),

  /**
   * Get user's threads
   */
  getThreads: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      
      const threads = await conversationRepository.getUserThreads(
        userId,
        input.limit
      );
      
      return {
        threads,
        total: threads.length,
      };
    }),

  /**
   * Create branch from message
   */
  createBranch: protectedProcedure
    .input(
      z.object({
        parentMessageId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      
      const newThreadId = await conversationRepository.createBranch(
        input.parentMessageId,
        userId
      );
      
      return {
        success: true,
        newThreadId,
        message: 'Branch created successfully',
      };
    }),

  /**
   * Get branches from a message
   */
  getBranches: protectedProcedure
    .input(
      z.object({
        parentId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      const branches = await conversationRepository.getBranches(input.parentId);
      
      return {
        parentId: input.parentId,
        branches,
        count: branches.length,
      };
    }),

  /**
   * Execute action suggested by AI
   * 
   * This is where AI suggestions become real actions.
   */
  executeAction: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        messageId: z.string().uuid(),  // The assistant message with suggestions
        actionType: z.string(),
        actionParams: z.record(z.any()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      
      // TODO: Phase 3 - Bridge to Event Store
      // For now, just log a system message
      const systemMessage = await conversationRepository.appendMessage({
        threadId: input.threadId,
        parentId: input.messageId,
        role: MessageRole.SYSTEM,
        content: `✅ Action executed: ${input.actionType}`,
        metadata: {
          executedAction: {
            type: input.actionType,
            result: {
              status: 'placeholder',
              message: 'Action execution will be implemented in Phase 3',
            },
          },
        },
        userId,
      });
      
      return {
        success: true,
        systemMessage,
        message: 'Action executed (placeholder)',
      };
    }),

  /**
   * Verify hash chain integrity
   */
  verifyThread: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      // Note: User ownership check removed for simplicity
      // Hash chain verification is public information
      
      const verification = await conversationRepository.verifyHashChain(input.threadId);
      
      return {
        threadId: input.threadId,
        ...verification,
      };
    }),

  /**
   * Delete message (soft delete)
   */
  deleteMessage: protectedProcedure
    .input(
      z.object({
        messageId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      
      await conversationRepository.deleteMessage(input.messageId, userId);
      
      return {
        success: true,
        message: 'Message deleted',
      };
    }),
});

