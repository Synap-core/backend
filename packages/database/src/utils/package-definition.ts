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

// ─── Onboarding spec (the per-workspace dynamic onboarding CONTEXT) ──────────
//
// Stored on `workspace.settings.onboarding`. The SHARED `onboard` skill (the
// reusable adaptive interview PROCESS) reads this to know WHAT a given
// workspace needs — without a per-domain skill file. The skill stays generic;
// the domain knowledge lives here as data, declared by each template.
//
// This is NOT a rigid questionnaire. It's a GOAL + the data shape to collect +
// domain framing the agent uses to ask good questions and adapt as it learns
// about the user. The agent keeps interviewing until the goal is satisfied.

export interface OnboardingCollectTarget {
  /** Profile slug to populate (e.g. "brand_guidelines", "repository"). */
  profileSlug: string;
  /** Human description of what to capture for this target. */
  what: string;
  /** Roughly how many to expect ("one", "a few", "several") — guides depth. */
  cardinality?: "one" | "few" | "several";
  /** Key fields the agent should make sure to fill. */
  keyFields?: string[];
}

/**
 * Authored domain expertise the onboarding agent LEADS with — so it resolves
 * the founder's gaps (brings best practices they lack, surfaces what they miss)
 * instead of only extracting what they already know. Mirrors
 * `TemplateOnboardingExpertise` in @synap-core/workspace-templates.
 */
export interface OnboardingExpertise {
  /** Concrete starting points the agent proposes instead of asking blank. */
  starters?: string[];
  /** Blind spots founders in this domain miss — surfaced proactively. */
  blindSpots?: string[];
  /** What a great result looks like here — the bar the agent pushes toward. */
  bar?: string;
}

export interface OnboardingSpec {
  /** The outcome this onboarding achieves, in one sentence. */
  goal: string;
  /**
   * Domain framing the agent uses to ask good, adaptive questions. Free text —
   * the voice/expertise the agent adopts for THIS workspace (e.g. "act as a
   * brand strategist; tease out voice, audience, and cadence").
   */
  framing: string;
  /**
   * Authored domain expertise the agent leads with (optional). Turns the
   * interview from "extract" into "resolve the founder's gaps". Consumed by the
   * `onboard` skill's "Lead with your expertise" step.
   */
  expertise?: OnboardingExpertise;
  /** What structured data to collect (entities to create + their key fields). */
  collect: OnboardingCollectTarget[];
  /** A few opening questions — the agent adapts from here, never rigid. */
  openingQuestions?: string[];
  /**
   * "Done" signal: when the agent can consider onboarding complete. Free text
   * the agent self-evaluates against (e.g. "voice + 2 audience segments + a
   * first month of content cadence captured").
   */
  doneWhen?: string;
}

// ─── Template-composition dependencies ───────────────────────────────────────
//
// A dependency this package declares on ANOTHER template/package. The install
// resolver (`POST /api/hub/packages/apply` → `resolvePackageDependencies`) reads
// these to build the pod's template graph: every dependency is ensured present
// before this package is applied — missing built-in `workspace` templates install
// first (topologically) — and a `compose` dependency LAYERS this package's schema
// additively onto the dependency's workspace instead of creating a second
// workspace. Mirrors `TemplateDependency` in @synap-core/workspace-templates
// VERBATIM so the wire shape never drifts.

export type PackageDependencyKind = "workspace" | "capability" | "automation";
export type PackageDependencyRelation = "compose" | "require";

export interface TemplateDependency {
  /** Slug of the template/package this one depends on. */
  slug: string;
  /**
   * What the dependency is. Default `'workspace'`. Only `'workspace'`
   * dependencies can be `compose`d; `'capability'`/`'automation'` are always
   * `require`d present without merging.
   */
  kind?: PackageDependencyKind;
  /**
   * How this template relates to the dependency:
   * - `'compose'`: this template is an OVERLAY on the dependency's workspace.
   *   The base is installed first if absent, then this template's profiles /
   *   roles / relations / views are applied ADDITIVELY onto the base workspace
   *   — no separate workspace is created for this template.
   * - `'require'` (default): the dependency must be present on the pod as its
   *   own artifact, but this template does not merge into it.
   */
  relation?: PackageDependencyRelation;
  /** Short human reason shown in the install-time "this also installs…" prompt. */
  reason?: string;
}

// ─── The unified definition ──────────────────────────────────────────────────

export interface PackageDefinition {
  /** CP marketplace metadata (optional — only needed for marketplace templates) */
  _meta?: PackageMeta;

  // ── Core: workspace (existing WorkspaceDefinitionInput) ──────────────────
  workspaceName?: string;
  description?: string;
  // workspacePurpose removed — redundant with workspace_type, fixed enums are bad engineering
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
  /**
   * Per-workspace onboarding context (the dynamic "what this workspace needs"
   * the shared `onboard` skill reads). Written to workspace.settings.onboarding.
   */
  onboarding?: OnboardingSpec;
  /**
   * Template-composition dependencies — other templates this package needs. The
   * install resolver installs missing built-in `workspace` dependencies first
   * and, for a `compose` dependency, layers this package additively onto the
   * dependency's workspace. See {@link TemplateDependency}.
   */
  dependencies?: TemplateDependency[];
}
