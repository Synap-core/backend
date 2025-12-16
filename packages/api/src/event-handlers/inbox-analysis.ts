/**
 * Inbox Analysis Handler
 * 
 * Listens to: inbox.item.analyzed
 * Action: Update inbox item with analysis results
 */

import { db, inboxItems, eq } from '@synap/database';
import type { InboxItemAnalyzedEvent } from '@synap/events';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'inbox-analysis-handler' });

/**
 * Handle inbox item analyzed event
 * Updates the inbox item with analysis results
 */
export async function handleInboxItemAnalyzed(
  event: InboxItemAnalyzedEvent & {
    id: string;
    userId: string;
    timestamp: Date;
  }
) {
  logger.info({ 
    itemId: event.subjectId,
    requestId: event.data.requestId 
  }, 'Updating inbox item with analysis');
  
  try {
    // Get current item data
    const [item] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, event.subjectId))
      .limit(1);
    
    if (!item) {
      logger.warn({ itemId: event.subjectId }, 'Inbox item not found for analysis');
      return;
    }
    
    // Merge analysis into data field
    const updatedData = {
      ...item.data,
      analysis: event.data.analysis,
    };
    
    await db
      .update(inboxItems)
      .set({
        data: updatedData,
        // Optionally update status based on priority
        ...(event.data.analysis.priority === 'urgent' && { status: 'unread' as const }),
      })
      .where(eq(inboxItems.id, event.subjectId));
    
    logger.info({ 
      itemId: event.subjectId,
      priority: event.data.analysis.priority 
    }, 'Inbox item updated with analysis');
  } catch (error) {
    logger.error({ 
      err: error, 
      itemId: event.subjectId 
    }, 'Failed to update inbox item with analysis');
    throw error;
  }
}
