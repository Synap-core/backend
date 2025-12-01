/**
 * Embedding Generation Handler - Inngest Function
 * NOTE: Disabled - Embedding generation moved to Intelligence Hub
 */

import { inngest } from '../client.js';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'embedding-generation-handler' });

export const handleEmbeddingGeneration = inngest.createFunction(
  {
    id: 'embedding-generation-handler',
    name: 'Embedding Generation Handler (Disabled)',
    retries: 0,
  },
  { event: 'note.creation.completed' },
  async ({ event }) => {
    logger.warn(
      { entityId: event.data.entityId },
      'Embedding generation disabled - Embeddings handled by Intelligence Hub'
    );
    
    return {
      success: false,
      message: 'Embedding generation disabled - use Intelligence Hub via Hub Protocol',
    };
  }
);
