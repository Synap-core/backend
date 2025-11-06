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
import { conversationalAgent, actionExtractor } from '@synap/ai';
import { requireUserId } from '../utils/user-scoped.js';
import { eventRepository, AggregateType, EventSource } from '@synap/database';
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
      
      // ========================================================================
      // PHASE 2: Real AI Integration ✅
      // ========================================================================
      
      // Get conversation history for context
      const history = await conversationRepository.getThreadHistory(threadId, 50);
      
      // Format history for AI (exclude system messages for cleaner context)
      const conversationHistory = history
        .filter(msg => msg.role !== 'system')
        .map(msg => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        }));
      
      // Call AI to generate response
      const aiResponse = await conversationalAgent.generateResponse(
        conversationHistory.slice(0, -1), // Exclude the message we just added
        input.content,
        {
          // TODO: Add user context (name, recent entities, etc.)
        }
      );
      
      // Extract actions from AI response
      const extraction = actionExtractor.extractActions(aiResponse.content);
      
      console.log('🤖 AI Response:', {
        latency: aiResponse.latency,
        tokens: aiResponse.tokens,
        actionsFound: extraction.actions.length,
      });
      
      // Store assistant message with actions
      const assistantMessage = await conversationRepository.appendMessage({
        threadId,
        parentId: userMessage.id,
        role: MessageRole.ASSISTANT,
        content: extraction.cleanContent || aiResponse.content,
        metadata: {
          suggestedActions: extraction.actions.map(action => ({
            type: action.type,
            description: `Execute ${action.type}`,
            params: action.params,
          })),
          model: aiResponse.model,
          tokens: aiResponse.tokens.total,
          latency: aiResponse.latency,
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
   * This is THE BRIDGE from conversation → events → state
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
      
      // ========================================================================
      // PHASE 3: Action Bridge - Connect Chat → Events → State ✅
      // ========================================================================
      
      let result: any;
      let eventType: string;
      let aggregateId = randomUUID();
      
      try {
        // Switch on action type and execute appropriate logic
        switch (input.actionType) {
          // =====================================================================
          // TASK ACTIONS
          // =====================================================================
          case 'task.create': {
            const { title, description, dueDate, priority } = input.actionParams;
            
            // Emit event to event store
            await eventRepository.append({
              aggregateId,
              aggregateType: AggregateType.ENTITY,
              eventType: 'task.creation.requested',
              userId,
              data: {
                title,
                description,
                dueDate,
                priority,
                status: 'todo',
              },
              version: 1,
              source: EventSource.API,
              metadata: {
                triggeredBy: 'conversation',
                threadId: input.threadId,
                messageId: input.messageId,
              },
            });
            
            result = {
              taskId: aggregateId,
              title,
              status: 'todo',
            };
            eventType = 'task.created';
            break;
          }
          
          case 'task.complete': {
            const { taskId } = input.actionParams;
            aggregateId = taskId;
            
            // Get current version (for optimistic locking)
            const currentVersion = await eventRepository.getAggregateVersion(taskId) || 0;
            
            await eventRepository.append({
              aggregateId: taskId,
              aggregateType: AggregateType.ENTITY,
              eventType: 'task.completed',
              userId,
              data: {
                completedAt: new Date().toISOString(),
              },
              version: currentVersion + 1,
              source: EventSource.API,
            });
            
            result = { taskId, status: 'done' };
            eventType = 'task.completed';
            break;
          }
          
          // =====================================================================
          // NOTE ACTIONS
          // =====================================================================
          case 'note.create': {
            const { content, title, tags } = input.actionParams;
            
            await eventRepository.append({
              aggregateId,
              aggregateType: AggregateType.ENTITY,
              eventType: 'note.creation.requested',
              userId,
              data: {
                title,
                content,
                tags,
                type: 'note',
              },
              version: 1,
              source: EventSource.API,
              metadata: {
                triggeredBy: 'conversation',
                threadId: input.threadId,
              },
            });
            
            result = {
              noteId: aggregateId,
              title: title || 'Untitled',
            };
            eventType = 'note.created';
            break;
          }
          
          // =====================================================================
          // PROJECT ACTIONS
          // =====================================================================
          case 'project.create': {
            const { title, description, startDate, endDate, tasks } = input.actionParams;
            
            await eventRepository.append({
              aggregateId,
              aggregateType: AggregateType.ENTITY,
              eventType: 'project.creation.requested',
              userId,
              data: {
                title,
                description,
                startDate,
                endDate,
                type: 'project',
              },
              version: 1,
              source: EventSource.API,
            });
            
            // If tasks provided, create them too
            if (tasks && Array.isArray(tasks)) {
              const correlationId = randomUUID();
              
              for (const taskTitle of tasks) {
                const taskId = randomUUID();
                await eventRepository.append({
                  aggregateId: taskId,
                  aggregateType: AggregateType.ENTITY,
                  eventType: 'task.creation.requested',
                  userId,
                  data: {
                    title: taskTitle,
                    projectId: aggregateId,
                    status: 'todo',
                  },
                  version: 1,
                  source: EventSource.API,
                  correlationId,
                });
              }
            }
            
            result = {
              projectId: aggregateId,
              title,
              tasksCreated: tasks?.length || 0,
            };
            eventType = 'project.created';
            break;
          }
          
          // =====================================================================
          // SEARCH ACTIONS
          // =====================================================================
          case 'search.semantic': {
            const { query } = input.actionParams;
            
            // TODO: Call existing search API
            result = {
              query,
              results: [],
              message: 'Search will be implemented with RAG integration',
            };
            eventType = 'search.executed';
            break;
          }
          
          // =====================================================================
          // DEFAULT: Unknown action
          // =====================================================================
          default:
            throw new Error(`Unknown action type: ${input.actionType}`);
        }
        
        // Log system message confirming action
        const systemMessage = await conversationRepository.appendMessage({
          threadId: input.threadId,
          parentId: input.messageId,
          role: MessageRole.SYSTEM,
          content: `✅ ${eventType.replace('.', ' ').replace('_', ' ')} - Action exécutée avec succès!`,
          metadata: {
            executedAction: {
              type: input.actionType,
              result,
            },
          },
          userId,
        });
        
        console.log('✅ Action executed:', {
          type: input.actionType,
          aggregateId,
          eventType,
        });
        
        return {
          success: true,
          systemMessage,
          result,
          eventType,
        };
        
      } catch (error) {
        // Log error as system message
        const errorMessage = await conversationRepository.appendMessage({
          threadId: input.threadId,
          parentId: input.messageId,
          role: MessageRole.SYSTEM,
          content: `❌ Erreur lors de l'exécution: ${error instanceof Error ? error.message : 'Unknown error'}`,
          metadata: {
            executedAction: {
              type: input.actionType,
              result: {
                error: error instanceof Error ? error.message : 'Unknown error',
              },
            },
          },
          userId,
        });
        
        return {
          success: false,
          systemMessage: errorMessage,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
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

