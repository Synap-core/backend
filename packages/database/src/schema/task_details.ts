/**
 * Task Details Schema - Component for Task Entities
 * 
 * Additional data specific to entities of type 'task'
 * Multi-dialect compatible (SQLite + PostgreSQL)
 */

import { entities } from './entities.js';
import * as pgCore from 'drizzle-orm/pg-core';
import * as sqliteCore from 'drizzle-orm/sqlite-core';

const isPostgres = process.env.DB_DIALECT === 'postgres';

let taskDetails: any;

if (isPostgres) {
  // PostgreSQL schema
  const { pgTable, uuid, text, integer, timestamp } = pgCore;
  
  taskDetails = pgTable('task_details', {
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
} else {
  // SQLite schema
  const { sqliteTable, text, integer } = sqliteCore;
  
  taskDetails = sqliteTable('task_details', {
    // Primary key + foreign key
    entityId: text('entity_id')
      .primaryKey()
      .references(() => entities.id, { onDelete: 'cascade' }),
    
    // Task status
    status: text('status').default('todo').notNull(),
    
    // Due date (Unix timestamp in ms)
    dueDate: integer('due_date', { mode: 'timestamp_ms' }),
    
    // Priority level
    priority: integer('priority').default(0).notNull(),
    
    // Completed timestamp
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  });
}

export { taskDetails };

export type TaskDetail = typeof taskDetails.$inferSelect;
export type NewTaskDetail = typeof taskDetails.$inferInsert;

