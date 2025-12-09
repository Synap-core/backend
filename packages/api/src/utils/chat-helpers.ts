/**
 * Chat Utility Helpers
 * 
 * Helpers for message formatting, entity type guards, and content parsing
 * Ready for UI consumption
 */

import type {
  Message,
  Entity,
  ChatThread,
  TaskEntity,
  ContactEntity,
  MeetingEntity,
  IdeaEntity,
} from '@synap/types';

// ============================================================================
// Type Guards
// ============================================================================

export function isTaskEntity(entity: Entity): entity is TaskEntity {
  return entity.type === 'task';
}

export function isContactEntity(entity: Entity): entity is ContactEntity {
  return entity.type === 'contact';
}

export function isMeetingEntity(entity: Entity): entity is MeetingEntity {
  return entity.type === 'meeting';
}

export function isIdeaEntity(entity: Entity): entity is IdeaEntity {
  return entity.type === 'idea';
}

// ============================================================================
// Message Formatting
// ============================================================================

/**
 * Format message timestamp for display
 */
export function formatMessageTime(timestamp: Date): string {
  const now = new Date();
  const diff = now.getTime() - timestamp.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  
  return timestamp.toLocaleDateString();
}

/**
 * Format full timestamp
 */
export function formatFullTimestamp(timestamp: Date): string {
  return timestamp.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Parse markdown links in message content
 */
export function parseMessageLinks(content: string): Array<{ text: string; url: string }> {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const links: Array<{ text: string; url: string }> = [];
  
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    links.push({
      text: match[1],
      url: match[2],
    });
  }
  
  return links;
}

/**
 * Extract mentioned entities from message metadata
 */
export function getMessageEntities(message: Message): string[] {
  return message.metadata?.entitiesExtracted || [];
}

/**
 * Check if message created a branch
 */
export function hasBranch(message: Message): boolean {
  return !!message.metadata?.branchCreated;
}

/**
 * Get thinking steps from message
 */
export function getThinkingSteps(message: Message): string[] {
  return message.metadata?.thinkingSteps || [];
}

// ============================================================================
// Entity Helpers
// ============================================================================

/**
 * Get entity display icon/emoji
 */
export function getEntityIcon(type: string): string {
  const icons: Record<string, string> = {
    task: '✓',
    contact: '👤',
    meeting: '📅',
    idea: '💡',
    note: '📝',
    project: '📁',
  };
  
  return icons[type] || '📌';
}

/**
 * Get entity status color
 */
export function getEntityStatusColor(entity: Entity): string {
  if (isTaskEntity(entity)) {
    const priority = entity.properties?.priority;
    if (priority === 'high') return 'red';
    if (priority === 'medium') return 'orange';
    return 'gray';
  }
  
  return 'blue';
}

/**
 * Format entity preview text
 */
export function formatEntityPreview(entity: Entity, maxLength: number = 100): string {
  const preview = entity.preview || entity.title;
  if (preview.length <= maxLength) return preview;
  return preview.substring(0, maxLength) + '...';
}

/**
 * Get entity properties display text
 */
export function getEntityPropertiesText(entity: Entity): string[] {
  const props: string[] = [];
  
  if (isTaskEntity(entity)) {
    if (entity.properties?.dueDate) {
      props.push(`Due: ${new Date(entity.properties.dueDate).toLocaleDateString()}`);
    }
    if (entity.properties?.priority) {
      props.push(`Priority: ${entity.properties.priority}`);
    }
  }
  
  if (isContactEntity(entity)) {
    if (entity.properties?.email) props.push(entity.properties.email);
    if (entity.properties?.company) props.push(entity.properties.company);
  }
  
  if (isMeetingEntity(entity)) {
    if (entity.properties?.date) {
      props.push(new Date(entity.properties.date).toLocaleString());
    }
    if (entity.properties?.duration) {
      props.push(`${entity.properties.duration}min`);
    }
  }
  
  return props;
}

// ============================================================================
// Thread Helpers
// ============================================================================

/**
 * Get thread display title
 */
export function getThreadTitle(thread: ChatThread): string {
  if (thread.title) return thread.title;
  if (thread.branchPurpose) return thread.branchPurpose;
  return thread.threadType === 'branch' ? 'Branch' : 'Chat';
}

/**
 * Get thread status badge
 */
export function getThreadStatusBadge(thread: ChatThread): {
  text: string;
  color: string;
} {
  const statusMap = {
    active: { text: 'Active', color: 'green' },
    merged: { text: 'Merged', color: 'blue' },
    archived: { text: 'Archived', color: 'gray' },
  };
  
  return statusMap[thread.status] || { text: 'Unknown', color: 'gray' };
}

/**
 * Check if thread is a branch
 */
export function isBranch(thread: ChatThread): boolean {
  return thread.threadType === 'branch';
}

// ============================================================================
// Content Parsing
// ============================================================================

/**
 * Parse message content for UI rendering
 * Returns structured content blocks
 */
export interface ContentBlock {
  type: 'text' | 'code' | 'link';
  content: string;
  language?: string; // For code blocks
  url?: string; // For links
}

export function parseMessageContent(content: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  
  // Simple implementation - can be enhanced with markdown parser
  const lines = content.split('\n');
  let inCodeBlock = false;
  let codeLanguage = '';
  let codeContent: string[] = [];
  
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        blocks.push({
          type: 'code',
          content: codeContent.join('\n'),
          language: codeLanguage,
        });
        codeContent = [];
        inCodeBlock = false;
      } else {
        // Start code block
        inCodeBlock = true;
        codeLanguage = line.substring(3).trim();
      }
    } else if (inCodeBlock) {
      codeContent.push(line);
    } else {
      // Regular text
      if (line.trim()) {
        blocks.push({
          type: 'text',
          content: line,
        });
      }
    }
  }
  
  return blocks;
}

// ============================================================================
// Date/Time Utilities
// ============================================================================

/**
 * Format relative time
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${Math.floor(days / 7) > 1 ? 's' : ''} ago`;
  if (days < 365) return `${Math.floor(days / 30)} month${Math.floor(days / 30) > 1 ? 's' : ''} ago`;
  return `${Math.floor(days / 365)} year${Math.floor(days / 365) > 1 ? 's' : ''} ago`;
}

/**
 * Group messages by date
 */
export function groupMessagesByDate(messages: Message[]): Map<string, Message[]> {
  const groups = new Map<string, Message[]>();
  
  for (const message of messages) {
    const dateKey = message.timestamp.toLocaleDateString();
    if (!groups.has(dateKey)) {
      groups.set(dateKey, []);
    }
    groups.get(dateKey)!.push(message);
  }
  
  return groups;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate message content before sending
 */
export function validateMessageContent(content: string): {
  valid: boolean;
  error?: string;
} {
  if (!content || content.trim().length === 0) {
    return { valid: false, error: 'Message cannot be empty' };
  }
  
  if (content.length > 10000) {
    return { valid: false, error: 'Message too long (max 10,000 characters)' };
  }
  
  return { valid: true };
}

/**
 * Sanitize user input
 */
export function sanitizeInput(input: string): string {
  // Basic sanitization - can be enhanced
  return input.trim();
}
