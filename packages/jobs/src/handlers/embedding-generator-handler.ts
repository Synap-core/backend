/**
 * Embedding Generator Handler - Phase 2: Worker Layer
 * 
 * Handles 'note.creation.completed' events.
 * 
 * Responsibilities:
 * 1. Retrieve note content from storage
 * 2. Generate embedding using AI service
 * 3. Store embedding in entity_vectors table
 * 
 * This handler demonstrates the event-driven pattern:
 * - Subscribes to completion event (note.creation.completed)
 * - Performs async work (embedding generation)
 * - Updates projection (entity_vectors)
 */

import { IEventHandler, type InngestStep, type HandlerResult } from './interface.js';
import { type SynapEvent } from '@synap/types';
import { storage } from '@synap/storage';
import { vectorService } from '@synap/domain';
import { generateEmbedding } from '@synap/ai';
import { createLogger, config } from '@synap/core';

const logger = createLogger({ module: 'embedding-generator-handler' });

export class EmbeddingGeneratorHandler implements IEventHandler {
  eventType = 'note.creation.completed';

  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    if (event.type !== 'note.creation.completed') {
      return {
        success: false,
        message: `Invalid event type: expected 'note.creation.completed', got '${event.type}'`,
      };
    }

    // Validate event data structure
    const { entityId, filePath, fileUrl } = event.data as {
      entityId: string;
      filePath?: string;
      fileUrl?: string;
    };

    if (!entityId) {
      return {
        success: false,
        message: 'Entity ID is required',
      };
    }

    const userId = event.userId;

    logger.info({ entityId, userId }, 'Processing embedding generation');

    try {
      // Step 1: Retrieve content from storage
      const content = await step.run('retrieve-content', async () => {
        if (!filePath) {
          logger.warn({ entityId }, 'No file path provided, cannot generate embedding');
          throw new Error('File path is required for embedding generation');
        }

        try {
          const content = await storage.download(filePath);
          if (!content || content.trim().length === 0) {
            throw new Error('Note content is empty');
          }
          logger.debug({ entityId, contentLength: content.length }, 'Retrieved note content from storage');
          return content;
        } catch (error) {
          logger.error({ err: error, entityId, filePath }, 'Failed to retrieve content from storage');
          throw error;
        }
      });

      // Step 2: Generate embedding
      const embedding = await step.run('generate-embedding', async () => {
        try {
          const vector = await generateEmbedding(content);
          if (!Array.isArray(vector) || vector.length === 0) {
            throw new Error('Embedding generation returned empty vector');
          }
          logger.debug({ entityId, embeddingDimensions: vector.length }, 'Generated embedding');
          return vector;
        } catch (error) {
          logger.error({ err: error, entityId }, 'Failed to generate embedding');
          throw error;
        }
      });

      // Step 3: Store embedding in entity_vectors table
      await step.run('store-embedding', async () => {
        // Get entity details for denormalized fields
        // Note: In a real implementation, we might want to fetch from entities table
        // For now, we'll use the data from the event
        const embeddingModel = config.ai.embeddings.model;

        await vectorService.upsertEntityEmbedding({
          entityId,
          userId,
          entityType: 'note',
          title: undefined, // Could be fetched from entities table if needed
          preview: content.slice(0, 500),
          fileUrl,
          embedding,
          embeddingModel,
        });

        logger.info({ entityId, userId, embeddingModel }, 'Stored entity embedding');
      });

      return {
        success: true,
        message: `Embedding generated and stored for entity ${entityId}`,
      };
    } catch (error) {
      logger.error({ err: error, entityId, userId }, 'Embedding generation failed');
      return {
        success: false,
        message: `Embedding generation failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

