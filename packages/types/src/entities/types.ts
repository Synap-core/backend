/**
 * Entity Types
 * 
 * Re-exports base entity types from database and adds discriminated unions.
 * 
 * @see {@link file:///.../packages/database/src/schema/entities.ts}
 */

// Direct re-exports from database
export type { 
  Entity as DBEntity,  // Alias to avoid conflict with our discriminated union
  NewEntity as NewEntityDB,
} from '@synap/database/schema';

import type { EntityType, EntityMetadata } from './schemas.js';

/**
 * Base entity - common fields for all entity types
 */
export interface BaseEntity {
  id: string;
  userId: string;
  type: EntityType;
  title?: string;
  preview?: string;
  documentId?: string;  // Reference to documents table
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

/**
 * Entity - Discriminated union of all entity types
 * 
 * TypeScript automatically narrows the type based on the `type` field:
 * 
 * ```ts
 * if (entity.type === 'task') {
 *   // entity.metadata.status is accessible and type-safe!
 * }
 * ```
 */
export type Entity = {
  [K in EntityType]: BaseEntity & {
    type: K;
    metadata: EntityMetadata[K];
  }
}[EntityType];

/**
 * Specific entity types (for explicit typing)
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
  'id' | 'version' | 'createdAt' | 'updatedAt'
>;

/**
 * Entity update type (for updates)
 */
export type UpdateEntity<T extends EntityType = EntityType> = Partial<
  Omit<Extract<Entity, { type: T }>, 'id' | 'userId' | 'type' | 'createdAt' | 'updatedAt'>
>;
