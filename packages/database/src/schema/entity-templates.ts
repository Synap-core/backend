import { pgTable, uuid, text, timestamp, boolean, jsonb, integer, index, check, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from './workspaces.js';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

export const entityTemplates = pgTable('entity_templates', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  name: text('name').notNull(),
  description: text('description'),
  
  // Scope
  userId: text('user_id'),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  
  // Target Configuration
  targetType: text('target_type').notNull(),
  entityType: text('entity_type'),
  inboxItemType: text('inbox_item_type'),
  
  // Template Configuration
  config: jsonb('config').default('{}').notNull(),
  
  // Metadata
  isDefault: boolean('is_default').default(false).notNull(),
  isPublic: boolean('is_public').default(false).notNull(),
  version: integer('version').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    // Indexes for frequent lookups
    userIdIdx: index('idx_templates_user').on(table.userId),
    workspaceIdIdx: index('idx_templates_workspace').on(table.workspaceId),
    targetTypeIdx: index('idx_templates_target_type').on(table.targetType),
    entityTypeIdx: index('idx_templates_entity_type').on(table.entityType),
    inboxItemTypeIdx: index('idx_templates_inbox_type').on(table.inboxItemType),
    
    // Constraints
    scopeCheck: check('valid_scope', sql`
      (user_id IS NOT NULL AND workspace_id IS NULL) OR
      (user_id IS NULL AND workspace_id IS NOT NULL)
    `),
    
    targetTypeCheck: check('target_type_check', sql`
      target_type IN ('entity', 'document', 'project', 'inbox_item')
    `),
    
    uniqueDefault: unique('unique_default_per_scope').on(
      table.userId, 
      table.workspaceId, 
      table.targetType, 
      table.entityType, 
      table.inboxItemType, 
      table.isDefault
    )
  };
});

export type EntityTemplate = typeof entityTemplates.$inferSelect;
export type NewEntityTemplate = typeof entityTemplates.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertEntityTemplateSchema = createInsertSchema(entityTemplates);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectEntityTemplateSchema = createSelectSchema(entityTemplates);

