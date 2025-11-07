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
import { conversationService, eventService, MessageRoleSchema } from '@synap/domain';
import { runSynapAgent } from '@synap/ai';
import { requireUserId } from '../utils/user-scoped.js';
import { randomUUID } from 'crypto';
import { AgentStateSchema } from '@synap/core';
import type { SynapAgentResult } from '@synap/ai';
import { createLogger } from '@synap/core';

const chatLogger = createLogger({ module: 'chat-router' });

const NO_RESPONSE_FALLBACK =
  "Je n'ai pas pu générer de réponse pour le moment. Réessaie dans quelques instants.";

const serializeAgentStateMetadata = (state: SynapAgentResult) => {
  const planActions = state.plan?.actions.map((action) => ({
    tool: action.tool,
    params: action.params,
    reasoning: action.justification ?? state.plan?.reasoning ?? 'Aucune justification fournie.',
  })) ?? [];

  const executionSummaries = (state.execution ?? []).map((log) => ({
    tool: log.tool,
    status: log.status,
    result: log.result,
    error: log.errorMessage,
  }));

  const suggestedActions = planActions.map((action) => ({
    type: action.tool,
    description: action.reasoning,
    params: action.params,
  }));

  const metadataInput = {
    intentAnalysis: state.intentAnalysis
      ? {
          label: state.intentAnalysis.label,
          confidence: state.intentAnalysis.confidence,
          reasoning: state.intentAnalysis.reasoning,
          needsFollowUp: state.intentAnalysis.needsFollowUp,
        }
      : undefined,
    context: state.context
      ? {
          retrievedNotesCount: state.context.semanticResults.length,
          retrievedFactsCount: state.context.memoryFacts.length,
        }
      : undefined,
    plan: planActions,
    executionSummaries,
    finalResponse: state.response ?? NO_RESPONSE_FALLBACK,
    suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
  };

  const parsedState = AgentStateSchema.safeParse(metadataInput);

  if (!parsedState.success) {
    chatLogger.warn({ error: parsedState.error.flatten() }, 'Failed to normalize agent state metadata');
    return {
      agentState: metadataInput,
      suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
    };
  }

  const agentState = parsedState.data;

  return {
    agentState,
    suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
    model: agentState.model,
    tokens: agentState.tokens,
    latency: agentState.latency,
  };
};

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
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const threadId = input.threadId || randomUUID();
      const log = chatLogger.child({ userId, threadId });

      log.info({ parentId: input.parentId }, 'Received chat message');

      const userMessage = await conversationService.appendMessage({
        threadId,
        parentId: input.parentId,
        role: MessageRoleSchema.Enum.user,
        content: input.content,
        metadata: null,
        userId,
      });

      log.debug({ messageId: userMessage.id }, 'User message appended');

      let agentState: SynapAgentResult | null = null;

      try {
        agentState = await runSynapAgent({
          userId,
          threadId,
          message: input.content,
        });
      } catch (error) {
        log.error({ err: error }, 'Synap agent invocation failed');
      }

      const assistantResponse = agentState?.response ?? NO_RESPONSE_FALLBACK;
      const assistantMetadata = agentState ? serializeAgentStateMetadata(agentState) : null;

      const assistantMessage = await conversationService.appendMessage({
        threadId,
        parentId: userMessage.id,
        role: MessageRoleSchema.Enum.assistant,
        content: assistantResponse,
        metadata: assistantMetadata,
        userId,
      });

      log.info(
        {
          assistantMessageId: assistantMessage.id,
          agentStateCaptured: Boolean(agentState),
        },
        'Assistant response persisted'
      );

      return {
        success: true,
        threadId,
        userMessage,
        assistantMessage,
        agentState,
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
        throw new Error('Unauthorized: Thread belongs to another user');
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
      const log = chatLogger.child({
        userId,
        threadId: input.threadId,
        messageId: input.messageId,
        actionType: input.actionType,
      });

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
            await eventService.append({
              aggregateId,
              aggregateType: 'entity',
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
              source: 'api',
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
            const currentVersion = (await eventService.getAggregateVersion(taskId)) || 0;

            await eventService.append({
              aggregateId: taskId,
              aggregateType: 'entity',
              eventType: 'task.completed',
              userId,
              data: {
                completedAt: new Date().toISOString(),
              },
              version: currentVersion + 1,
              source: 'api',
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
            
            await eventService.append({
              aggregateId,
              aggregateType: 'entity',
              eventType: 'note.creation.requested',
              userId,
              data: {
                title,
                content,
                tags,
                type: 'note',
              },
              version: 1,
              source: 'api',
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
            
            await eventService.append({
              aggregateId,
              aggregateType: 'entity',
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
              source: 'api',
            });
            
            // If tasks provided, create them too
            if (tasks && Array.isArray(tasks)) {
              const correlationId = randomUUID();
              
              for (const taskTitle of tasks) {
                const taskId = randomUUID();
                await eventService.append({
                  aggregateId: taskId,
                  aggregateType: 'entity',
                  eventType: 'task.creation.requested',
                  userId,
                  data: {
                    title: taskTitle,
                    projectId: aggregateId,
                    status: 'todo',
                  },
                  version: 1,
                  source: 'api',
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

        log.info({ aggregateId, eventType }, 'Conversation action executed');
        
        return {
          success: true,
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

