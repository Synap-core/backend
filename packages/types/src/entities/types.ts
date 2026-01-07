/**
 * Entity Types
 * 
 * TypeScript types for entities with discriminated unions.
 * Types are automatically generated from Zod schemas and Database definition.
 */

import { z } from 'zod';
import { selectEntitySchema } from '@synap/database/schema';
import { ENTITY_SCHEMAS } from './schemas.js';

/**
 * Base Entity Type (from Database)
 * Includes id, userId, type, metadata (untyped), createdAt, etc.
 */
export type DbEntity = z.infer<typeof selectEntitySchema>;

/**
 * Entity Metadata Interface per type
 */
export { type EntityMetadata, type EntityType } from './schemas.js';
import type { EntityType } from './schemas.js';

/**
 * Entity Schema - Discriminated Union
 * 
 * Combines the Database Schema (common fields) with specific Metadata Schemas.
 */
export const EntitySchema = z.discriminatedUnion('type', [
  selectEntitySchema.extend({ type: z.literal('task'), metadata: ENTITY_SCHEMAS.task }),
  selectEntitySchema.extend({ type: z.literal('note'), metadata: ENTITY_SCHEMAS.note }),
  selectEntitySchema.extend({ type: z.literal('person'), metadata: ENTITY_SCHEMAS.person }),
  selectEntitySchema.extend({ type: z.literal('event'), metadata: ENTITY_SCHEMAS.event }),
  selectEntitySchema.extend({ type: z.literal('file'), metadata: ENTITY_SCHEMAS.file }),
  selectEntitySchema.extend({ type: z.literal('code'), metadata: ENTITY_SCHEMAS.code }),
  selectEntitySchema.extend({ type: z.literal('bookmark'), metadata: ENTITY_SCHEMAS.bookmark }),
  selectEntitySchema.extend({ type: z.literal('company'), metadata: ENTITY_SCHEMAS.company }),
]);

/**
 * Entity - The main type used across the application
 */
export type Entity = z.infer<typeof EntitySchema>;

/**
 * Base Entity Helper (for partial usage)
 */
export type BaseEntity = Omit<DbEntity, 'metadata'> & { metadata: unknown };

/**
 * Specific entity types
 */
export type Task = Extract<Entity, { type: 'task' }>;
export type Note = Extract<Entity, { type: 'note' }>;
export type Person = Extract<Entity, { type: 'person' }>;
export type Event = Extract<Entity, { type: 'event' }>;
export type File = Extract<Entity, { type: 'file' }>;

/**
 * New entity type (for creation)
 */
export type NewEntity<T extends EntityType = EntityType> = Omit<
  Extract<Entity, { type: T }>,
  'id' | 'version' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'documentId'
> & {
  documentId?: string | null;
};

/**
 * Entity update type (for updates)
 */
export type UpdateEntity<T extends EntityType = EntityType> = Partial<
  Omit<NewEntity<T>, 'userId' | 'type'>
>;
