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
  agentTemplate?: "twin" | "assistant" | "custom";
  description?: string;
  createdByUserId: string;
  capabilities?: string[];
  isPersonalAgent?: boolean;
  parentAgentId?: string;
  writesRequireProposal?: boolean;
  /**
   * @deprecated RETIRED as a write target (Governance Convergence, contract
   * phase). NO write surface persists this anymore — the per-agent auto-approve
   * boundary lives in `governance_rules` (resolver rung 2.8). Kept optional
   * ONLY so `backfillGovernanceRules` can project pre-migration legacy JSONB
   * into rows at boot. Never read it to make a decision; never write it.
   */
  autoApproveFor?: string[];
  activePersonality?: string;
  /**
   * Runtime, sticky workspace focus (WORKSPACE-PLACEMENT-AGENT-FOCUS-PLAN.md,
   * Layer 2, advisory slice). Settable at provisioning OR at runtime via the
   * `synap_set_workspace_focus` MCP tool; cleared by unsetting the field.
   * Read LIVE at request time — no migration, no key-stamping. Read live, when
   * present and the caller supplied no explicit workspace lens, it becomes the
   * ADVISORY default for `ctx.workspaceId` (writes only; never enforced, never
   * a 403 on mismatch — an explicit per-call workspace always overrides it).
   */
  focusWorkspaceId?: string;
  /** Reserved for the enforced (hard read+write scope) follow-on wave; only
   * "advisory" is implemented today — the field exists so a future "enforced"
   * value doesn't require another migration. */
  focusMode?: "advisory";
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

  // Agent identity — promoted out of agent_metadata to real, indexed, FK-backed
  // columns (migration 0038). agent_metadata is still dual-written for
  // back-compat during the transition; query predicates use these columns.
  createdByUserId: text("created_by_user_id").references((): any => users.id, {
    onDelete: "set null",
  }),
  isPersonalAgent: boolean("is_personal_agent").notNull().default(false),
  agentTemplate: text("agent_template"),
  agentType: text("agent_type"),
  // How this agent-user came to exist — provenance for the Agent dashboard
  // ('cli' | 'intelligence-service' | 'ui' | 'system'). Null for humans and for
  // agents created before migration 0225. Stamped at each creation call-site.
  createdVia: text("created_via"),
  parentAgentId: text("parent_agent_id").references((): any => users.id, {
    onDelete: "set null",
  }),

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
