/**
 * Schema Coherence Validator
 *
 * Guards against silent schema drift on pod startup.
 *
 * Why this exists
 * ---------------
 * The repo abandoned drizzle-kit after migration 0003. Every schema change
 * since has been a hand-written .sql file in migrations/ or
 * migrations/. Some columns/tables declared in the Drizzle schema
 * drifted — they were only added defensively in later migrations (ADD COLUMN
 * IF NOT EXISTS), and a pod that stopped at an earlier version would be
 * missing columns the runtime code expects.
 *
 * `0000_baseline_schema.sql` is the consolidated catch-up (the older
 * `0099_schema_reconciliation.sql` was folded into it). This file
 * is the *tripwire*: it runs on every server boot (right after migrations,
 * before the HTTP server starts listening) and fails loudly if any critical
 * column is still missing. If it throws, the pod exits non-zero and the
 * supervisor surfaces the error.
 *
 * The column list below is deliberately short — ~30 columns that cover the
 * recent drift. It is NOT a full schema check. Its job is to catch known
 * at-risk columns and block startup if the reconciliation migration failed
 * to run (or was reverted).
 */

import { sql } from "../client-pg.js";

/**
 * A single column the runtime requires to exist.
 *
 * `addedBy` is the filename of the migration expected to create it — used in
 * the error message so an operator knows which migration to investigate.
 */
interface RequiredColumn {
  table: string;
  column: string;
  addedBy: string;
}

/**
 * Critical columns that must exist for the API to function.
 *
 * Every column that 0099_schema_reconciliation.sql adds is listed here, plus
 * a handful of high-value columns that were added in earlier migrations but
 * whose absence has historically caused outages.
 *
 * Keep this list in sync with 0099_schema_reconciliation.sql.
 */
const REQUIRED_COLUMNS: ReadonlyArray<RequiredColumn> = [
  // Wave B3 provenance — tripwire on the KG core (0107). Checking 2 of the 5
  // per table is enough to confirm the migration ran (it adds all 5 together).
  //
  // Federated sign-in writes a replay receipt on EVERY exchange. If this column
  // is missing the insert throws, the pod still boots "healthy", and every
  // federated sign-in fails with an unexplained exchange error — the exact
  // silent-runtime-failure this check exists to prevent.
  {
    table: "federated_assertion_receipts",
    column: "replay_context",
    addedBy: "0196_federated_application_connection_request_lifecycle.sql",
  },
  {
    table: "entities",
    column: "created_by_kind",
    addedBy: "0107_provenance_columns.sql",
  },
  {
    table: "entities",
    column: "correlation_id",
    addedBy: "0107_provenance_columns.sql",
  },
  {
    table: "documents",
    column: "created_by_kind",
    addedBy: "0107_provenance_columns.sql",
  },
  {
    table: "documents",
    column: "correlation_id",
    addedBy: "0107_provenance_columns.sql",
  },
  {
    table: "skills",
    column: "document_ids",
    addedBy: "0149_skills_document_ids.sql",
  },
  {
    table: "skills",
    column: "body_document_id",
    addedBy: "0150_skills_body_document.sql",
  },
  {
    table: "skills",
    column: "provider_spec",
    addedBy: "0156_skill_provider_spec.sql",
  },
  {
    table: "relations",
    column: "created_by_kind",
    addedBy: "0107_provenance_columns.sql",
  },
  {
    table: "relations",
    column: "correlation_id",
    addedBy: "0107_provenance_columns.sql",
  },

  // proposals — session_id FK (0119_add_session_id_to_proposals.sql)
  {
    table: "proposals",
    column: "session_id",
    addedBy: "0119_add_session_id_to_proposals.sql",
  },
  // proposals — agent-proposal dedup hash (0208). Its partial unique index is
  // the DB-level backstop against duplicate PENDING agent proposals; if the
  // column is missing the agent write path throws on every insert.
  {
    table: "proposals",
    column: "dedup_hash",
    addedBy: "0208_proposals_dedup_hash.sql",
  },

  // property_defs — audit flagged these (0057 / 0064 / 0065)
  {
    table: "property_defs",
    column: "profile_id",
    addedBy: "0064_property_defs_profile_scoped_unique.sql",
  },
  {
    table: "property_defs",
    column: "workspace_id",
    addedBy: "0065_property_defs_workspace_scope.sql",
  },
  {
    table: "property_defs",
    column: "relation_def_id",
    addedBy: "0057_unified_relations.sql",
  },
  {
    table: "property_defs",
    column: "target_profile_id",
    addedBy: "0057_unified_relations.sql",
  },

  // channels — V2 columns (0066 drizzle + 0099 custom catch-up)
  {
    table: "channels",
    column: "scope",
    addedBy:
      "0066_channel_system_v2.sql / 0099_schema_reconciliation.sql (custom)",
  },
  {
    table: "channels",
    column: "feed_scope",
    addedBy:
      "0066_channel_system_v2.sql / 0099_schema_reconciliation.sql (custom)",
  },
  {
    table: "channels",
    column: "result_summary",
    addedBy: "0099_schema_reconciliation.sql (custom)",
  },
  {
    table: "channels",
    column: "merged_at",
    addedBy: "0099_schema_reconciliation.sql (custom)",
  },
  {
    table: "channels",
    column: "external_source",
    addedBy: "0017_channels_external_id.sql",
  },
  {
    table: "channels",
    column: "external_id",
    addedBy: "0017_channels_external_id.sql",
  },
  {
    table: "channels",
    column: "project_id",
    addedBy: "0171_channels_project_id.sql",
  },

  // inbox_items — 0003 created an early shape; the current Drizzle schema
  // grew to carry a full Life Feed payload but no numbered migration ever
  // added the new columns. The 0099 reconciliation adds them all; these
  // entries trip pod boot if a pod is missing the critical ones.
  {
    table: "inbox_items",
    column: "provider",
    addedBy: "0099_schema_reconciliation.sql",
  },
  {
    table: "inbox_items",
    column: "external_id",
    addedBy: "0099_schema_reconciliation.sql",
  },
  {
    table: "inbox_items",
    column: "timestamp",
    addedBy: "0099_schema_reconciliation.sql",
  },
  {
    table: "inbox_items",
    column: "status",
    addedBy: "0099_schema_reconciliation.sql",
  },
  {
    table: "inbox_items",
    column: "snoozed_until",
    addedBy: "0099_schema_reconciliation.sql",
  },

  // messages — renamed from conversation_messages in 0038 (custom)
  {
    table: "messages",
    column: "author_type",
    addedBy: "0038_channels_refactor.sql (custom)",
  },
  {
    table: "messages",
    column: "message_category",
    addedBy: "0038_channels_refactor.sql (custom)",
  },
  {
    table: "messages",
    column: "external_source",
    addedBy: "0038_channels_refactor.sql (custom)",
  },
  {
    table: "messages",
    column: "inbox_item_id",
    addedBy: "0038_channels_refactor.sql (custom)",
  },
  {
    table: "messages",
    column: "session_id",
    addedBy: "0047_session_scoped_memory.sql (custom)",
  },
  {
    table: "messages",
    column: "edited_at",
    addedBy: "0176_messages_edited_at.sql",
  },
  {
    table: "messages",
    column: "ephemeral",
    addedBy: "0178_messages_ephemeral.sql",
  },

  // entities
  {
    table: "entities",
    column: "system_data",
    addedBy: "0046_entities_system_data.sql (custom)",
  },
  {
    table: "entities",
    column: "profile_id",
    addedBy: "0003_sparkling_thundra.sql",
  },

  // profiles
  {
    table: "profiles",
    column: "semantic_slug",
    addedBy: "0054_profile_semantic_slug.sql",
  },
  {
    table: "profiles",
    column: "entity_scope",
    addedBy: "0060_entity_scope_column.sql",
  },
  // NOTE: this list checks column EXISTENCE only. `profiles.entity_scope` also
  // has a required DEFAULT ('pod', migration 0220) — a wrong default silently
  // INVERTS the kind/role doctrine rather than failing, so it is checked
  // separately in `validateSchemaCoherence()` below.
  {
    table: "profiles",
    column: "default_values",
    addedBy: "0035_consolidate_data_model.sql",
  },
  {
    table: "profiles",
    column: "default_list_renderer",
    addedBy: "0024_profile_renderer_columns.sql",
  },
  {
    table: "profiles",
    column: "default_detail_renderer",
    addedBy: "0024_profile_renderer_columns.sql",
  },
  {
    table: "profiles",
    column: "default_dashboard_renderer",
    addedBy: "0106_profile_dashboard_renderer.sql",
  },
  {
    table: "profiles",
    column: "default_renderers",
    addedBy: "0112_profiles_default_renderers.sql",
  },
  // Query-understanding vocabulary (0197): plural + synonyms drive data-driven
  // type-word matching in understandQuery. Absence means a pod is on a pre-0197
  // schema where the catalog builder's `p.plural`/`p.synonyms` reads reference a
  // missing column (understandQuery still works via the KIND_CUES fallback).
  {
    table: "profiles",
    column: "plural",
    addedBy: "0197_profile_vocabulary.sql",
  },
  {
    table: "profiles",
    column: "synonyms",
    addedBy: "0197_profile_vocabulary.sql",
  },

  // api_keys
  {
    table: "api_keys",
    column: "key_type",
    addedBy: "0044_api_keys_type_description.sql (custom)",
  },
  {
    table: "api_keys",
    column: "description",
    addedBy: "0044_api_keys_type_description.sql (custom)",
  },
  {
    table: "api_keys",
    column: "parent_key_id",
    addedBy: "0018_per_user_sub_tokens.sql",
  },
  {
    table: "api_keys",
    column: "workspace_id",
    addedBy: "0020_api_keys_workspace_scope.sql",
  },
  {
    table: "api_keys",
    column: "linked_user_id",
    addedBy: "0021_api_keys_linked_user_id.sql",
  },
  {
    table: "api_keys",
    column: "instance_id",
    addedBy: "0204_api_keys_instance_id.sql",
  },

  // api_key_external_users — sub-token mappings (0018)
  {
    table: "api_key_external_users",
    column: "parent_api_key_id",
    addedBy: "0018_per_user_sub_tokens.sql",
  },
  {
    table: "api_key_external_users",
    column: "external_user_id",
    addedBy: "0018_per_user_sub_tokens.sql",
  },
  {
    table: "api_key_external_users",
    column: "synap_user_id",
    addedBy: "0018_per_user_sub_tokens.sql",
  },

  // proposals
  {
    table: "proposals",
    column: "agent_user_id",
    addedBy: "0034_proposals_agent_user_expiry.sql",
  },
  {
    table: "proposals",
    column: "project_id",
    addedBy: "0138_proposals_project_id.sql",
  },
  {
    table: "proposals",
    column: "thread_id",
    addedBy: "0037_proposals_thread_linkage.sql (custom)",
  },
  {
    table: "proposals",
    column: "correlation_id",
    addedBy: "0035_proposal_correlation.sql",
  },
  {
    table: "proposals",
    column: "proposed_by_user_id",
    addedBy: "0181_proposals_proposed_by_user_id.sql",
  },
  {
    table: "proposals",
    column: "external_dispatched_at",
    addedBy: "0209_proposals_external_dispatched.sql",
  },

  // users
  {
    table: "users",
    column: "user_type",
    addedBy: "0032_ai_agent_users.sql (custom)",
  },
  {
    table: "users",
    column: "agent_metadata",
    addedBy: "0032_ai_agent_users.sql (custom)",
  },
  // widget_definitions
  {
    table: "widget_definitions",
    column: "role",
    addedBy: "0108_widget_definitions_role.sql",
  },
  {
    table: "widget_definitions",
    column: "content_kind",
    addedBy: "0111_widget_definitions_renderer_type.sql",
  },
  {
    table: "widget_definitions",
    column: "source",
    addedBy: "0056_widget_native_columns.sql",
  },
  {
    table: "widget_definitions",
    column: "bundle_source",
    addedBy: "0056_widget_native_columns.sql",
  },
  {
    table: "widget_definitions",
    column: "deps",
    addedBy: "0030_widget_frame_renderer.sql",
  },
  {
    table: "widget_definitions",
    column: "trust_level",
    addedBy: "0034_widget_trust_level.sql",
  },
  {
    table: "widget_definitions",
    column: "view_renderer_view_types",
    addedBy: "0221_widget_definitions_view_renderer_view_types.sql",
  },

  // knowledge_facts — Ebbinghaus decay columns (0113)
  {
    table: "knowledge_facts",
    column: "access_count",
    addedBy: "0113_ebbinghaus_decay.sql",
  },
  {
    table: "knowledge_facts",
    column: "relevance_score",
    addedBy: "0113_ebbinghaus_decay.sql",
  },
  {
    table: "knowledge_facts",
    column: "fact_hash",
    addedBy: "0216_knowledge_facts_dedup.sql",
  },
  {
    table: "knowledge_facts",
    column: "dedup_bucket",
    addedBy: "0216_knowledge_facts_dedup.sql",
  },

  // focus_sessions — goal-bound user work sessions (0114)
  {
    table: "focus_sessions",
    column: "goal",
    addedBy: "0114_focus_sessions.sql",
  },
  {
    table: "focus_sessions",
    column: "status",
    addedBy: "0114_focus_sessions.sql",
  },

  // focus_sessions — project-centric-scope Phase 4 (0136)
  {
    table: "focus_sessions",
    column: "project_id",
    addedBy: "0136_focus_sessions_project.sql",
  },

  // focus_sessions — Process North Star subject spine (0139)
  {
    table: "focus_sessions",
    column: "subject_entity_id",
    addedBy: "0139_process_subject_spine.sql",
  },

  // focus_sessions — first-class playbook stages (0159)
  {
    table: "focus_sessions",
    column: "current_stage",
    addedBy: "0159_playbook_stages.sql",
  },

  // focus_sessions — free-form metadata bag (0160)
  {
    table: "focus_sessions",
    column: "metadata",
    addedBy: "0160_focus_session_metadata.sql",
  },

  // playbooks — Process North Star subject spine (0139)
  {
    table: "playbooks",
    column: "flow_automation_id",
    addedBy: "0139_process_subject_spine.sql",
  },
  {
    table: "playbooks",
    column: "subject_profile",
    addedBy: "0139_process_subject_spine.sql",
  },

  // playbooks — first-class playbook stages (0159)
  {
    table: "playbooks",
    column: "stages",
    addedBy: "0159_playbook_stages.sql",
  },

  // channel_context_items
  {
    table: "channel_context_items",
    column: "relevance_score",
    addedBy: "0047_session_scoped_memory.sql (custom)",
  },

  // agent_configs — declared in schema, never in any earlier migration
  {
    table: "agent_configs",
    column: "agent_type",
    addedBy: "0099_schema_reconciliation.sql (custom)",
  },

  // entity_identity_signals — declared in schema, never in any earlier migration
  {
    table: "entity_identity_signals",
    column: "signal_type",
    addedBy: "0099_schema_reconciliation.sql (custom)",
  },
  {
    table: "entity_identity_signals",
    column: "signal_value",
    addedBy: "0099_schema_reconciliation.sql (custom)",
  },

  // sync_generation — split-brain prevention (0101)
  {
    table: "sync_generation",
    column: "generation",
    addedBy: "0101_sync_generation_split_brain.sql",
  },
  {
    table: "sync_generation",
    column: "role",
    addedBy: "0101_sync_generation_split_brain.sql",
  },
  {
    table: "sync_generation",
    column: "split_brain_detected",
    addedBy: "0101_sync_generation_split_brain.sql",
  },

  // sync_peers.local_role — local-twin role for split-brain handling (0120)
  {
    table: "sync_peers",
    column: "local_role",
    addedBy: "0120_sync_peers_local_role.sql",
  },

  // trusted_issuers — pod-level registry of approved external services (0001)
  {
    table: "trusted_issuers",
    column: "status",
    addedBy: "0001_trusted_issuers.sql",
  },
  {
    table: "trusted_issuers",
    column: "issuer_url",
    addedBy: "0001_trusted_issuers.sql",
  },
  // Generic trusted-issuer federation (0192/0193). These server-only ledger
  // tables are a hard authentication dependency: if any is absent, fail at
  // boot rather than accepting a replayable assertion or failing mid-login.
  {
    table: "federated_identity_links",
    column: "issuer_id",
    addedBy: "0192_generic_federation_identity_links.sql",
  },
  {
    table: "federated_access_receipts",
    column: "issuer_id",
    addedBy: "0192_generic_federation_identity_links.sql",
  },
  {
    table: "issuer_identity_link_receipts",
    column: "receipt_id",
    addedBy: "0192_generic_federation_identity_links.sql",
  },
  {
    table: "federated_assertion_receipts",
    column: "issuer_id",
    addedBy: "0193_federated_assertion_receipts.sql",
  },
  // Pod-owned browser application connection ledger (0194). This remains
  // generic: it names issuers and application clients, never a particular
  // control plane or hosted deployment.
  {
    table: "federated_application_connections",
    column: "issuer_id",
    addedBy: "0194_federated_application_connections.sql",
  },
  {
    table: "federated_application_connection_requests",
    column: "continuation_hash",
    addedBy: "0194_federated_application_connections.sql",
  },

  // source_configs — pluggable feed source providers (0008)
  {
    table: "source_configs",
    column: "provider_type",
    addedBy: "0008_source_configs.sql",
  },
  {
    table: "source_configs",
    column: "config",
    addedBy: "0008_source_configs.sql",
  },
  {
    table: "source_configs",
    column: "enabled",
    addedBy: "0008_source_configs.sql",
  },

  // source_subscriptions — feeds × sources × params + cursor (0008)
  {
    table: "source_subscriptions",
    column: "feed_id",
    addedBy: "0008_source_configs.sql",
  },
  {
    table: "source_subscriptions",
    column: "source_config_id",
    addedBy: "0008_source_configs.sql",
  },
  {
    table: "source_subscriptions",
    column: "cursor",
    addedBy: "0008_source_configs.sql",
  },

  // pod_settings — singleton row holding pod-wide defaults (0020)
  {
    table: "pod_settings",
    column: "settings",
    addedBy: "0020_pod_settings.sql",
  },

  // pod_members — durable pod-membership identity (0205). Absence means a pod is
  // on a pre-0205 schema where the AccessContext pod-membership lookup / the
  // Wave 2 podShared floor branch would reference a missing table.
  {
    table: "pod_members",
    column: "user_id",
    addedBy: "0205_pod_members.sql",
  },
  {
    table: "pod_members",
    column: "pod_role",
    addedBy: "0205_pod_members.sql",
  },

  // mcp_connect_codes — one-time CP-MCP consent codes (0206). Absence means a pod
  // is on a pre-0206 schema where apiKeys.beginMcpConnect / POST /api/hub/mcp/redeem
  // would reference a missing table.
  {
    table: "mcp_connect_codes",
    column: "code_hash",
    addedBy: "0206_mcp_connect_codes.sql",
  },
  {
    table: "mcp_connect_codes",
    column: "pod_user_id",
    addedBy: "0206_mcp_connect_codes.sql",
  },

  // oauth_clients / oauth_authorization_codes — the pod as its own OAuth 2.1
  // authorization server (0207, "Path B": claude.ai connects straight to the pod
  // with the control plane out of the trust path). Absence means a pod is on a
  // pre-0207 schema where GET /authorize, POST /register and POST /token would
  // reference missing tables.
  {
    table: "oauth_clients",
    column: "client_id",
    addedBy: "0207_pod_oauth_authorization_server.sql",
  },
  {
    table: "oauth_clients",
    column: "redirect_uris",
    addedBy: "0207_pod_oauth_authorization_server.sql",
  },
  {
    table: "oauth_authorization_codes",
    column: "code_hash",
    addedBy: "0207_pod_oauth_authorization_server.sql",
  },
  // The governance-critical column: the consenting human copied onto the minted
  // key as linkedUserId, which is what makes agentUserId defined on the MCP
  // request and routes Claude's writes through checkPermissionOrPropose().
  {
    table: "oauth_authorization_codes",
    column: "user_id",
    addedBy: "0207_pod_oauth_authorization_server.sql",
  },
  {
    table: "oauth_authorization_codes",
    column: "code_challenge",
    addedBy: "0207_pod_oauth_authorization_server.sql",
  },
  // Single-use rides entirely on this column: the atomic claim is
  // `UPDATE … WHERE consumed_at IS NULL … RETURNING`. Without it a code could be
  // replayed into a second access token, so its absence must fail startup.
  {
    table: "oauth_authorization_codes",
    column: "consumed_at",
    addedBy: "0207_pod_oauth_authorization_server.sql",
  },

  // workspaces — soft-archive support (0020)
  {
    table: "workspaces",
    column: "archived_at",
    addedBy: "0020_workspaces_archived_at.sql",
  },
  // workspaces — domain self-description (0152)
  {
    table: "workspaces",
    column: "domain",
    addedBy: "0152_workspace_domain.sql",
  },

  // messaging_accounts — provider-agnostic messaging connector (0022)
  {
    table: "messaging_accounts",
    column: "user_id",
    addedBy: "0022_messaging_accounts.sql",
  },

  // cell_instances — persisted universal cell rendering unit (0041)
  {
    table: "cell_instances",
    column: "cell_type",
    addedBy: "0041_cell_instances.sql",
  },
  {
    table: "cell_instances",
    column: "config",
    addedBy: "0041_cell_instances.sql",
  },

  // workspaces — agent workspace type column promotion (0042)
  {
    table: "workspaces",
    column: "workspace_type",
    addedBy: "0042_workspace_type_column.sql",
  },

  {
    table: "cell_instances",
    column: "source_document_id",
    addedBy: "0041_cell_instances.sql",
  },
  {
    table: "cell_instances",
    column: "trust_level",
    addedBy: "0041_cell_instances.sql",
  },

  // artifacts — artifact ledger, Phase 1 of Desk system (0125)
  {
    table: "artifacts",
    column: "state",
    addedBy: "0125_artifacts.sql",
  },
  {
    table: "artifacts",
    column: "placement",
    addedBy: "0125_artifacts.sql",
  },
  {
    table: "artifacts",
    column: "origin_kind",
    addedBy: "0125_artifacts.sql",
  },

  // tools / playbooks / links — Playbooks & Capability Substrate (0126)
  {
    table: "tools",
    column: "kind",
    addedBy: "0126_playbooks_capability_substrate.sql",
  },
  {
    table: "tools",
    column: "created_by",
    addedBy: "0126_playbooks_capability_substrate.sql",
  },
  {
    table: "playbooks",
    column: "goal_template",
    addedBy: "0126_playbooks_capability_substrate.sql",
  },
  {
    table: "playbooks",
    column: "status",
    addedBy: "0126_playbooks_capability_substrate.sql",
  },
  {
    table: "capabilities",
    column: "created_by",
    addedBy: "0147_capabilities.sql",
  },
  {
    table: "links",
    column: "from_type",
    addedBy: "0126_playbooks_capability_substrate.sql",
  },
  {
    table: "links",
    column: "link_type",
    addedBy: "0126_playbooks_capability_substrate.sql",
  },

  // tools / skills — per-capability approval gate (0143). Absence means a pod is
  // on a pre-0143 schema where the dispatcher/loader approval checks would read
  // `undefined` and silently treat everything as unapproved (or crash).
  {
    table: "tools",
    column: "approved",
    addedBy: "0143_capability_approval_state.sql",
  },
  {
    table: "skills",
    column: "approved",
    addedBy: "0143_capability_approval_state.sql",
  },

  // tools — structured verb catalog / capability-matrix axis (0145). Absence
  // means a pod is on a pre-0145 schema where the connector verb catalog and the
  // capability-registry verb×grant read-model would read `undefined`.
  {
    table: "tools",
    column: "capabilities",
    addedBy: "0145_tools_capabilities.sql",
  },

  // tools — dynamic auth binding (0146). Absence means a pod is on a pre-0146
  // schema where the dispatcher's per-user/agent/entity credential resolution
  // would read `undefined` and every tool would behave as 'static'.
  {
    table: "tools",
    column: "auth_binding",
    addedBy: "0146_tool_auth_binding.sql",
  },

  // (capability_templates removed in 0154 — templates live on the Control Plane
  // only; the pod stores none, so there is nothing to assert here.)

  // capability_template_cache — pod-local CACHE of the CP catalog (0155). Absence
  // means a pod is on a pre-0155 schema where the catalog read would fail to find
  // the cache and fall back to a blocking CP fetch on every request.
  {
    table: "capability_template_cache",
    column: "definition",
    addedBy: "0155_capability_template_cache.sql",
  },
  {
    table: "capability_template_cache",
    column: "synced_at",
    addedBy: "0155_capability_template_cache.sql",
  },

  // cp_catalog_cache — pod-local CACHE across all four marketplace kinds
  // (capability | automation | template | cell) (0184). Absence means a pod is
  // on a pre-0184 schema where market.search reads would fail to find the cache.
  {
    table: "cp_catalog_cache",
    column: "kind",
    addedBy: "0184_cp_catalog_cache.sql",
  },
  {
    table: "cp_catalog_cache",
    column: "source",
    addedBy: "0184_cp_catalog_cache.sql",
  },
  {
    table: "cp_catalog_cache",
    column: "definition",
    addedBy: "0184_cp_catalog_cache.sql",
  },

  // playbook_runs — the run ledger / executor spine (0127)
  {
    table: "playbook_runs",
    column: "playbook_id",
    addedBy: "0129_playbook_runs.sql",
  },
  {
    table: "playbook_runs",
    column: "status",
    addedBy: "0129_playbook_runs.sql",
  },

  // events — agent-run observability telemetry (0131)
  {
    table: "events",
    column: "is_agent",
    addedBy: "0131_agent_run_observability.sql",
  },
  {
    table: "events",
    column: "agent_user_id",
    addedBy: "0131_agent_run_observability.sql",
  },
  {
    table: "events",
    column: "run_status",
    addedBy: "0131_agent_run_observability.sql",
  },

  // vault_grants → capability grants generalization (0142). The polymorphic
  // subject columns are what the resolver/issuance now key on; their absence
  // means a pod is on a pre-0142 schema and grant redemption would break.
  {
    table: "vault_grants",
    column: "grantable_type",
    addedBy: "0142_capability_grants.sql",
  },
  {
    table: "vault_grants",
    column: "exec_mode",
    addedBy: "0142_capability_grants.sql",
  },

  // relations — polymorphic endpoints (0041)
  {
    table: "relations",
    column: "source_kind",
    addedBy: "0041_cell_instances.sql",
  },
  {
    table: "relations",
    column: "target_kind",
    addedBy: "0041_cell_instances.sql",
  },
  {
    table: "relations",
    column: "source_cell_id",
    addedBy: "0041_cell_instances.sql",
  },
  {
    table: "relations",
    column: "target_cell_id",
    addedBy: "0041_cell_instances.sql",
  },

  // provider integrations — credential backend registry (0150)
  {
    table: "providers",
    column: "slug",
    addedBy: "0150_provider_integrations.sql",
  },
  {
    table: "providers",
    column: "backend_type",
    addedBy: "0150_provider_integrations.sql",
  },
  {
    table: "provider_integrations",
    column: "provider_id",
    addedBy: "0150_provider_integrations.sql",
  },
  {
    table: "provider_integrations",
    column: "slug",
    addedBy: "0150_provider_integrations.sql",
  },
  {
    table: "secrets",
    column: "provider_integration_id",
    addedBy: "0150_provider_integrations.sql",
  },

  // O(1) sha256 lookup path for API-key verification (0157)
  {
    table: "api_keys",
    column: "key_lookup_hash",
    addedBy: "0157_api_key_lookup_hash.sql",
  },
  // Vault-as-connection-registry: the marker column proving 0161 ran (it adds
  // capability_id/account_hint/context_type/context_id/is_default together).
  {
    table: "secrets",
    column: "capability_id",
    addedBy: "0161_secrets_capability_connections.sql",
  },
  // Pod-wide connection tier (0211): shared vault keys usable without a per-user
  // grant. Absence means a pod is on a pre-0211 schema.
  {
    table: "secrets",
    column: "is_pod_wide",
    addedBy: "0211_secrets_pod_wide_connection_tier.sql",
  },

  // channel_egress — channel-agnostic outbound action outbox (0162). Absence
  // means a pod is on a pre-0162 schema where the egress write-helper / read-ack
  // Hub routes would hit a missing table.
  {
    table: "channel_egress",
    column: "external_source",
    addedBy: "0162_channel_egress.sql",
  },
  {
    table: "channel_egress",
    column: "status",
    addedBy: "0162_channel_egress.sql",
  },

  // views — project scope column for scoped surfaces (whiteboard/home/bento per
  // project lens). Absence means a pod is on a pre-0166 schema.
  {
    table: "views",
    column: "project_id",
    addedBy: "0166_views_project_id.sql",
  },

  // automations — per-automation persistent state (watermark/cursor). Absence
  // means a pod is on a pre-0167 schema where the set_state output node and
  // {{automation.state.*}} template resolution would hit a missing column.
  {
    table: "automations",
    column: "state",
    addedBy: "0167_automation_state.sql",
  },

  // entity_centrality — global PageRank score per entity (Horizon Phase 3, 0168).
  // Absence means a pod is on a pre-0168 schema; the Horizon `C` read gracefully
  // falls back to the propagation proxy, but the tripwire still flags the drift.
  {
    table: "entity_centrality",
    column: "score",
    addedBy: "0168_entity_centrality.sql",
  },

  // secret_usages — many-to-many "used by" join for the vault Connections face
  // (Vault Next-Grade WP-B1, 0173). Absence means a pod is on a pre-0173 schema
  // where `secretsVault.usedBy` / `getDetailBundle` would hit a missing table.
  {
    table: "secret_usages",
    column: "consumer_type",
    addedBy: "0173_secret_usages.sql",
  },
  {
    table: "secret_usages",
    column: "consumer_id",
    addedBy: "0173_secret_usages.sql",
  },

  // Kind + Facets Wave 1A (0174): profiles gain profile_kind ('kind'|'role')
  // + applicable_kinds, and entity_facets attaches role-profiles to entities.
  // Absence means a pod is on a pre-0174 schema; the facet repository and
  // getEffectiveFacets() would hit a missing column/table.
  {
    table: "profiles",
    column: "profile_kind",
    addedBy: "0174_entity_facets.sql",
  },
  {
    table: "profiles",
    column: "applicable_kinds",
    addedBy: "0174_entity_facets.sql",
  },
  {
    table: "entity_facets",
    column: "id",
    addedBy: "0174_entity_facets.sql",
  },

  // Kind + Facets Wave 3A (0175): the `_conversions` ledger — mirrors
  // `_migrations` for DATA ops. Absence means a pod is on a pre-0175 schema
  // where the conversion engine's applied-set read would hit a missing table.
  {
    table: "_conversions",
    column: "op_key",
    addedBy: "0175_conversions_ledger.sql",
  },

  // Watchtower write-time security cohorts (BF-7 / BF-8, 0177). Absence means a
  // pod is on a pre-0177 schema where getSecurityStats' `noTotp` / `reused`
  // counts would reference missing columns.
  {
    table: "secrets",
    column: "has_totp",
    addedBy: "0177_secrets_watchtower_cohorts.sql",
  },
  {
    table: "secrets",
    column: "password_fingerprint",
    addedBy: "0177_secrets_watchtower_cohorts.sql",
  },

  // playbook_automations — first-class playbook→automations composition (0179).
  // Absence means a pod is on a pre-0179 schema where the editable composition
  // read/write would hit a missing table.
  {
    table: "playbook_automations",
    column: "playbook_id",
    addedBy: "0179_playbook_automations.sql",
  },
  {
    table: "playbook_automations",
    column: "automation_id",
    addedBy: "0179_playbook_automations.sql",
  },
  {
    table: "playbook_automations",
    column: "role",
    addedBy: "0179_playbook_automations.sql",
  },
  {
    table: "playbook_automations",
    column: "sort_order",
    addedBy: "0179_playbook_automations.sql",
  },
  {
    table: "playbook_automations",
    column: "created_at",
    addedBy: "0179_playbook_automations.sql",
  },
  {
    table: "playbook_automations",
    column: "updated_at",
    addedBy: "0179_playbook_automations.sql",
  },

  // playbook_enrollments — entity ↔ playbook enrollment, many entities per
  // playbook (0180). Absence means a pod is on a pre-0180 schema where the
  // enrollment read/write would hit a missing table.
  {
    table: "playbook_enrollments",
    column: "playbook_id",
    addedBy: "0180_playbook_enrollments.sql",
  },
  {
    table: "playbook_enrollments",
    column: "entity_id",
    addedBy: "0180_playbook_enrollments.sql",
  },
  {
    table: "playbook_enrollments",
    column: "status",
    addedBy: "0180_playbook_enrollments.sql",
  },
  {
    table: "playbook_enrollments",
    column: "step_state",
    addedBy: "0180_playbook_enrollments.sql",
  },
  {
    table: "playbook_enrollments",
    column: "enrolled_at",
    addedBy: "0180_playbook_enrollments.sql",
  },
  {
    table: "playbook_enrollments",
    column: "updated_at",
    addedBy: "0180_playbook_enrollments.sql",
  },

  // AI Teaching Substrate Wave 1a (0183): skills gain the tool↔skill teaching
  // linkage + progressive-disclosure grouping, profiles gain a per-kind AI
  // posture base layer. Absence means a pod is on a pre-0183 schema where the
  // skill seeder / brief composer would hit a missing column.
  {
    table: "skills",
    column: "teaches_tools",
    addedBy: "0183_ai_teaching_substrate_columns.sql",
  },
  {
    table: "skills",
    column: "skill_group",
    addedBy: "0183_ai_teaching_substrate_columns.sql",
  },
  {
    table: "skills",
    column: "always_on",
    addedBy: "0183_ai_teaching_substrate_columns.sql",
  },
  {
    table: "profiles",
    column: "ai_posture",
    addedBy: "0183_ai_teaching_substrate_columns.sql",
  },

  // WORKFLOW-AS-PLACE Wave 1 attribution spine (0198): step→proposal
  // attribution, proposal revision history, workflow-definition versioning, and
  // per-run definition snapshots. Absence means a pod is on a pre-0198 schema
  // where the executor's proposal step-refs / version bumps / snapshot writes
  // would hit missing columns.
  {
    table: "proposals",
    column: "step_run_id",
    addedBy: "0198_workflow_attribution_spine.sql",
  },
  {
    table: "proposals",
    column: "node_id",
    addedBy: "0198_workflow_attribution_spine.sql",
  },
  {
    table: "proposals",
    column: "revision_history",
    addedBy: "0198_workflow_attribution_spine.sql",
  },
  {
    table: "playbooks",
    column: "version",
    addedBy: "0198_workflow_attribution_spine.sql",
  },
  {
    table: "automations",
    column: "version",
    addedBy: "0198_workflow_attribution_spine.sql",
  },
  {
    table: "playbook_runs",
    column: "definition_snapshot",
    addedBy: "0198_workflow_attribution_spine.sql",
  },
  {
    table: "playbook_runs",
    column: "replay_of",
    addedBy: "0198_workflow_attribution_spine.sql",
  },
  {
    table: "automation_runs",
    column: "definition_snapshot",
    addedBy: "0198_workflow_attribution_spine.sql",
  },
  {
    table: "automation_runs",
    column: "replay_of",
    addedBy: "0198_workflow_attribution_spine.sql",
  },
  {
    table: "automation_runs",
    column: "summary_message_id",
    addedBy: "0199_automation_run_summary_message.sql",
  },
  {
    table: "automation_runs",
    column: "subject_entity_id",
    addedBy: "0201_automation_run_subject.sql",
  },
  {
    table: "automation_runs",
    column: "path_taken",
    addedBy: "0214_automation_run_path_taken.sql",
  },
  {
    table: "automation_step_runs",
    column: "tokens_used",
    addedBy: "0198_workflow_attribution_spine.sql",
  },
  {
    table: "automation_step_runs",
    column: "cost_usd",
    addedBy: "0198_workflow_attribution_spine.sql",
  },
  // P4-lite W0 — cross-pod project refs. NOTE: `projects` is created by 0151,
  // not the baseline, so this tripwire is the column's only startup guard.
  {
    table: "projects",
    column: "slug",
    addedBy: "0200_project_slug.sql",
  },
  // Governance Rules (Phase A) — the ONE store for agent/pod auto-approve
  // policy. New table; checking one column confirms the migration ran.
  {
    table: "governance_rules",
    column: "verdict",
    addedBy: "0215_governance_rules.sql",
  },
  // Capability run receipts (0219) — at-most-once claim for a DIRECT-run
  // WRITE/external capability verb. New table; checking one column confirms the
  // migration ran (a missing table would fail the double-send guard silently).
  {
    table: "capability_run_receipts",
    column: "idempotency_key",
    addedBy: "0219_capability_run_receipts.sql",
  },
];

export interface SchemaCoherenceResult {
  ok: boolean;
  missing: RequiredColumn[];
  checked: number;
}

/**
 * Check that every critical column exists in the live DB.
 *
 * Returns the result rather than throwing so callers can log cleanly.
 * Use `assertSchemaCoherence()` for the throw-on-failure variant.
 */
export async function checkSchemaCoherence(): Promise<SchemaCoherenceResult> {
  const tables = Array.from(new Set(REQUIRED_COLUMNS.map((c) => c.table)));

  // One query: SELECT table_name, column_name FROM information_schema.columns
  // WHERE table_schema = 'public' AND table_name = ANY($1)
  const rows = await sql<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY(${tables})
  `;

  const present = new Set<string>();
  for (const row of rows) {
    present.add(`${row.table_name}.${row.column_name}`);
  }

  const missing: RequiredColumn[] = [];
  for (const req of REQUIRED_COLUMNS) {
    if (!present.has(`${req.table}.${req.column}`)) {
      missing.push(req);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    checked: REQUIRED_COLUMNS.length,
  };
}

/**
 * Run the coherence check and throw a loud, structured error if anything is
 * missing. Intended for server bootstrap — call this AFTER migrations run
 * and BEFORE the HTTP server starts listening.
 *
 * On failure the error message lists every missing (table, column) pair and
 * the migration that should have added it.
 */
export async function validateSchemaCoherence(): Promise<void> {
  // Firewall floor (0169): the client-comms immutability trigger MUST exist —
  // without it the DB-layer firewall is down. Refuse to boot if it's missing.
  const trig = await sql<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = 'trg_channels_branch_purpose_immutable'
         AND NOT tgisinternal
    ) AS present
  `;
  if (!trig[0]?.present) {
    throw new Error(
      "SCHEMA COHERENCE CHECK FAILED — firewall trigger " +
        "'trg_channels_branch_purpose_immutable' is missing (migration 0169). " +
        "The client-comms immutability floor is down; the pod refuses to start."
    );
  }

  // Doctrine floor (0220): a KIND is pod-wide. `profiles.entity_scope` must
  // default to 'pod'. Checked as a DEFAULT (not just column existence) because
  // the failure mode here is not an error — it is a silent INVERSION: with the
  // old 'workspace' default, every kind a template or an agent creates without
  // an explicit entityScope lands workspace-scoped, and nothing ever complains.
  // See APP-DOCK-MENTAL-MODEL-PLAN.md §1b.
  const entityScopeDefault = await sql<
    Array<{ column_default: string | null }>
  >`
    SELECT column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'profiles'
       AND column_name = 'entity_scope'
  `;
  const defaultExpr = entityScopeDefault[0]?.column_default ?? null;
  if (defaultExpr !== null && !defaultExpr.startsWith("'pod'")) {
    throw new Error(
      "SCHEMA COHERENCE CHECK FAILED — profiles.entity_scope defaults to " +
        `${defaultExpr} instead of 'pod' (migration ` +
        "0220_profiles_entity_scope_pod_default.sql). Kinds are pod-wide; with " +
        "the old default every kind created without an explicit entityScope " +
        "silently lands workspace-scoped. The pod refuses to start."
    );
  }

  const result = await checkSchemaCoherence();

  if (result.ok) {
    return;
  }

  const lines = [
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "SCHEMA COHERENCE CHECK FAILED",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `The live database is missing ${result.missing.length} column(s) that`,
    "the Drizzle schema and runtime code require. The server cannot start.",
    "",
    "Missing columns (table.column — expected in migration):",
  ];
  for (const m of result.missing) {
    lines.push(`  • ${m.table}.${m.column}  ← ${m.addedBy}`);
  }
  lines.push("");
  lines.push(
    "Run the migration tool (pnpm --filter @synap/database migrate) to apply"
  );
  lines.push(
    "0099_schema_reconciliation.sql, then restart the pod. If the migration"
  );
  lines.push(
    "itself fails, investigate its error output — the runner no longer"
  );
  lines.push("silently skips failed migrations.");
  lines.push(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  );
  lines.push("");

  const message = lines.join("\n");
  throw new Error(message);
}
