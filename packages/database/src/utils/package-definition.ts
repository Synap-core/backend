/**
 * PackageDefinition — Unified workspace provisioning from ONE JSON config.
 *
 * Composes all existing definition types (workspace, capabilities, automations,
 * playbooks, loops, agents, channels) into a single declarative format. The
 * `applyPackageDefinition` function orchestrates provisioning in dependency order
 * without duplicating any existing logic — it delegates to the canonical
 * createWorkspaceFromDefinition, capabilities/apply, loops/apply, etc.
 *
 * This is the COMPOSITION layer, not a replacement. Individual endpoints remain
 * for fine-grained operations. Templates use PackageDefinition.
 */

import type { WorkspaceDefinitionInput } from "./create-workspace-from-definition.js";

// ─── Package-level metadata ──────────────────────────────────────────────────

export interface PackageMeta {
  slug: string;
  icon?: string;
  color?: string;
  tags?: string[];
  /** CP marketplace tier requirement (null = free) */
  requiredTier?: string | null;
  isPublic?: boolean;
  version?: string;
}

// ─── Capability installation ─────────────────────────────────────────────────

export interface PackageCapability {
  /** Template key to install (matches capability template key) */
  templateKey: string;
  /** Override default params with {{var}} interpolation */
  params?: Record<string, string>;
  /** Installation mode: "apply" (create+update) or "install" (create only) */
  mode?: "apply" | "install";
}

// ─── Automation seeding ──────────────────────────────────────────────────────

export interface PackageAutomation {
  name: string;
  description?: string;
  trigger: {
    type: "event" | "cron" | "webhook" | "manual";
    eventPattern?: string;
    cron?: string;
    filters?: Record<string, unknown>;
  };
  flow?: {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
  status?: "draft" | "active" | "paused";
  /** Wait before activating (ms). Default 0 = active immediately. */
  activateDelayMs?: number;
}

// ─── Playbook seeding ────────────────────────────────────────────────────────

export interface PackagePlaybook {
  name: string;
  description?: string;
  goalTemplate: string;
  params?: Array<{
    name: string;
    type: "text" | "number" | "entity" | "choice" | "boolean";
    label?: string;
    required?: boolean;
    defaultValue?: unknown;
  }>;
  executor?: "is-agent" | "external-agent" | "hybrid";
  inputStrategy?: "none" | "static" | "rotating" | "query";
  channelSpec?: {
    type: "GROUP" | "AGENT_COLLAB" | "THREAD";
    members?: string[];
    aiReactionMode?: "on_mention" | "always" | "never";
  };
  schedule?: { cron: string } | null;
  grants?: string[]; // tool/skill keys
  status?: "draft" | "active" | "paused";
}

// ─── Loop seeding ──────────────────────────────────────────────────────────

export interface PackageLoop {
  name: string;
  description?: string;
  trigger: {
    type: "cron" | "event" | "manual";
    cron?: string;
    eventType?: string;
  };
  playbookRef: string; // references PackagePlaybook.name
  params?: Record<string, string>;
}

// ─── Agent seeding ─────────────────────────────────────────────────────────

export interface PackageAgent {
  name: string;
  agentType: string; // free string — "marketing-agent", "builder-agent", etc.
  description?: string;
  /** Skill keys this agent has access to */
  skillKeys?: string[];
  /** Tool keys this agent has access to */
  toolKeys?: string[];
  /** Provider configuration */
  provider?: {
    type: "ollama" | "openrouter" | "anthropic" | "openai";
    model?: string;
  };
}

// ─── Channel seeding ────────────────────────────────────────────────────────

export interface PackageChannel {
  name: string;
  description?: string;
  channelType: "GROUP" | "AGENT_COLLAB" | "THREAD" | "PERSONAL";
  /** Agent IDs to add as members on creation */
  memberAgentRefs?: string[]; // references PackageAgent.name
}

// ─── The unified definition ──────────────────────────────────────────────────

export interface PackageDefinition {
  /** CP marketplace metadata (optional — only needed for marketplace templates) */
  _meta?: PackageMeta;

  // ── Core: workspace (existing WorkspaceDefinitionInput) ──────────────────
  workspaceName?: string;
  description?: string;
  workspacePurpose?: WorkspaceDefinitionInput["workspacePurpose"];
  workspaceSubtype?: string;
  workspaceVisibility?: WorkspaceDefinitionInput["workspaceVisibility"];
  workspaceCapabilities?: string[];
  icon?: string;
  color?: string;

  /** Entity profiles with propertyDefs */
  profiles?: WorkspaceDefinitionInput["profiles"];
  /** Views: table, kanban, calendar, bento, graph, etc. */
  views?: WorkspaceDefinitionInput["views"];
  /** Seed entities created on provisioning */
  suggestedEntities?: WorkspaceDefinitionInput["suggestedEntities"];
  /** Relations between seed entities */
  suggestedRelations?: WorkspaceDefinitionInput["suggestedRelations"];
  /** Entity card display templates */
  displayTemplates?: WorkspaceDefinitionInput["displayTemplates"];
  /** Schema-level profile-to-profile links */
  entityLinks?: WorkspaceDefinitionInput["entityLinks"];
  /** Home bento dashboard layout */
  bentoLayout?: WorkspaceDefinitionInput["bentoLayout"];
  /** Per-profile entity detail bento layouts */
  profileEntityBentoTemplates?: WorkspaceDefinitionInput["profileEntityBentoTemplates"];
  /** Sidebar layout: apps, profiles, sections */
  layoutConfig?: WorkspaceDefinitionInput["layoutConfig"];
  /** Workspace composition: import from other workspaces */
  extends?: WorkspaceDefinitionInput["extends"];

  // ── New layers (not in WorkspaceDefinitionInput today) ───────────────────
  /** Capabilities to install (tools, skills, vault secrets) */
  capabilities?: PackageCapability[];
  /** Automations to seed */
  automations?: PackageAutomation[];
  /** Playbooks to seed */
  playbooks?: PackagePlaybook[];
  /** Loops to seed (playbook + trigger bundles) */
  loops?: PackageLoop[];
  /** Agent users/configs to create */
  agents?: PackageAgent[];
  /** Channels/rooms to create */
  channels?: PackageChannel[];
}
