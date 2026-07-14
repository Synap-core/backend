/**
 * Database Schema - Export all tables
 */

// Core user management (Kratos identity cache)
export * from "./users.js";
export * from "./federation.js";

export * from "./events.js";
export * from "./entities.js";
export * from "./entity-vectors.js";
export * from "./entity-facets.js";
export * from "./documents.js";
export * from "./relations.js";
export * from "./messages.js";
export * from "./chat-turns.js";
export * from "./knowledge-facts.js";
export * from "./ai-suggestions.js";
export * from "./api-keys.js";
export * from "./api-key-external-users.js";
export * from "./webhook_subscriptions.js";

// Channels system (replaces chat-threads + thread-entities + thread-documents)
export * from "./channels.js";
export * from "./message-reactions.js";
export * from "./channel-context-items.js";
export * from "./channel-connections.js";
export * from "./channel-egress.js";
export * from "./agents.js";
export * from "./projects.js";
export * from "./roles.js";
export * from "./sharing.js";

// AI Enrichment schemas (event-based)
export * from "./enrichments.js";

// Life Feed schemas
export * from "./inbox-items.js";
export * from "./user-resource-state.js";
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

// NEW: Knowledge Keys (pod-wide procedural knowledge for agents)
export * from "./knowledge-keys.js";

// NEW: Dynamic Widget Registry
export * from "./widget-definitions.js";

// NEW: Entity External Links (connector sync tracking)
export * from "./entity-external-links.js";

// NEW: Entity Identity Signals (cross-source person dedup)
export * from "./entity-identity-signals.js";

// NEW: Unified Notification System
export * from "./notifications.js";

// NEW: Pod-to-Pod Sync (event log replication)
export * from "./sync.js";

// NEW: Sync Generation (split-brain prevention)
export * from "./sync-generation.js";

// NEW: Signal Feed (external content subscriptions, AI classifications, auto-links)
export * from "./signals.js";

// NEW: Trusted Issuers (pod-level registry of approved external services)
export * from "./trusted-issuers.js";

// NEW: Pod Settings (singleton row holding pod-wide defaults — intelligence + proactive)
export * from "./pod-settings.js";

// NEW: Source Configs & Subscriptions (pluggable feed source providers)
export * from "./source-configs.js";

// NEW: Feeds (feed scheduling & status)
export * from "./feeds.js";

// NEW: Messaging Accounts (provider-agnostic connected messaging accounts)
export * from "./messaging-accounts.js";

// NEW: Cell Instances (persisted instances of the universal cell rendering unit)
export * from "./cell-instances.js";

// NEW: AI Provider Registry (pod-level, synced to IS on change)
export * from "./ai-providers.js";

// NEW: AI Provider Credentials (per-workspace and per-user key overrides)
export * from "./ai-provider-credentials.js";

// NEW: Focus Sessions (goal-bound user work sessions — workflow side, not data side)
export * from "./focus-sessions.js";

// DEPRECATED: Agent Skills merged into skills table (migration 0130_merge_agent_skills.sql).
// The agent-skills.ts table definition is kept for migration reference only.
// All consumers should use `skills` from skills.ts.
// export * from "./agent-skills.js";

// NEW: Artifacts (artifact ledger — lifecycle + provenance on cell instances; Phase 1 of Desk system)
export * from "./artifacts.js";

// NEW: Playbooks & Capability Substrate (CONFIG) — registered tools, session
// templates (playbooks), and the polymorphic config/runtime graph (links).
export * from "./tools.js";
export * from "./playbooks.js";
// Provider integrations (CONFIG) — credential backend registry (Nango, Vault, etc.)
// + the specific services each exposes (gmail, gdrive, openai…). Links into the
// secrets vault via `provider_integration_id` FK for OAuth/vault routing.
export * from "./provider-integrations.js";
// Capability containers (CONFIG) — named bundles grouping tools/skills/built-ins
// (parts attach via `links`: part --member_of--> capability).
export * from "./capabilities.js";
export * from "./links.js";
// Playbook run ledger (RUNTIME) — one row per playbook execution (executor spine, P3).
export * from "./playbook-runs.js";
// Playbook → automations composition (CONFIG) — first-class editable join that
// promotes the read-only `automation --member_of--> playbook` link edges (0179).
export * from "./playbook-automations.js";
// Playbook enrollments (RUNTIME) — entity ↔ playbook, many entities per playbook,
// promotes the single focus_sessions.subject_entity_id fake (0180).
export * from "./playbook-enrollments.js";

// Entity centrality (Horizon Phase 3) — batch-computed global PageRank score per
// entity. Side table, recomputed by the pagerank-centrality job; read by Horizon.
export * from "./entity-centrality.js";

// (capability_templates removed in migration 0154 — capability templates live on
// the Control Plane only; the pod stores none.)
//
// Capability Template CACHE (0155) — a pod-local stale-while-revalidate mirror of
// the CP catalog so the catalog NEVER blocks on the CP. NOT a source of truth.
export * from "./capability-template-cache.js";

// CP Catalog Cache (0184) — generalizes the above to all four marketplace
// kinds (capability | automation | template | cell), source-dimensioned for
// future catalog-provider federation (P2.4-B / P2.10.2). The old
// capability_template_cache stays in place unchanged — cutover is a later wave.
export * from "./cp-catalog-cache.js";

// Provenance vocabulary (createdByKind column type — must be public so tsc
// can name router return types without referencing internal dist paths)
export type { ProvenanceKind } from "./provenance.js";
