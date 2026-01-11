/**
 * Entity Types
 * 
 * TypeScript types for entities with discriminated unions.
 * Types are automatically generated from Zod schemas and Database definition.
 */

import { z } from 'zod';
import { ENTITY_SCHEMAS } from './schemas.js';

/**
 * Entity Metadata Interface per type
 */
export { type EntityMetadata, type EntityType } from './schemas.js';
import type { EntityType } from './schemas.js';

/**
 * Entity Schema - Discriminated Union
 * 
 * Combines the Database Schema (common fields) with type-specific metadata
 */

// Create a base schema from the select schema
const baseEntitySchema = z.object({
  id: z.string(),
  userId: z.string(),
  workspaceId: z.string().nullable(),
  type: z.string(),
  title: z.string().nullable(),
  preview: z.string().nullable(),
  documentId: z.string().nullable(),
  metadata: z.any(),
  fileUrl: z.string().nullable(),
  filePath: z.string().nullable(),
  fileSize: z.number().nullable(),
  fileType: z.string().nullable(),
  checksum: z.string().nullable(),
  version: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),
});

// Create discriminated union with proper typing
export const EntitySchema = z.discriminatedUnion('type', [
  baseEntitySchema.extend({ type: z.literal('task'), metadata: ENTITY_SCHEMAS.task }),
  baseEntitySchema.extend({ type: z.literal('note'), metadata: ENTITY_SCHEMAS.note }),
  baseEntitySchema.extend({ type: z.literal('person'), metadata: ENTITY_SCHEMAS.person }),
  baseEntitySchema.extend({ type: z.literal('event'), metadata: ENTITY_SCHEMAS.event }),
  baseEntitySchema.extend({ type: z.literal('file'), metadata: ENTITY_SCHEMAS.file }),
  baseEntitySchema.extend({ type: z.literal('code'), metadata: ENTITY_SCHEMAS.code }),
  baseEntitySchema.extend({ type: z.literal('bookmark'), metadata: ENTITY_SCHEMAS.bookmark }),
  baseEntitySchema.extend({ type: z.literal('company'), metadata: ENTITY_SCHEMAS.company }),
]);

/**
 * Entity - The main type used across the application
 */
export type Entity = z.infer<typeof EntitySchema>;

/**
 * Base Entity Helper (for partial usage)
 */
export type BaseEntity = Omit<Entity, 'metadata'> & { metadata: unknown };

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
