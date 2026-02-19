/**
 * Database Schema - Export all tables
 */

// Core user management (Kratos identity cache)
export * from "./users.js";

export * from "./events.js";
export * from "./entities.js";
export * from "./entity-vectors.js";
export * from "./documents.js";
export * from "./relations.js";
export * from "./conversation-messages.js";
export * from "./knowledge-facts.js";
export * from "./ai-suggestions.js";
export * from "./api-keys.js";
export * from "./webhook_subscriptions.js";

// New schemas for chat system
export * from "./chat-threads.js";
export * from "./thread-entities.js";
export * from "./thread-documents.js";
export * from "./agents.js";
export * from "./projects.js";
export * from "./roles.js";
export * from "./sharing.js";

// AI Enrichment schemas (event-based)
export * from "./enrichments.js";

// Life Feed schemas
export * from "./inbox-items.js";
export * from "./user-entity-state.js";

// Intelligence Service Registry
export * from "./intelligence-services.js";

// Intelligence Commands & Runs (Raycast-style commands + audit)
export * from "./intelligence-commands.js";
export * from "./command-runs.js";

// NEW: Workspace system
export * from "./workspaces.js";
export * from "./project-members.js";

// NEW: Views system (whiteboards, timelines, etc.)
export * from "./views.js";

// NEW: User preferences
export {
  userPreferences,
  type UserPreference,
  type NewUserPreference,
  type CustomTheme,
  type DefaultTemplates,
  type CustomEntityType,
  type EntityMetadataSchemas,
  type EntityOpenMode,
  type UIPreferences,
  type GraphPreferences,
  insertUserPreferenceSchema,
  selectUserPreferenceSchema,
} from "./user-preferences.js";

// NEW: Universal Proposals
export * from "./proposals.js";

// NEW: Entity Templates
export * from "./entity-templates.js";

// NEW: Skills (user-created AI capabilities)
export * from "./skills.js";

// NEW: Background Tasks (proactive AI automation)
export * from "./background-tasks.js";

// NEW: Admin Invitations (for control plane flow)
export * from "./admin-invitations.js";

// NEW: Provisioning Tokens (one-time tokens for control-plane-provisioned backends)
export * from "./provisioning-tokens.js";

// NEW: Message Links (universal linking system)
export * from "./message-links.js";

// NEW: Dynamic Schema System (Profiles + Properties)
export * from "./property-defs.js";
export * from "./profiles.js";
export * from "./profile-properties.js";
export * from "./entity-property-index.js";

// NEW: Secrets Vault (encrypted password/key storage)
export * from "./secrets-vault.js";
