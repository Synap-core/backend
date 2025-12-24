/**
 * Workspaces Schema - Multi-user workspace support
 * 
 * A workspace can be:
 * - Personal (single user)
 * - Team (multiple users with roles)
 * - Enterprise (advanced features)
 */

import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const workspaces = pgTable('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  
  // Ownership
  ownerId: text('owner_id').notNull(),
  
  // Metadata
  name: text('name').notNull(),
  description: text('description'),
  type: text('type').default('personal').notNull(), // 'personal' | 'team' | 'enterprise'
  
  // Settings (JSONB for flexibility)
  settings: jsonb('settings').default('{}').notNull(),
  // {
  //   defaultEntityTypes: ['note', 'task'],
  //   theme: 'light',
  //   aiEnabled: true,
  //   allowExternalSharing: false
  // }
  
  // Billing (optional - for managed hosting)
  subscriptionTier: text('subscription_tier'), // 'free', 'pro', 'team', 'enterprise'
  subscriptionStatus: text('subscription_status'), // 'active', 'canceled', 'past_due', 'trialing'
  stripeCustomerId: text('stripe_customer_id'),
  
  // Timestamps
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const workspaceMembers = pgTable('workspace_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  
  // References
  workspaceId: uuid('workspace_id')
    .references(() => workspaces.id, { onDelete: 'cascade' })
    .notNull(),
  userId: text('user_id').notNull(),
  
  // Role-based access
  role: text('role').notNull(), // 'owner' | 'admin' | 'editor' | 'viewer'
  
  // Metadata
  joinedAt: timestamp('joined_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
  invitedBy: text('invited_by'), // userId of inviter
});

export const workspaceInvites = pgTable('workspace_invites', {
  id: uuid('id').defaultRandom().primaryKey(),
  
  // References
  workspaceId: uuid('workspace_id')
    .references(() => workspaces.id, { onDelete: 'cascade' })
    .notNull(),
  
  // Invite details
  email: text('email').notNull(),
  role: text('role').notNull(), // 'admin' | 'editor' | 'viewer'
  token: text('token').notNull().unique(), // Random invite token
  
  // Metadata
  invitedBy: text('invited_by').notNull(), // userId
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Type exports
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
export type WorkspaceInvite = typeof workspaceInvites.$inferSelect;
export type NewWorkspaceInvite = typeof workspaceInvites.$inferInsert;
