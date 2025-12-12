/**
 * @synap/events - Schema-Driven Event Generator
 * 
 * This module generates event types and payload schemas from Drizzle database tables.
 * 
 * Pattern: {table}.{action}.{modifier}
 * - entities.create
 * - entities.create.requested
 * - entities.create.completed
 */

// Zod imported for future schema generation extensions
// import { z } from 'zod';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Standard CRUD actions for table events
 */
export type TableAction = 
  | 'create' 
  | 'update' 
  | 'delete'
  | 'create.requested'
  | 'create.completed'
  | 'update.requested'
  | 'update.completed'
  | 'delete.requested'
  | 'delete.completed';

/**
 * Event type structure for a table
 */
export interface TableEventTypes<T extends string> {
  create: `${T}.create`;
  update: `${T}.update`;
  delete: `${T}.delete`;
  'create.requested': `${T}.create.requested`;
  'create.completed': `${T}.create.completed`;
  'update.requested': `${T}.update.requested`;
  'update.completed': `${T}.update.completed`;
  'delete.requested': `${T}.delete.requested`;
  'delete.completed': `${T}.delete.completed`;
}

/**
 * Generate event types for a table
 */
export function generateTableEventTypes<T extends string>(tableName: T): TableEventTypes<T> {
  return {
    create: `${tableName}.create` as const,
    update: `${tableName}.update` as const,
    delete: `${tableName}.delete` as const,
    'create.requested': `${tableName}.create.requested` as const,
    'create.completed': `${tableName}.create.completed` as const,
    'update.requested': `${tableName}.update.requested` as const,
    'update.completed': `${tableName}.update.completed` as const,
    'delete.requested': `${tableName}.delete.requested` as const,
    'delete.completed': `${tableName}.delete.completed` as const,
  };
}

// ============================================================================
// TABLE DEFINITIONS
// ============================================================================

/**
 * Core tables that generate events
 */
export const CORE_TABLES = [
  'entities',
  'documents',
  'documentVersions',
  'chatThreads',
  'conversationMessages',
  'taskDetails',
  'webhookSubscriptions',
  'apiKeys',
  'projects',
  'tags',
  'agents',
] as const;

export type CoreTable = typeof CORE_TABLES[number];

// ============================================================================
// GENERATED EVENT TYPES
// ============================================================================

/**
 * All generated event types from core tables
 */
export const GeneratedEventTypes = {
  entities: generateTableEventTypes('entities'),
  documents: generateTableEventTypes('documents'),
  documentVersions: generateTableEventTypes('documentVersions'),
  chatThreads: generateTableEventTypes('chatThreads'),
  conversationMessages: generateTableEventTypes('conversationMessages'),
  taskDetails: generateTableEventTypes('taskDetails'),
  webhookSubscriptions: generateTableEventTypes('webhookSubscriptions'),
  apiKeys: generateTableEventTypes('apiKeys'),
  projects: generateTableEventTypes('projects'),
  tags: generateTableEventTypes('tags'),
  agents: generateTableEventTypes('agents'),
} as const;

/**
 * Flat list of all generated event types (for type checking)
 */
export type GeneratedEventType = 
  | `${CoreTable}.create`
  | `${CoreTable}.update`
  | `${CoreTable}.delete`
  | `${CoreTable}.create.requested`
  | `${CoreTable}.create.completed`
  | `${CoreTable}.update.requested`
  | `${CoreTable}.update.completed`
  | `${CoreTable}.delete.requested`
  | `${CoreTable}.delete.completed`;

/**
 * Get all generated event types as an array
 */
export function getAllGeneratedEventTypes(): GeneratedEventType[] {
  const events: GeneratedEventType[] = [];
  
  for (const table of CORE_TABLES) {
    events.push(
      `${table}.create`,
      `${table}.update`,
      `${table}.delete`,
      `${table}.create.requested`,
      `${table}.create.completed`,
      `${table}.update.requested`,
      `${table}.update.completed`,
      `${table}.delete.requested`,
      `${table}.delete.completed`,
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
  if (parts.length < 2) return null;
  
  const table = parts[0];
  const action = parts.slice(1).join('.') as TableAction;
  
  return { table, action };
}
