/**
 * Conversation Message Handler - Inngest Function
 * NOTE: Disabled - Conversational AI moved to Intelligence Hub
 */

import { inngest } from '../client.js';
import { EventTypes } from '@synap/types';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'conversation-message-handler' });

export const handleConversationMessage = inngest.createFunction(
  {
    id: 'conversation-message-handler',
    name: 'Conversation Message Handler (Disabled)',
    retries: 0,
  },
  { event: EventTypes.CONVERSATION_MESSAGE_SENT },
  async ({ event }) => {
    logger.warn(
      { threadId: event.data.threadId },
      'Conversation handler disabled - Conversational AI has been moved to Intelligence Hub'
    );
    
    return {
      success: false,
      message: 'Conversation handling disabled - use Intelligence Hub via Hub Protocol',
    };
  }
);
