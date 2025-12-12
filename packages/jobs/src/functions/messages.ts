/**
 * Messages Worker - Conversation Message Handler
 * 
 * Handles conversation message events:
 * - conversationMessages.create.requested
 * 
 * Supports attachments (images, files) that are uploaded to storage.
 */

import { inngest } from '../client.js';
import { storage } from '@synap/storage';
import { conversationMessages } from '@synap/database';
import { createLogger } from '@synap/core';
import { randomUUID, createHash } from 'crypto';

const logger = createLogger({ module: 'messages-worker' });

// ============================================================================
// TYPES
// ============================================================================

interface Attachment {
  id?: string;
  type: 'image' | 'file' | 'document';
  filename: string;
  content?: string; // Base64 content
  externalUrl?: string; // URL to download from
  mimeType?: string;
}

interface MessagesCreateRequestedData {
  threadId: string;
  content: string;
  role: 'user' | 'assistant' | 'system';
  parentId?: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
  requestId?: string;
}

interface StoredAttachment {
  id: string;
  type: 'image' | 'file' | 'document';
  filename: string;
  storageKey: string;
  storageUrl: string;
  size: number;
  mimeType: string;
}

// ============================================================================
// WORKER
// ============================================================================

export const messagesWorker = inngest.createFunction(
  {
    id: 'messages-handler',
    name: 'Messages Handler',
    retries: 3,
  },
  [
    { event: 'conversationMessages.create.requested' },
  ],
  async ({ event, step }) => {
    const userId = event.user?.id as string;
    
    if (!userId) {
      throw new Error('userId is required for messages operations');
    }
    
    const data = event.data as MessagesCreateRequestedData;
    const messageId = randomUUID();
    
    logger.info({ messageId, threadId: data.threadId, role: data.role }, 'Processing message creation');
    
    // Step 1: Upload attachments to storage
    let storedAttachments: StoredAttachment[] = [];
    
    if (data.attachments?.length) {
      storedAttachments = await step.run('upload-attachments', async () => {
        const uploaded: StoredAttachment[] = [];
        
        for (const att of data.attachments || []) {
          let buffer: Buffer;
          
          // Get content from base64 or external URL
          if (att.content) {
            buffer = Buffer.from(att.content, 'base64');
          } else if (att.externalUrl) {
            // Download from external URL
            const response = await fetch(att.externalUrl);
            const arrayBuffer = await response.arrayBuffer();
            buffer = Buffer.from(arrayBuffer);
          } else {
            continue; // Skip if no content
          }
          
          const attachmentId = att.id || randomUUID();
          const ext = att.filename.split('.').pop() || 'bin';
          const storagePath = `chat/${userId}/${data.threadId}/${attachmentId}.${ext}`;
          
          const result = await storage.upload(storagePath, buffer, {
            contentType: att.mimeType || 'application/octet-stream',
          });
          
          uploaded.push({
            id: attachmentId,
            type: att.type,
            filename: att.filename,
            storageKey: result.path,
            storageUrl: result.url,
            size: buffer.length,
            mimeType: att.mimeType || 'application/octet-stream',
          });
          
          logger.debug({ attachmentId, filename: att.filename }, 'Uploaded attachment');
        }
        
        return uploaded;
      });
    }
    
    // Step 2: Compute message hash
    const messageHash = await step.run('compute-hash', async () => {
      const hashInput = JSON.stringify({
        threadId: data.threadId,
        content: data.content,
        role: data.role,
        timestamp: new Date().toISOString(),
      });
      return createHash('sha256').update(hashInput).digest('hex');
    });
    
    // Step 3: Insert message into database
    await step.run('insert-message', async () => {
      const { getDb } = await import('@synap/database');
      const db = await getDb();
      
      // Build metadata with attachments
      const metadata: Record<string, unknown> = {
        ...(data.metadata || {}),
      };
      
      if (storedAttachments.length) {
        metadata.attachments = storedAttachments;
      }
      
      await db.insert(conversationMessages).values({
        id: messageId,
        threadId: data.threadId,
        parentId: data.parentId,
        role: data.role,
        content: data.content,
        metadata: Object.keys(metadata).length ? metadata : null,
        userId,
        timestamp: new Date(),
        hash: messageHash,
      } as any);
      
      logger.debug({ messageId }, 'Inserted message');
    });
    
    // Step 4: Emit completion event
    await step.run('emit-completion', async () => {
      await inngest.send({
        name: 'conversationMessages.create.completed',
        data: {
          messageId,
          threadId: data.threadId,
          role: data.role,
          attachmentCount: storedAttachments.length,
        },
        user: { id: userId },
      });
      
      logger.info({ messageId }, 'Published conversationMessages.create.completed');
    });
    
    // Step 5: Broadcast to SSE clients
    await step.run('broadcast-notification', async () => {
      const { broadcastNotification } = await import('../utils/realtime-broadcast.js');
      await broadcastNotification({
        userId,
        requestId: data.requestId,
        message: {
          type: 'conversationMessages.create.completed',
          data: {
            messageId,
            threadId: data.threadId,
            role: data.role,
            content: data.content.slice(0, 100), // Preview
          },
          requestId: data.requestId,
          status: 'success',
          timestamp: new Date().toISOString(),
        },
      });
    });
    
    return {
      success: true,
      messageId,
      threadId: data.threadId,
      attachmentCount: storedAttachments.length,
    };
  }
);
