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
import { conversationService, MessageRoleSchema } from '@synap/domain';
import { requireUserId } from '../utils/user-scoped.js';
import { randomUUID } from 'crypto';
import { ForbiddenError, ValidationError } from '@synap/core';
import { createLogger } from '@synap/core';
import { aiRateLimitMiddleware } from '../middleware/ai-rate-limit.js';
import { publishEvent } from '../utils/inngest-client.js';
import { createSynapEvent, GeneratedEventTypes } from '@synap/types';
import { getEventRepository } from '@synap/database';

const chatLogger = createLogger({ module: 'chat-router' });

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
    .use(aiRateLimitMiddleware) // V1.0: Stricter rate limiting for AI endpoints
    .input(
      z.object({
        threadId: z.string().uuid().optional(),  // Create new if not provided
        parentId: z.string().uuid().optional(),  // For branching
        content: z.string().min(1).max(10000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const threadId = input.threadId || randomUUID();
      const requestId = randomUUID();
      const correlationId = randomUUID();
      const log = chatLogger.child({ userId, threadId, requestId });

      log.info({ parentId: input.parentId }, 'Received chat message - publishing event');

      // V1.0 Event-Driven: Publish event instead of calling services directly
      // The handler will process the message and generate the response
      const event = createSynapEvent({
        type: GeneratedEventTypes.conversationMessages['create.requested'],
        userId,
        aggregateId: threadId,
        data: {
          threadId,
          parentId: input.parentId,
          content: input.content,
        },
        source: 'api',
        requestId,
        correlationId,
      });

      // Append to Event Store
      const eventRepo = getEventRepository();
      await eventRepo.append(event);

      // Publish to Inngest (for async processing)
      await publishEvent('api/event.logged', {
        id: event.id,
        type: event.type,
        aggregateId: event.aggregateId,
        aggregateType: 'conversation',
        userId: event.userId,
        version: 1,
        timestamp: event.timestamp.toISOString(),
        data: event.data,
        metadata: { version: event.version, requestId: event.requestId },
        source: event.source,
        causationId: event.causationId,
        correlationId: event.correlationId,
        requestId: event.requestId,
      }, userId);

      log.info({ requestId, eventId: event.id }, 'Published conversation.message.sent event');

      // V0.7: Real-time feedback via WebSocket
      // Return immediately with requestId - client should subscribe to WebSocket
      // for real-time updates via useSynapRealtime hook
      
      return {
        success: true,
        status: 'pending' as const,
        requestId,
        threadId,
        message: 'Message sent. Response is being generated. Subscribe to WebSocket for real-time updates.',
        // WebSocket URL for client to connect
        websocketUrl: process.env.REALTIME_URL 
          ? `${process.env.REALTIME_URL.replace(/^https?/, 'wss')}/rooms/user_${userId}/subscribe`
          : `wss://realtime.synap.app/rooms/user_${userId}/subscribe`,
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
      const messages = await conversationService.getThreadHistory(
        input.threadId,
        input.limit
      );
      
      // Verify user owns this thread
      if (messages.length > 0 && messages[0].userId !== userId) {
        throw new ForbiddenError('Thread belongs to another user', { threadId: input.threadId });
      }
      
      // Get thread info
      const threadInfo = await conversationService.getThreadInfo(input.threadId);
      
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
      
      const threads = await conversationService.getUserThreads(
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
      
      const newThreadId = await conversationService.createBranch(
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
      const branches = await conversationService.getBranches(input.parentId);
      
      return {
        parentId: input.parentId,
        branches,
        count: branches.length,
      };
    }),

  /**
   * Execute action suggested by AI
   * 
   * V0.6: Pure Event-Driven - Publishes intent events only, no business logic
   * 
   * This is THE BRIDGE from conversation → events → state
   * All business logic is handled by workers (Epic 2)
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
      const log = chatLogger.child({
        userId,
        threadId: input.threadId,
        messageId: input.messageId,
        actionType: input.actionType,
      });

      const requestId = randomUUID();
      const correlationId = randomUUID();
      let aggregateId = randomUUID();
      let eventType: string;
      let result: any;

      try {
        // Switch on action type and publish intent events
        switch (input.actionType) {
          // =====================================================================
          // TASK ACTIONS
          // =====================================================================
          case 'task.create': {
            const { title, description, dueDate, priority } = input.actionParams;
            
            // Create and publish intent event
            const event = createSynapEvent({
              type: GeneratedEventTypes.entities['create.requested'],
              userId,
              aggregateId,
              data: {
                title,
                description,
                dueDate,
                priority,
                status: 'todo',
              },
              source: 'api',
              requestId,
              correlationId,
              metadata: {
                triggeredBy: 'conversation',
                threadId: input.threadId,
                messageId: input.messageId,
              },
            });

            // Append to Event Store
            const eventRepo = getEventRepository();
            await eventRepo.append(event);

            // Publish to Inngest
            await publishEvent('api/event.logged', {
              id: event.id,
              type: event.type,
              aggregateId: event.aggregateId,
              aggregateType: 'entity',
              userId: event.userId,
              version: 1,
              timestamp: event.timestamp.toISOString(),
              data: event.data,
              metadata: { version: event.version, requestId: event.requestId },
              source: event.source,
              causationId: event.causationId,
              correlationId: event.correlationId,
              requestId: event.requestId,
            }, userId);
            
            result = {
              taskId: aggregateId,
              title,
              status: 'todo',
            };
            eventType = GeneratedEventTypes.entities['create.requested'];
            break;
          }
          
          case 'task.complete': {
            const { taskId } = input.actionParams;
            aggregateId = taskId;
            
            // Create and publish intent event
            const event = createSynapEvent({
              type: GeneratedEventTypes.entities['update.requested'],
              userId,
              aggregateId: taskId,
              data: {
                completedAt: new Date().toISOString(),
              },
              source: 'api',
              requestId,
              correlationId,
              metadata: {
                triggeredBy: 'conversation',
                threadId: input.threadId,
                messageId: input.messageId,
              },
            });

            // Append to Event Store
            const eventRepo = getEventRepository();
            await eventRepo.append(event);

            // Publish to Inngest
            await publishEvent('api/event.logged', {
              id: event.id,
              type: event.type,
              aggregateId: event.aggregateId,
              aggregateType: 'entity',
              userId: event.userId,
              version: 1,
              timestamp: event.timestamp.toISOString(),
              data: event.data,
              metadata: { version: event.version, requestId: event.requestId },
              source: event.source,
              causationId: event.causationId,
              correlationId: event.correlationId,
              requestId: event.requestId,
            }, userId);
            
            result = { taskId, status: 'pending' };
            eventType = GeneratedEventTypes.entities['update.requested'];
            break;
          }
          
          // =====================================================================
          // NOTE ACTIONS
          // =====================================================================
          case 'note.create': {
            const { content, title, tags } = input.actionParams;
            
            // Create and publish intent event
            const event = createSynapEvent({
              type: GeneratedEventTypes.entities['create.requested'],
              userId,
              aggregateId,
              data: {
                title,
                content,
                tags,
                type: 'note',
              },
              source: 'api',
              requestId,
              correlationId,
              metadata: {
                triggeredBy: 'conversation',
                threadId: input.threadId,
                messageId: input.messageId,
              },
            });

            // Append to Event Store
            const eventRepo = getEventRepository();
            await eventRepo.append(event);

            // Publish to Inngest
            await publishEvent('api/event.logged', {
              id: event.id,
              type: event.type,
              aggregateId: event.aggregateId,
              aggregateType: 'entity',
              userId: event.userId,
              version: 1,
              timestamp: event.timestamp.toISOString(),
              data: event.data,
              metadata: { version: event.version, requestId: event.requestId },
              source: event.source,
              causationId: event.causationId,
              correlationId: event.correlationId,
              requestId: event.requestId,
            }, userId);
            
            result = {
              noteId: aggregateId,
              title: title || 'Untitled',
            };
            eventType = GeneratedEventTypes.entities['create.requested'];
            break;
          }
          
          // =====================================================================
          // PROJECT ACTIONS
          // =====================================================================
          case 'project.create': {
            const { title, description, startDate, endDate, tasks } = input.actionParams;
            
            // Create and publish project creation intent event
            const projectEvent = createSynapEvent({
              type: GeneratedEventTypes.entities['create.requested'],
              userId,
              aggregateId,
              data: {
                title,
                description,
                startDate,
                endDate,
                type: 'project',
              },
              source: 'api',
              requestId,
              correlationId,
              metadata: {
                triggeredBy: 'conversation',
                threadId: input.threadId,
                messageId: input.messageId,
              },
            });

            // Append to Event Store
            const eventRepo = getEventRepository();
            await eventRepo.append(projectEvent);

            // Publish to Inngest
            await publishEvent('api/event.logged', {
              id: projectEvent.id,
              type: projectEvent.type,
              aggregateId: projectEvent.aggregateId,
              aggregateType: 'entity',
              userId: projectEvent.userId,
              version: 1,
              timestamp: projectEvent.timestamp.toISOString(),
              data: projectEvent.data,
              metadata: { version: projectEvent.version, requestId: projectEvent.requestId },
              source: projectEvent.source,
              causationId: projectEvent.causationId,
              correlationId: projectEvent.correlationId,
              requestId: projectEvent.requestId,
            }, userId);
            
            // If tasks provided, create them too (publish separate events)
            if (tasks && Array.isArray(tasks)) {
              for (const taskTitle of tasks) {
                const taskId = randomUUID();
                const taskEvent = createSynapEvent({
                  type: GeneratedEventTypes.entities['create.requested'],
                  userId,
                  aggregateId: taskId,
                  data: {
                    title: taskTitle,
                    projectId: aggregateId,
                    status: 'todo',
                  },
                  source: 'api',
                  requestId: randomUUID(),
                  correlationId, // Same correlation ID to group related events
                  metadata: {
                    triggeredBy: 'conversation',
                    threadId: input.threadId,
                    messageId: input.messageId,
                    parentProjectId: aggregateId,
                  },
                });

                await eventRepo.append(taskEvent);
                await publishEvent('api/event.logged', {
                  id: taskEvent.id,
                  type: taskEvent.type,
                  aggregateId: taskEvent.aggregateId,
                  aggregateType: 'entity',
                  userId: taskEvent.userId,
                  version: 1,
                  timestamp: taskEvent.timestamp.toISOString(),
                  data: taskEvent.data,
                  metadata: { version: taskEvent.version, requestId: taskEvent.requestId },
                  source: taskEvent.source,
                  causationId: taskEvent.causationId,
                  correlationId: taskEvent.correlationId,
                  requestId: taskEvent.requestId,
                }, userId);
              }
            }
            
            result = {
              projectId: aggregateId,
              title,
              tasksCreated: tasks?.length || 0,
            };
            eventType = GeneratedEventTypes.entities['create.requested'];
            break;
          }
          
          // =====================================================================
          // SEARCH ACTIONS
          // =====================================================================
          case 'search.semantic': {
            const { query } = input.actionParams;
            
            // Search is read-only, no event needed
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
            throw new ValidationError(`Unknown action type: ${input.actionType}`, { actionType: input.actionType });
        }

        // Add system message to conversation (this is still synchronous as it's just logging)
        const systemMessage = await conversationService.appendMessage({
          threadId: input.threadId,
          parentId: input.messageId,
          role: MessageRoleSchema.Enum.system,
          content: `✅ ${eventType.replace('.', ' ').replace('_', ' ')} - Action exécutée avec succès!`,
          metadata: {
            executedAction: {
              type: input.actionType,
              result,
            },
          },
          userId,
        });

        log.info({ aggregateId, eventType, requestId }, 'Intent event published');
        
        return {
          success: true,
          status: 'pending' as const,
          requestId,
          systemMessage,
          result,
          eventType,
        };
        
      } catch (error) {
        // Log error as system message
        const errorMessage = await conversationService.appendMessage({
          threadId: input.threadId,
          parentId: input.messageId,
          role: MessageRoleSchema.Enum.system,
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

        log.error({ err: error }, 'Conversation action failed');
        
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
      
      const verification = await conversationService.verifyHashChain(input.threadId);
      
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
      
      await conversationService.deleteMessage(input.messageId, userId);
      
      return {
        success: true,
        message: 'Message deleted',
      };
    }),
});

