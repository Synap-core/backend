/**
 * Users Table - Cache for Kratos Identity Data
 *
 * Purpose: Store Kratos identity data in Synap DB for performance
 * - Allows JOINs without calling Kratos API
 * - Can add Synap-specific fields (avatar, timezone)
 * - Kratos remains source of truth for authentication
 */

import { pgTable, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { workspaces, workspaceMembers } from "./workspaces.js";
import { entities } from "./entities.js";
import { apiKeys } from "./api-keys.js";
import { userPreferences } from "./user-preferences.js";

export interface AgentMetadata {
  agentType: string;
  description?: string;
  createdByUserId: string;
  capabilities?: string[];
  isPersonalAgent?: boolean;
  parentAgentId?: string;
  writesRequireProposal?: boolean;
  activePersonality?: string;
}

export const users = pgTable("users", {
  // Kratos identity ID (UUID as text)
  id: text("id").primaryKey(),

  // Cached from Kratos traits
  email: text("email").notNull().unique(),
  name: text("name"),
  emailVerified: boolean("email_verified").default(false).notNull(),

  // Synap-specific fields
  avatarUrl: text("avatar_url"),
  timezone: text("timezone").default("UTC").notNull(),
  locale: text("locale").default("en").notNull(),

  // User type: 'human' (Kratos-authenticated) or 'agent' (AI agent)
  userType: text("user_type").notNull().default("human"),

  // Agent-specific metadata (null for human users)
  agentMetadata: jsonb("agent_metadata").$type<AgentMetadata | null>(),

  // Sync metadata (nullable — agents have no Kratos identity)
  kratosIdentityId: text("kratos_identity_id"),
  lastSyncedAt: timestamp("last_synced_at", {
    mode: "date",
    withTimezone: true,
  }),

  // Timestamps
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Relations to other Synap tables
export const usersRelations = relations(users, ({ many }) => ({
  workspaces: many(workspaces),
  workspaceMemberships: many(workspaceMembers),
  entities: many(entities),
  apiKeys: many(apiKeys),
  preferences: many(userPreferences),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
