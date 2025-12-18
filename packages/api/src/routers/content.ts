/**
 * Content Router
 * 
 * Unified content creation through events:
 * - Text → Note (creates file from content)
 * - File → Note/Document (uploads to staging, then processes)
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { randomUUID } from 'crypto';
import { createSynapEvent } from '@synap/core';
import { getEventRepository } from '@synap/database';
import { publishEvent } from '../utils/inngest-client.js';
import { storage } from '@synap/storage';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'content-router' });

// ============================================================================
// SCHEMAS
// ============================================================================

const CreateFromTextSchema = z.object({
  content: z.string().min(1),
  targetType: z.enum(['note', 'task']),
  metadata: z.object({
    title: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }).optional(),
});

const CreateFromFileSchema = z.object({
  file: z.string(), // base64 encoded
  filename: z.string(),
  contentType: z.string(),
  targetType: z.enum(['note', 'document']),
  metadata: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }).optional(),
});

// ============================================================================
// ROUTER
// ============================================================================

export const contentRouter = router({
  /**
   * Create note from text input
   * 
   * Text content will be saved as markdown file via event processing
   */
  createFromText: protectedProcedure
    .input(CreateFromTextSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId as string;
      const requestId = randomUUID();
      const aggregateId = randomUUID();
      
      logger.info({ userId, requestId, targetType: input.targetType }, 'Creating content from text');
      
      // Create event
      const event = createSynapEvent({
        type: 'entities.create.requested',
        userId,
        aggregateId,
        data: {
          contentSource: 'text-input',
          textContent: input.content,
          targetType: input.targetType,
          metadata: input.metadata,
          source: 'user',
        },
        source: 'api',
        requestId,
      });
      
      // Append to event store
      const eventRepo = getEventRepository();
      await eventRepo.append(event);
      
      // Publish for async processing
      await publishEvent('api/event.logged', {
        id: event.id,
        type: event.type,
        aggregateId: event.aggregateId,
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
      
      return {
        success: true,
        status: 'pending' as const,
        requestId,
        entityId: aggregateId,
      };
    }),

  /**
   * Create content from file upload
   * 
   * File is uploaded to staging, then processed async via events
   */
  createFromFile: protectedProcedure
    .input(CreateFromFileSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId as string;
      const requestId = randomUUID();
      const aggregateId = randomUUID();
      
      logger.info({ userId, requestId, filename: input.filename, targetType: input.targetType }, 'Creating content from file');
      
      try {
        // PHASE 1: Upload to staging
        const stagingKey = `staging/${userId}/${requestId}/${input.filename}`;
        const buffer = Buffer.from(input.file, 'base64');
        
        await storage.upload(stagingKey, buffer, {
          contentType: input.contentType,
          metadata: {
            userId,
            requestId,
            temporary: 'true',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
          }
        });
        
        logger.debug({ stagingKey, size: buffer.length }, 'File uploaded to staging');
        
        // PHASE 2: Publish event
        const event = createSynapEvent({
          type: 'entities.create.requested',
          userId,
          aggregateId,
          data: {
            contentSource: 'file-upload',
            stagingKey,
            filename: input.filename,
            contentType: input.contentType,
            size: buffer.length,
            targetType: input.targetType,
            metadata: input.metadata,
            source: 'user',
          },
          source: 'api',
          requestId,
        });
        
        const eventRepo = getEventRepository();
        await eventRepo.append(event);
        
        await publishEvent('api/event.logged', {
          id: event.id,
          type: event.type,
          aggregateId: event.aggregateId,
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
        
        const result: any = {
          success: true,
          status: 'pending' as const,
          requestId,
        };
        
        if (input.targetType === 'note') {
          result.entityId = aggregateId;
        } else {
          result.documentId = aggregateId;
        }
        
        return result;
        
      } catch (error) {
        logger.error({ err: error, userId, filename: input.filename }, 'File upload failed');
        throw error;
      }
    }),
});
