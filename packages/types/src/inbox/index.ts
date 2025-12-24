/**
 * Inbox Item Schemas & Types
 * 
 * Re-exports inbox types from database and adds provider-specific schemas.
 * 
 * @see {@link file:///.../packages/database/src/schema/inbox-items.ts}
 */

import { z } from 'zod';

// Direct re-exports from database
export type { 
  InboxItem as DBInboxItem,  // Base DB type
  NewInboxItem,
} from '@synap/database/schema';

/**
 * Inbox item data schemas - provider-specific
 */
export const INBOX_SCHEMAS = {
  email: z.object({
    from: z.string().email(),
    to: z.array(z.string().email()),
    subject: z.string(),
    snippet: z.string(),
    threadId: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
  
  calendar_event: z.object({
    summary: z.string(),
    description: z.string().optional(),
    location: z.string().optional(),
    start: z.string().datetime(),
    end: z.string().datetime(),
    attendees: z.array(z.object({
      email: z.string().email(),
      name: z.string().optional(),
    })).optional(),
  }),
  
  slack_message: z.object({
    channel: z.string(),
    user: z.string(),
    text: z.string(),
    threadTs: z.string().optional(),
    reactions: z.array(z.object({
      name: z.string(),
      count: z.number(),
    })).optional(),
  }),
} as const;

export type InboxItemType = keyof typeof INBOX_SCHEMAS;

type InboxItemData = {
  [K in InboxItemType]: z.infer<typeof INBOX_SCHEMAS[K]>
};

/**
 * Base inbox item fields
 */
interface BaseInboxItem {
  id: string;
  userId: string;
  
  // Source tracking
  provider: 'gmail' | 'google_calendar' | 'slack';
  account: string; // 'user@gmail.com'
  externalId: string; // ID in external system
  deepLink?: string; // 'googlegmail://message?id=...'
  
  // Content
  type: InboxItemType;
  title: string;
  preview?: string;
  timestamp: Date;
  
  // State
  status: 'unread' | 'read' | 'archived' | 'snoozed';
  snoozedUntil?: Date;
  
  // AI enhancements
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  tags: string[];
  
  // Lifecycle
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Inbox item - discriminated union
 */
export type InboxItem = {
  [K in InboxItemType]: BaseInboxItem & {
    type: K;
    data: InboxItemData[K];
  }
}[InboxItemType];

/**
 * Specific inbox item types
 */
export type EmailInboxItem = Extract<InboxItem, { type: 'email' }>;
export type CalendarInboxItem = Extract<InboxItem, { type: 'calendar_event' }>;
export type SlackInboxItem = Extract<InboxItem, { type: 'slack_message' }>;

/**
 * Type guards
 */
export function isEmailInboxItem(item: InboxItem): item is EmailInboxItem {
  return item.type === 'email';
}

export function isCalendarInboxItem(item: InboxItem): item is CalendarInboxItem {
  return item.type === 'calendar_event';
}

export function isSlackInboxItem(item: InboxItem): item is SlackInboxItem {
  return item.type === 'slack_message';
}
