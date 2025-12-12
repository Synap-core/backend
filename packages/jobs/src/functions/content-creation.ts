/**
 * Content Creation Worker
 * 
 * Processes content.creation.requested events for unified content creation:
 * - Text input → Creates markdown file (notes/tasks)
 * - File upload → Moves from staging to final storage
 * - AI generated → Creates file from generated content
 */

import { inngest } from '../client.js';
import { storage } from '@synap/storage';
import { db, entities, documents } from '@synap/database';
import { createLogger } from '@synap/core';
import { createHash } from 'crypto';

const logger = createLogger({ module: 'content-creation-worker' });

export const contentCreationFunction = inngest.createFunction(
  { id: 'content-creation-processor', name: 'Process Content Creation Requests' },
  { event: 'api/event.logged' },
  async ({ event, step }) => {
    if (event.data.type !== 'content.creation.requested') {
      return { skipped: true, reason: 'Not a content creation event' };
    }
    
    const { contentSource, targetType, metadata } = event.data.data;
    const userId = event.data.userId;
    const aggregateId = event.data.aggregateId;
    
    logger.info({ 
      userId, 
      aggregateId, 
      contentSource, 
      targetType 
    }, 'Processing content creation');
    
    try {
      // Step 1: Get content (from text, file, or AI)
      const contentResult = await step.run('get-content', async () => {
        switch (contentSource) {
          case 'text-input': {
            // Create file FROM text content
            const { textContent } = event.data.data;
            return {
              content: textContent,
              filename: `${targetType}-${aggregateId}.md`,
              isText: true,
            };
          }
          
          case 'file-upload': {
            // Fetch from staging
            const { stagingKey, filename: originalFilename } = event.data.data;
            const buffer = await storage.downloadBuffer(stagingKey);
            
            // Cleanup staging in next step
            await storage.delete(stagingKey).catch(err => {
              logger.warn({ err, stagingKey }, 'Failed to delete staging file');
            });
            
            // Convert Buffer to base64 for serialization
            return {
              content: buffer.toString('base64'),
              filename: originalFilename,
              isText: false,
            };
          }
          
          case 'ai-generated': {
            // AI-generated content (similar to text-input)
            const { textContent } = event.data.data;
            return {
              content: textContent,
              filename: `${targetType}-${aggregateId}.md`,
              isText: true,
            };
          }
          
          default:
            throw new Error(`Unknown contentSource: ${contentSource}`);
        }
      });
      
      // Get filename for later use
      const filename = contentResult.filename;
      
      // Step 2: Determine final storage location
      const finalKey = await step.run('determine-storage-key', async () => {
        if (targetType === 'note' || targetType === 'task') {
          return `entities/${userId}/${targetType}s/${aggregateId}.md`;
        } else {
          // Document
          const ext = filename.split('.').pop() || 'md';
          return `documents/${userId}/${aggregateId}.${ext}`;
        }
      });
      
      // Step 3: Upload to final storage (pass base64 content to avoid Buffer serialization issues)
      const fileContentBase64 = contentResult.isText
        ? Buffer.from(contentResult.content, 'utf-8').toString('base64')
        : contentResult.content;
      
      const fileUrl = await step.run('upload-to-final-storage', async () => {
        const buffer = Buffer.from(fileContentBase64, 'base64');
        const result = await storage.upload(finalKey, buffer, {
          contentType: event.data.data.contentType || 'text/markdown',
        });
        return result.url;
      });
      
      // Step 4: Compute checksum and fileSize outside step.run
      const fileBufferForChecksum = Buffer.from(fileContentBase64, 'base64');
      const checksum = `sha256:${createHash('sha256').update(fileBufferForChecksum).digest('hex')}`;
      const fileSize = fileBufferForChecksum.length;
      
      // Step 5: Write to database
      await step.run('write-to-database', async () => {
        if (targetType === 'note' || targetType === 'task') {
          // Write to entities table
          await db.insert(entities).values({
            id: aggregateId,
            userId,
            type: targetType,
            title: metadata?.title || filename,
            fileUrl,
            filePath: finalKey,
            fileSize,
            fileType: 'markdown',
            checksum,
          });
          
          logger.info({ aggregateId, type: targetType }, 'Entity created');
        } else {
          // Write to documents table
          await db.insert(documents).values({
            id: aggregateId,
            userId,
            title: metadata?.title || filename,
            type: determineDocType(event.data.data.contentType),
            storageUrl: fileUrl,
            storageKey: finalKey,
            size: fileSize,
            mimeType: event.data.data.contentType,
            currentVersion: 1,
          });
          
          logger.info({ aggregateId }, 'Document created');
        }
      });
      
      return {
        success: true,
        aggregateId,
        fileUrl,
        finalKey,
      };
      
    } catch (error) {
      logger.error({ err: error, userId, aggregateId }, 'Content creation failed');
      throw error;
    }
  }
);

function determineDocType(contentType?: string): string {
  if (!contentType) return 'markdown';
  
  if (contentType.includes('markdown')) return 'markdown';
  if (contentType.includes('pdf')) return 'pdf';
  if (contentType.includes('word') || contentType.includes('docx')) return 'docx';
  if (contentType.startsWith('text/')) return 'text';
  if (contentType.startsWith('application/')) return 'code';
  
  return 'markdown';
}
