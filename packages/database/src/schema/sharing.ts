/**
 * Resource Sharing Schema - Public links and invitations
 */

import { pgTable, uuid, text, jsonb, timestamp, integer } from 'drizzle-orm/pg-core';

export const resourceShares = pgTable('resource_shares', {
  id: uuid('id').defaultRandom().primaryKey(),
  
  // Resource being shared
  resourceType: text('resource_type').notNull(), // 'view', 'entity', 'workspace'
  resourceId: uuid('resource_id').notNull(),
  
  // Sharing mode
  visibility: text('visibility').notNull().default('private'),
  // 'private' | 'workspace' | 'invite_only' | 'public'
  
  // Public link
  publicToken: text('public_token'),
  
  // Invited users
  invitedUsers: text('invited_users').array().default([]),
  
  // Permissions for shared access
  permissions: jsonb('permissions').default({ read: true }),
  
  // Expiration
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),
  
  // Metadata
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  
  // Tracking
  viewCount: integer('view_count').default(0),
  lastAccessedAt: timestamp('last_accessed_at', { mode: 'date', withTimezone: true }),
});

export type ResourceShare = typeof resourceShares.$inferSelect;
export type NewResourceShare = typeof resourceShares.$inferInsert;
