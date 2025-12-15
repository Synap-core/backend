/**
 * @synap/events - Schema-Driven Event Generator
 * 
 * This module generates event types and payload schemas from Drizzle database tables.
 * 
 * V2.0 CONSOLIDATED PATTERN: {table}.{action}.{modifier}
 * 
 * Actions: create | update | delete
 * Modifiers: requested | validated
 * 
 * Examples:
 *   entities.create.requested  ← Intent submitted (by user or AI)
 *   entities.create.validated  ← Change confirmed and applied
 *   entities.update.requested  ← Update intent
 *   entities.update.validated  ← Update confirmed
 * 
 * No direct actions (e.g., entities.create) - all changes go through requested→validated flow.
 */

// ============================================================================
// TYPES
// ============================================================================

/**
 * Standard CRUD actions with modifiers for table events
 * 
 * V2.0: Removed direct actions, renamed completed→validated
 */
export type TableAction = 
  | 'create.requested'
  | 'create.validated'
  | 'update.requested'
  | 'update.validated'
  | 'delete.requested'
  | 'delete.validated';

/**
 * Event type structure for a table
 * 
 * V2.0: Only requested/validated pairs
 */
export interface TableEventTypes<T extends string> {
  'create.requested': `${T}.create.requested`;
  'create.validated': `${T}.create.validated`;
  'update.requested': `${T}.update.requested`;
  'update.validated': `${T}.update.validated`;
  'delete.requested': `${T}.delete.requested`;
  'delete.validated': `${T}.delete.validated`;
}

/**
 * Generate event types for a table
 * 
 * V2.0: Only requested/validated patterns
 */
export function generateTableEventTypes<T extends string>(tableName: T): TableEventTypes<T> {
  return {
    'create.requested': `${tableName}.create.requested` as const,
    'create.validated': `${tableName}.create.validated` as const,
    'update.requested': `${tableName}.update.requested` as const,
    'update.validated': `${tableName}.update.validated` as const,
    'delete.requested': `${tableName}.delete.requested` as const,
    'delete.validated': `${tableName}.delete.validated` as const,
  };
}

// ============================================================================
// TABLE DEFINITIONS
// ============================================================================

/**
 * Core tables that generate events
 * 
 * V2.0 CHANGES:
 * - Removed 'taskDetails' (extension table, not independent entity)
 * - Removed 'projects' (redundant with entities.type='project')
 */
export const CORE_TABLES = [
  'entities',           // Core knowledge graph nodes
  'documents',          // User documents
  'documentVersions',   // Document version history
  'chatThreads',        // Chat conversation threads
  'conversationMessages', // Individual chat messages
  'webhookSubscriptions', // Webhook configuration
  'apiKeys',            // API key management
  'tags',               // User-defined labels
  'agents',             // AI agent configurations
] as const;

export type CoreTable = typeof CORE_TABLES[number];

// ============================================================================
// GENERATED EVENT TYPES
// ============================================================================

/**
 * All generated event types from core tables
 * 
 * V2.0: Only 9 tables × 6 events = 54 event types
 */
export const GeneratedEventTypes = {
  entities: generateTableEventTypes('entities'),
  documents: generateTableEventTypes('documents'),
  documentVersions: generateTableEventTypes('documentVersions'),
  chatThreads: generateTableEventTypes('chatThreads'),
  conversationMessages: generateTableEventTypes('conversationMessages'),
  webhookSubscriptions: generateTableEventTypes('webhookSubscriptions'),
  apiKeys: generateTableEventTypes('apiKeys'),
  tags: generateTableEventTypes('tags'),
  agents: generateTableEventTypes('agents'),
} as const;

/**
 * Flat list of all generated event types (for type checking)
 * 
 * V2.0: Only requested/validated patterns
 */
export type GeneratedEventType = 
  | `${CoreTable}.create.requested`
  | `${CoreTable}.create.validated`
  | `${CoreTable}.update.requested`
  | `${CoreTable}.update.validated`
  | `${CoreTable}.delete.requested`
  | `${CoreTable}.delete.validated`;

/**
 * Get all generated event types as an array
 */
export function getAllGeneratedEventTypes(): GeneratedEventType[] {
  const events: GeneratedEventType[] = [];
  
  for (const table of CORE_TABLES) {
    events.push(
      `${table}.create.requested`,
      `${table}.create.validated`,
      `${table}.update.requested`,
      `${table}.update.validated`,
      `${table}.delete.requested`,
      `${table}.delete.validated`,
    );
  }
  
  return events;
}

/**
 * Check if a string is a valid generated event type
 */
export function isGeneratedEventType(event: string): event is GeneratedEventType {
  return getAllGeneratedEventTypes().includes(event as GeneratedEventType);
}

/**
 * Parse event type into table and action
 */
export function parseEventType(eventType: string): { table: string; action: TableAction } | null {
  const parts = eventType.split('.');
  if (parts.length < 3) return null;
  
  const table = parts[0];
  const action = parts.slice(1).join('.') as TableAction;
  
  // Validate action is a known pattern
  const validActions: TableAction[] = [
    'create.requested', 'create.validated',
    'update.requested', 'update.validated',
    'delete.requested', 'delete.validated',
  ];
  
  if (!validActions.includes(action)) return null;
  
  return { table, action };
}
