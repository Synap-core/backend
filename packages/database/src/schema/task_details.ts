/**
 * Task Details Schema - Component for Task Entities
 * 
 * Additional data specific to entities of type 'task'
 * Multi-dialect compatible (SQLite + PostgreSQL)
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { entities } from './entities.js';

export const taskDetails = sqliteTable('task_details', {
  // Primary key (also foreign key to entity)
  entityId: text('entity_id')
    .primaryKey()
    .references(() => entities.id, { onDelete: 'cascade' }),
  
  // Task status
  status: text('status').default('todo').notNull(), // 'todo' | 'in_progress' | 'done'
  
  // Due date (Unix timestamp in ms)
  dueDate: integer('due_date', { mode: 'timestamp_ms' }),
  
  // Priority level
  priority: integer('priority').default(0).notNull(), // 0: None, 1: Low, 2: Medium, 3: High
});

export type TaskDetail = typeof taskDetails.$inferSelect;
export type NewTaskDetail = typeof taskDetails.$inferInsert;

