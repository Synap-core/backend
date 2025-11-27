/**
 * Task Details Schema - Component for Task Entities
 * 
 * Additional data specific to entities of type 'task'.
 * 
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { entities } from './entities.js';

export const taskDetails = pgTable('task_details', {
  // Primary key + foreign key
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entities.id, { onDelete: 'cascade' }),
  
  // Task status
  status: text('status').default('todo').notNull(),
  
  // Priority
  priority: integer('priority').default(0).notNull(),
  
  // Dates
  dueDate: timestamp('due_date', { mode: 'date', withTimezone: true }),
  completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }),
});

export type TaskDetail = typeof taskDetails.$inferSelect;
export type NewTaskDetail = typeof taskDetails.$inferInsert;

