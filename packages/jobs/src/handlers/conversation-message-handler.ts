/**
 * Conversation Message Handler - V1.0 Event-Driven Refactoring
 * 
 * Handles 'conversation.message.sent' events.
 * 
 * Responsibilities:
 * 1. Append user message to conversation
 * 2. Run Synap agent to generate response
 * 3. Append assistant response to conversation
 * 4. Publish 'conversation.response.generated' event
 * 
 * This handler enables the event-driven pattern for chat:
 * - API publishes 'conversation.message.sent' event
 * - Handler processes message and generates response
 * - Handler publishes 'conversation.response.generated' event
 * - Client can subscribe via WebSocket for real-time updates
 */

import { IEventHandler, type InngestStep, type HandlerResult } from './interface.js';
import { createSynapEvent, EventTypes, type SynapEvent } from '@synap/types';
import { conversationService, MessageRoleSchema } from '@synap/domain';
import { runSynapAgent } from '@synap/ai';
import { inngest } from '../client.js';
import { createLogger } from '@synap/core';
import { randomUUID } from 'crypto';

const logger = createLogger({ module: 'conversation-message-handler' });

const NO_RESPONSE_FALLBACK =
  "Je n'ai pas pu générer de réponse pour le moment. Réessaie dans quelques instants.";

export class ConversationMessageHandler implements IEventHandler {
  eventType = EventTypes.CONVERSATION_MESSAGE_SENT;

  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    if (event.type !== EventTypes.CONVERSATION_MESSAGE_SENT) {
      return {
        success: false,
        message: `Invalid event type: expected '${EventTypes.CONVERSATION_MESSAGE_SENT}', got '${event.type}'`,
      };
    }

    // Validate event data structure
    const { threadId, parentId, content } = event.data as {
      threadId: string;
      parentId?: string;
      content: string;
    };

    if (!threadId || !content || typeof content !== 'string' || content.trim().length === 0) {
      return {
        success: false,
        message: 'Thread ID and content are required',
      };
    }

    const userId = event.userId;
    const messageId = randomUUID();

    logger.info({ threadId, userId, messageId }, 'Processing conversation message');

    try {
      // Step 1: Append user message to conversation
      const userMessage = await step.run('append-user-message', async () => {
        const message = await conversationService.appendMessage({
          threadId,
          parentId,
          role: MessageRoleSchema.Enum.user,
          content,
          metadata: null,
          userId,
        });
        logger.debug({ messageId: message.id }, 'User message appended');
        return message;
      });

      // Step 2: Run Synap agent to generate response
      let agentState = null;
      try {
        agentState = await step.run('run-synap-agent', async () => {
          const result = await runSynapAgent({
            userId,
            threadId,
            message: content,
          });
          logger.debug({ threadId }, 'Synap agent response generated');
          return result;
        });
      } catch (error) {
        logger.error({ err: error, threadId }, 'Synap agent invocation failed');
        // Continue with fallback response
      }

      // Step 3: Append assistant response to conversation
      const assistantResponse = agentState?.response ?? NO_RESPONSE_FALLBACK;
      const assistantMetadata = agentState
        ? {
            agentState: {
              intentAnalysis: agentState.intentAnalysis
                ? {
                    label: agentState.intentAnalysis.label,
                    confidence: agentState.intentAnalysis.confidence,
                    reasoning: agentState.intentAnalysis.reasoning,
                    needsFollowUp: agentState.intentAnalysis.needsFollowUp,
                  }
                : undefined,
              context: agentState.context
                ? {
                    retrievedNotesCount: agentState.context.semanticResults.length,
                    retrievedFactsCount: agentState.context.memoryFacts.length,
                  }
                : undefined,
              plan: agentState.plan?.actions.map((action) => ({
                tool: action.tool,
                params: action.params,
                reasoning: action.justification ?? agentState.plan?.reasoning ?? 'Aucune justification fournie.',
              })) ?? [],
              executionSummaries: (agentState.execution ?? []).map((log) => ({
                tool: log.tool,
                status: log.status,
                result: log.result,
                error: log.errorMessage,
              })),
              finalResponse: agentState.response ?? NO_RESPONSE_FALLBACK,
              suggestedActions:
                agentState.plan?.actions.map((action) => ({
                  type: action.tool,
                  description: action.justification ?? agentState.plan?.reasoning ?? 'Aucune justification fournie.',
                  params: action.params,
                })) ?? [],
            },
            // Note: model, tokens, and latency are not part of agentState
            // They would come from the conversational agent response if needed
            // Omit these fields as they're optional
          }
        : null;

      const assistantMessage = await step.run('append-assistant-message', async () => {
        const message = await conversationService.appendMessage({
          threadId,
          parentId: userMessage.id,
          role: MessageRoleSchema.Enum.assistant,
          content: assistantResponse,
          metadata: assistantMetadata,
          userId,
        });
        logger.debug({ messageId: message.id }, 'Assistant message appended');
        return message;
      });

      // Step 4: Publish response generated event
      await step.run('publish-response-event', async () => {
        const responseEvent = createSynapEvent({
          type: EventTypes.CONVERSATION_RESPONSE_GENERATED,
          userId,
          aggregateId: threadId,
          data: {
            threadId,
            userMessageId: userMessage.id,
            assistantMessageId: assistantMessage.id,
            response: assistantResponse,
            agentState: agentState
              ? {
                  hasIntentAnalysis: Boolean(agentState.intentAnalysis),
                  hasContext: Boolean(agentState.context),
                  hasPlan: Boolean(agentState.plan),
                  hasExecution: Boolean(agentState.execution),
                  suggestedActionsCount: agentState.plan?.actions.length ?? 0,
                }
              : null,
          },
          source: 'automation',
          causationId: event.id,
          correlationId: event.correlationId || event.id,
          requestId: event.requestId,
        });

        // Publish to Inngest
        await inngest.send({
          name: 'api/event.logged',
          data: {
            id: responseEvent.id,
            type: responseEvent.type,
            aggregateId: responseEvent.aggregateId,
            aggregateType: 'conversation',
            userId: responseEvent.userId,
            version: 1,
            timestamp: responseEvent.timestamp.toISOString(),
            data: responseEvent.data,
            metadata: { version: responseEvent.version, requestId: responseEvent.requestId },
            source: responseEvent.source,
            causationId: responseEvent.causationId,
            correlationId: responseEvent.correlationId,
            requestId: responseEvent.requestId,
          },
        });

        logger.info({ threadId, responseEventId: responseEvent.id }, 'Published conversation.response.generated event');
      });

      // Step 5: Broadcast notification to connected clients
      await step.run('broadcast-notification', async () => {
        const { broadcastNotification } = await import('../utils/realtime-broadcast.js');
        const broadcastResult = await broadcastNotification({
          userId,
          requestId: event.requestId,
          message: {
            type: 'conversation.response.generated',
            data: {
              threadId,
              userMessageId: userMessage.id,
              assistantMessageId: assistantMessage.id,
              response: assistantResponse,
            },
            requestId: event.requestId,
            status: 'success',
            timestamp: new Date().toISOString(),
          },
        });

        if (broadcastResult.success) {
          logger.debug({ threadId, broadcastCount: broadcastResult.broadcastCount }, 'Notification broadcasted');
        } else {
          logger.warn({ threadId, error: broadcastResult.error }, 'Failed to broadcast notification');
        }
      });

      return {
        success: true,
        message: `Conversation message processed successfully for thread ${threadId}`,
      };
    } catch (error) {
      logger.error({ err: error, threadId, userId }, 'Conversation message processing failed');
      
      // Broadcast error notification
      try {
        const { broadcastError } = await import('../utils/realtime-broadcast.js');
        await broadcastError(
          userId,
          'conversation.message.failed',
          error instanceof Error ? error.message : String(error),
          { requestId: event.requestId }
        );
      } catch (broadcastErr) {
        logger.warn({ err: broadcastErr }, 'Failed to broadcast error notification');
      }
      
      return {
        success: false,
        message: `Conversation message processing failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

