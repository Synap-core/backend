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
export * from "./messages.js";
export * from "./knowledge-facts.js";
export * from "./ai-suggestions.js";
export * from "./api-keys.js";
export * from "./webhook_subscriptions.js";

// Channels system (replaces chat-threads + thread-entities + thread-documents)
export * from "./channels.js";
export * from "./channel-context-items.js";
export * from "./channel-connections.js";
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

// Automations (trigger → step chain workflow engine)
export * from "./automations.js";

// NEW: Admin Invitations (for control plane flow)
export * from "./admin-invitations.js";

// NEW: Provisioning Tokens (one-time tokens for control-plane-provisioned backends)
export * from "./provisioning-tokens.js";

// NEW: Message Links (universal linking system)
export * from "./message-links.js";

// NEW: Agent Configs (centralised user preferences for AI agent behaviour)
export * from "./agent-configs.js";

// NEW: MCP Servers (workspace-level Model Context Protocol server registry)
export * from "./mcp-servers.js";

// NEW: Dynamic Schema System (Profiles + Properties + Relation Definitions)
export * from "./property-defs.js";
export * from "./profiles.js";
export * from "./profile-properties.js";
export * from "./entity-property-index.js";
export * from "./relation-defs.js";
export * from "./profile-relations.js";

// NEW: Secrets Vault (encrypted password/key storage)
export * from "./secrets-vault.js";

// NEW: Session-Scoped Memory System
// Sessions group messages into bounded interaction periods.
// CompactedStates are offline-produced structured memory snapshots.
export * from "./sessions.js";
export * from "./compacted-states.js";

// NEW: Dynamic Widget Registry
export * from "./widget-definitions.js";

// NEW: Entity External Links (connector sync tracking)
export * from "./entity-external-links.js";
