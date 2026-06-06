/**
 * Workspaces Schema - Multi-user workspace support
 *
 * A workspace can be:
 * - Personal (single user)
 * - Team (multiple users with roles)
 * - Enterprise (advanced features)
 */

import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users.js";

export interface WorkspaceSidebarItem {
  kind: "app" | "view" | "profile" | "external" | "cell";
  /** App ID for kind='app' (e.g. 'dashboard', 'intelligence', 'data') */
  appId?: string;
  /** View name for kind='view' — resolved lazily at click time */
  viewName?: string;
  /** View ID for kind='view' — preferred over viewName when available */
  viewId?: string;
  /**
   * Profile slug for kind='profile'.
   * ActivityBar resolves this to the profile bento view via workspace.settings.profileBentoViewIds,
   * or lazily creates one via ensureProfileBento if not yet set.
   */
  profileSlug?: string;
  /** URL template for kind='external'. Use __POD_URL__ as a placeholder. */
  url?: string;
  /** Widget/cell type key for kind='cell' (e.g. 'ai-chat', 'proposals-list') */
  cellKey?: string;
  /** Config props passed to the cell when opened as a panel */
  cellProps?: Record<string, unknown>;
  /** Display label shown in the sidebar */
  label?: string;
  /** Lucide icon name override */
  icon?: string;
  /**
   * URL patterns that auto-activate this item's highlight when the active browser
   * tab URL matches. Checked as prefix (startsWith). Supports the __POD_URL__
   * placeholder. When omitted, kind='external' items auto-match their own url.
   */
  matchUrls?: string[];
  /**
   * Which sidebar section this item belongs to.
   * 'workspace' = pod data items (views, profiles, pod links).
   * 'space'     = browser/app items (app shortcuts, pinned URLs).
   * Omitted items default to 'workspace' for backward compatibility.
   */
  section?: string;
}

/**
 * A named collapsible section in the sidebar.
 * Items are assigned to sections via WorkspaceSidebarItem.section.
 */
export interface WorkspaceSidebarSection {
  /** Stable id — used as the key in WorkspaceSidebarItem.section */
  id: string;
  /** Display label */
  label: string;
  /** When true the section body is hidden; chevron still shown */
  collapsed?: boolean;
}

export interface WorkspaceLayoutConfig {
  pinnedApps?: string[]; // App IDs pinned to the top of the activity bar
  defaultView?: string; // Default view when entering workspace (web)
  /**
   * Default app view to navigate to when a workspace is first opened (browser only).
   * Applied once per profile switch by useTemplateIntegration.
   * Valid values: 'browser' | 'dashboard' | 'data' | 'intelligence' | 'terminal' | …
   */
  defaultApp?: string;
  theme?: string; // Per-workspace theme override: 'dark' | 'light'
  /** Ordered list of sidebar items. When set, replaces the generic app list. */
  sidebarItems?: WorkspaceSidebarItem[];
  /**
   * Named sections for the sidebar. Default when absent: two sections —
   * 'workspace' (pod data) and 'space' (browser/app shortcuts).
   * Section collapsed state is stored here and persisted to the pod.
   */
  sidebarSections?: WorkspaceSidebarSection[];
}

/**
 * MCP server configuration — stored per workspace.
 * Agents in this workspace will have access to tools from these servers.
 */
export interface McpServerConfig {
  /** Unique slug within the workspace, e.g. "playwright", "whatsapp" */
  id: string;
  /** Human-readable name shown in UI */
  name: string;
  /** Transport mechanism */
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** Set to false to disable without removing config. Default: true. */
  enabled?: boolean;
}

/**
 * Proactive AI Preferences
 *
 * Controls the AI's proactive intelligence features: morning briefings,
 * weekly digests, health checks, and nudge density. Stored per workspace
 * so users can have different schedules per workspace.
 */
export type ProactiveNudgeDensity = "minimal" | "balanced" | "proactive";

export type EveAiProviderId = "ollama" | "openrouter" | "anthropic" | "openai";

/**
 * Eve-side provider routing policy synced to a workspace (non-secret).
 * This is distinct from Synap's internal intelligence service routing.
 */
export interface EveProviderRoutingPolicy {
  mode?: "local" | "provider" | "hybrid";
  defaultProvider?: EveAiProviderId;
  fallbackProvider?: EveAiProviderId;
  providers?: Array<{
    id: EveAiProviderId;
    enabled?: boolean;
    /** Optional custom base URL for provider gateways (non-secret). */
    baseUrl?: string;
    /** Optional default model hint for clients (non-secret). */
    defaultModel?: string;
  }>;
  /** Whether Eve intends this workspace to follow synced provider policy. */
  syncToSynap?: boolean;
}

export interface ProactiveAiPreferences {
  /** Global kill switch for all proactive AI features. Default: true */
  enabled: boolean;
  morningBriefing: {
    enabled: boolean;
    /** Hour in 24h format (0-23). Default: 8 */
    cronHour: number;
    /** Minute (0-59). Default: 0 */
    cronMinute: number;
    /** IANA timezone. Default: "UTC" */
    timezone: string;
  };
  weeklyDigest: {
    enabled: boolean;
    /** Day of week: 0=Sun..6=Sat. Default: 1 (Monday) */
    dayOfWeek: number;
    /** Hour in 24h format. Default: 9 */
    cronHour: number;
    /** IANA timezone. Default: "UTC" */
    timezone: string;
  };
  healthCheck: {
    enabled: boolean;
    /** How often to run health checks in days. Default: 7 */
    frequencyDays: number;
  };
  /** Controls how many proactive nudges the AI sends. Default: "balanced" */
  nudgeDensity: ProactiveNudgeDensity;
  /**
   * Event-driven proactive triggers (Feature C). Each toggle opts the workspace
   * into reacting to a class of user action. Time-based features above
   * (morningBriefing/weeklyDigest/healthCheck) are independent of these.
   * All default OFF — proactive event reactions are opt-in.
   */
  triggers?: ProactiveAiTriggers;
  /** ISO 8601 timestamp — snooze all proactive AI until this time */
  mutedUntil?: string;
}

/**
 * Per-event opt-in toggles for event-driven proactive AI (Feature C).
 * Keyed by the validated event that fires the proactive scan.
 */
export interface ProactiveAiTriggers {
  /** N captures sharing a topic → propose a Question to track them. */
  captureCluster?: boolean;
  /** Task moved to done → connect it back to its decision/research. */
  taskCompleted?: boolean;
  /** New Question created → suggest research from existing captures. */
  questionCreated?: boolean;
  /** New Decision created → auto-link the research that informed it. */
  decisionCreated?: boolean;
}

/** Default proactive AI preferences for new workspaces */
export function getDefaultProactiveAiPreferences(): ProactiveAiPreferences {
  return {
    enabled: true,
    morningBriefing: {
      enabled: true,
      cronHour: 8,
      cronMinute: 0,
      timezone: "UTC",
    },
    weeklyDigest: {
      enabled: true,
      dayOfWeek: 1,
      cronHour: 9,
      timezone: "UTC",
    },
    healthCheck: {
      enabled: true,
      frequencyDays: 7,
    },
    nudgeDensity: "balanced",
    triggers: {
      captureCluster: false,
      taskCompleted: false,
      questionCreated: false,
      decisionCreated: false,
    },
  };
}

// ── Delivery Preferences ────────────────────────────────────────────────────

/**
 * Which surface(s) receive a signal.
 * - feed         → proactive feed channel (AI-initiated messages)
 * - chat         → personal chat channel (conversational)
 * - notification → notification bell (ephemeral, shown in notification center)
 * - suppress     → don't deliver (silences this signal domain)
 */
export type SignalSurface = "feed" | "chat" | "notification" | "suppress";

/** Routing rule for a single signal domain. */
export interface SignalDeliveryRule {
  surfaces: SignalSurface[];
}

/**
 * Per-workspace delivery preferences.
 * Maps signal domain → which surfaces receive it.
 * Domains without an explicit rule fall back to DEFAULT_DELIVERY_RULES.
 */
export interface DeliveryPreferences {
  /** AI-initiated briefings, digests, insights, nudges */
  proactive?: SignalDeliveryRule;
  /** Automation output channel_message nodes */
  automation?: SignalDeliveryRule;
  /** Connector sync completion signals */
  connector?: SignalDeliveryRule;
  /** IS agent-generated insights (via /proactive/post) */
  ai_insight?: SignalDeliveryRule;
}

/**
 * Match criteria for an agent-routing rule. Every DEFINED field must equal the
 * dispatch context (undefined = wildcard). A trailing "*" on a value is a prefix
 * match (e.g. eventPattern "entity.update.*"). First matching rule wins.
 */
export interface AgentRoutingMatch {
  /** Entity/task type (e.g. "task", "devplane_feature") */
  taskType?: string;
  /** Profile slug of the subject entity */
  profileSlug?: string;
  /** Typed event name/pattern (e.g. "entity.update.completed") */
  eventPattern?: string;
  /** Channel type, when dispatch originates from a channel */
  channelType?: string;
  /** State transition guards (e.g. agent_status from/to) */
  fromState?: string;
  toState?: string;
}

export interface AgentRoutingRule {
  match: AgentRoutingMatch;
  /** Stable agent slug (portable across pods) the matched work dispatches to */
  agentSlug: string;
}

/**
 * Workspace-level agent routing: "this kind of task/event → this registered agent".
 * The canonical replacement for runtime-specific hardwiring (e.g. Hermes-only
 * dispatch). Resolution: first matching rule → defaultAgentSlug → plain IS fallback.
 * Resolved by resolveAgentForTask() in @synap/intelligence-client. Any workspace
 * can use this for automation, not just DevPlane.
 */
export interface AgentRoutingPolicy {
  /** Agent slug used when no rule matches */
  defaultAgentSlug?: string;
  /** Ordered rules; first match wins */
  rules?: AgentRoutingRule[];
}

/**
 * High-level purpose of a workspace inside a pod.
 *
 * `workspaceType` already exists as a promoted column for legacy operational
 * filtering. `workspacePurpose` is the product-facing contract used by the
 * browser and agents to understand how a workspace should be used.
 */
export type WorkspacePurpose =
  | "personal"
  | "project"
  | "agent"
  | "library"
  | "operational";

/**
 * Discoverability/access mode for a workspace.
 *
 * Write access is still controlled by workspace_members + role permissions.
 * `pod_visible` and `pod_joinable` only make the workspace discoverable/readable
 * to authenticated users on the same data pod.
 */
export type WorkspaceVisibility =
  | "private"
  | "members"
  | "pod_visible"
  | "pod_joinable"
  | "public_link";

export type WorkspaceSourceRole = "provider" | "consumer" | "provider-consumer";

export interface WorkspaceDefaultSource {
  workspaceId: string;
  capability?: string;
  profileSlug?: string;
  label?: string;
}

export interface WorkspaceSettings {
  // ─── Entity & UI Settings ───────────────────────────────────────────────────
  defaultEntityTypes?: string[];
  theme?: string;
  aiEnabled?: boolean;
  allowExternalSharing?: boolean;

  // ─── Workspace Directory / Capability Source Contract ───────────────────────
  /**
   * Product-facing purpose used by browser/apps/agents to resolve cross-workspace
   * sources (e.g. a brand-library workspace serving artboards in a project).
   */
  workspacePurpose?: WorkspacePurpose;
  /**
   * Free-form subtype within the purpose, e.g. "brand-library",
   * "research-library", "agent-lab".
   */
  workspaceSubtype?: string;
  /**
   * Discovery/read visibility. Defaults to "members" when absent.
   */
  workspaceVisibility?: WorkspaceVisibility;
  /**
   * Capability ids this workspace provides or consumes, e.g.
   * "brand.library", "brand.assets", "research.sources", "agent.staging".
   */
  workspaceCapabilities?: string[];
  /**
   * Domain → role map. Example: { brand: "provider", research: "consumer" }.
   */
  sourceRoles?: Record<string, WorkspaceSourceRole>;
  /**
   * Domain/capability → default source workspace. Stored on consumer
   * workspaces so features can resolve defaults without copying data.
   */
  defaultSources?: Record<string, WorkspaceDefaultSource>;

  // ─── MCP Server integrations ─────────────────────────────────────────────────
  /** External MCP servers whose tools will be available to AI agents in this workspace */
  mcpServers?: McpServerConfig[];

  // ─── Per-workspace layout configuration ──────────────────────────────────────
  layout?: WorkspaceLayoutConfig;

  // ─── Per-workspace view ID cache ─────────────────────────────────────────────
  /**
   * Maps profile slug → bento dashboard view ID for this workspace.
   * Each entry is the "home page" view for all entities of that profile type.
   * Stored here (not on the profile row) so system/shared profiles can have
   * different bento views per workspace.
   * Populated on workspace creation and lazily via ensureProfileBento.
   * Example: { "deal": "uuid-deal-bento", "contact": "uuid-contact-bento" }
   */
  profileBentoViewIds?: Record<string, string>;

  /**
   * Per-profile default bento layout for entity instance dashboards.
   * When a user opens a single entity in bento mode for the first time,
   * this template is used to seed the bento view (instead of the generic default).
   * Populated from the workspace template at creation time.
   * Example: { "deal": { blocks: [...] }, "contact": { blocks: [...] } }
   */
  profileEntityBentoTemplates?: Record<
    string,
    { blocks: Array<Record<string, unknown>> }
  >;

  /**
   * Per-profile renderer override for THIS workspace (Profile Renderer North Star).
   * Each value is a RendererTarget (from @synap-core/renderer-runtime). Stored as
   * Record<string, unknown> here to avoid pulling a frontend type into the schema
   * package — runtime validation lives in the routers and the canonical type is
   * re-exported by @synap-core/profile-renderer.
   *
   * Resolution chain in ProfileResolutionService.getEffectiveRenderer():
   *   1. this workspace overlay (profileRenderers[slug][slot])
   *   2. profile system default (profiles.default_list_renderer / .default_detail_renderer)
   *   3. hardcoded system fallback
   *
   * Example:
   *   {
   *     "contact": { detail: { kind: "cell", cellKey: "form-detail", props: {} } },
   *     "task":    { list:   { kind: "view", viewId: "uuid-task-kanban" } }
   *   }
   *
   * Spec: synap-team-docs/content/team/platform/profile-renderer.mdx
   */
  profileRenderers?: Record<
    string,
    {
      list?: Record<string, unknown>;
      detail?: Record<string, unknown>;
    }
  >;

  /** UUID of the main whiteboard view for this workspace */
  mainWhiteboardId?: string;

  /**
   * Home dashboard view ID (type='bento', metadata.homeScope='workspace').
   * Stored here for O(1) lookup on workspace open.
   */
  homeDashboardViewId?: string;

  // ─── Intelligence service configuration ──────────────────────────────────────
  intelligenceServiceId?: string; // Default for workspace
  intelligenceServiceOverrides?: {
    chat?: string;
    analysis?: string;
  };
  /**
   * Eve provider routing policy (Brain-side model/provider selection).
   * Kept separate from Synap internal intelligence service routing.
   */
  eveProviderRouting?: EveProviderRoutingPolicy;

  /**
   * Workspace-level agent routing: "this kind of task/event → this agent".
   * Resolved by resolveAgentForTask() in @synap/intelligence-client. Decouples
   * automation from any single runtime (Hermes becomes one registered target).
   */
  agentRouting?: AgentRoutingPolicy;

  // Validation Policy Overrides
  // Allows workspace owners to customize which operations require validation
  // Overrides GLOBAL_VALIDATION_DEFAULTS from ValidationPolicyService
  validationRules?: {
    [tableName: string]: {
      create?: boolean; // true = require validation, false = fast-path
      update?: boolean;
      delete?: boolean;
    };
  };

  // Role-Based Permissions (Fine-grained RBAC)
  // Allows workspace owners to customize permissions per role per table
  rolePermissions?: {
    [role: string]: {
      // 'owner' | 'admin' | 'editor' | 'viewer'
      [tableName: string]: {
        create?: boolean;
        read?: boolean;
        update?: boolean;
        delete?: boolean;
      };
    };
  };

  // ─── Developer / SDK access ──────────────────────────────────────────────────
  /**
   * Origins that are allowed to make cross-origin requests to this pod via the SDK.
   * Merged with ALLOWED_ORIGINS env var at runtime.
   * Example: ["https://myapp.example.com", "http://localhost:3000"]
   */
  corsAllowedOrigins?: string[];

  // ─── Template / Package provenance ──────────────────────────────────────────
  /** Name of the template used to seed this workspace. When set, workspace-init skips default views. */
  templateName?: string;
  /**
   * ID of the template used to create this workspace (from control plane registry).
   * Distinct from packageSlug — a package can have multiple template versions.
   */
  templateId?: string;
  /** Slug of the control plane package used to create this workspace. */
  packageSlug?: string;
  /**
   * System-reserved slug identifying built-in workspaces created by the backend.
   * Used for idempotent re-creation (e.g. 'pod-admin').
   * Never set by users.
   */
  systemSlug?: string;
  /** Version of the package at time of creation. */
  packageVersion?: string;
  /**
   * Caller-supplied proposal id used for idempotency on workspace-from-definition
   * creation paths (Hub Protocol REST `/workspaces/from-definition`). When set,
   * subsequent calls with the same `proposalId` for the same user return the
   * existing workspace instead of creating a new one.
   *
   * Distinct from `packageSlug` (which keys idempotency in the tRPC path) —
   * external callers (Eve, Coder) generate `proposalId` themselves from a
   * stable template id (e.g. "builder-workspace-v1") so retries are safe even
   * when no CP package is involved.
   */
  proposalId?: string;
  /**
   * App that owns this workspace (e.g. "crm", "studio", "canvas", "devplane").
   * Stamped at creation time via `createFromDefinition`. Used by `workspaces.list`
   * to filter workspaces to the calling app's own set.
   */
  appId?: string;

  // ─── Installed Packs ─────────────────────────────────────────────────────────
  /**
   * Profile packs, view packs, and bento templates installed into this workspace.
   * Populated by the browser when installing from the CP package registry.
   * Used to show "Installed" badges and prevent re-installation.
   */
  installedPacks?: Array<{
    slug: string;
    version: string;
    installedAt: string;
  }>;

  // ─── Provenance & provisioning status ────────────────────────────────────────
  /** Who/what created this workspace: user, control-plane provisioning, or plugin seed */
  createdBy?: "user" | "provisioning" | "plugin";
  /** ISO timestamp when provisioning started (set immediately on workspace creation) */
  provisionedAt?: string;
  /** ISO timestamp when provisioning started */
  provisioningStartedAt?: string;
  /**
   * Current provisioning status.
   * - "pending" — workspace row exists but provisioning is in progress (or failed)
   * - "active"  — fully provisioned and ready to use
   * - "failed"  — provisioning stopped at a step (see failedStep + completedSteps)
   */
  provisioningStatus?: "pending" | "active" | "failed";
  /**
   * The step at which provisioning failed.
   * Only set when provisioningStatus === "failed".
   * Format: step-key (e.g. "profiles[company].create", "views[Home]", "entities")
   */
  failedStep?: string;
  /**
   * Human-readable error message from the failed step (truncated to 500 chars).
   * Only set when provisioningStatus === "failed".
   */
  failedStepError?: string;
  /**
   * Step keys that completed successfully before the failure.
   * Populated in order: ["workspace", "member", "profiles", "relations", "templates",
   *   "views", "bento", "home", "entities", "flows", "relations-seed", "done"]
   * Lets callers know how far provisioning progressed for debugging / partial retry.
   */
  completedSteps?: string[];

  // ─── Agent Workspace Pair ────────────────────────────────────────────────────
  /**
   * Semantic type of this workspace within the pod.
   * - "personal"     — the user's curated space (default)
   * - "agent"        — the AI's staging area (drafts, research, branch outputs)
   * - "project"      — scoped context for a specific project
   * - "operational"  — system/admin workspace (e.g. pod-admin)
   */
  workspaceType?: "personal" | "agent" | "project" | "operational";

  /**
   * For agent workspaces: the userId (userType="agent") that owns this workspace.
   * Enables the intelligence service to know which staging area belongs to which agent.
   */
  linkedAgentId?: string;

  /**
   * Workspace governance mode.
   * - "standard"    — default: workspace owner has full control.
   * - "agent-owned" — the AI agent is workspace owner (creative authority);
   *                   the human is admin (irreversibility guard).
   *                   All destructive actions by the agent require a proposal
   *                   even if the agent holds the owner role.
   */
  governanceMode?: "standard" | "agent-owned";

  // ─── Per-workspace package enabled/disabled state ────────────────────────────
  /**
   * Package enabled overrides for this workspace.
   * Maps SynapPackage id → enabled boolean.
   * Only entries that differ from the package's `defaultEnabled` flag are stored.
   * When absent for a package, the package's own default applies.
   *
   * Example: { "synap.proposals": false, "synap.ai-chat": true }
   */
  enabledPackages?: Record<string, boolean>;

  // ─── Proactive AI Preferences ─────────────────────────────────────────────
  /**
   * Proactive AI intelligence preferences (morning briefings, weekly digests, nudges).
   * Controls when and how the AI proactively posts messages to the user's personal channel.
   */
  proactiveAi?: ProactiveAiPreferences;

  // ─── Signal Delivery Preferences ─────────────────────────────────────────
  /**
   * Controls where AI signals are delivered for each domain.
   * When absent, system defaults apply (see DEFAULT_DELIVERY_RULES in delivery-router.ts).
   *
   * Example: route proactive messages to both feed AND notification bell:
   *   { proactive: { surfaces: ['feed', 'notification'] } }
   */
  deliveryPreferences?: DeliveryPreferences;

  // AI Governance Settings
  aiGovernance?: {
    /**
     * Whitelist of event keys that AI agents may execute WITHOUT a proposal.
     * Everything else defaults to proposal-required.
     *
     * Format: "<subjectType>.<action>" or "<subjectType>.*" glob.
     * Default (when field absent): ["search.*", "memory.recall", "entity.read", "document.read"]
     *
     * Examples:
     *   "entity.read"    — agents can read entities without proposal
     *   "search.*"       — all search operations bypass proposal
     *   "entity.create"  — agents can create entities without proposal (high trust)
     */
    autoApproveFor?: string[];
    /** @deprecated Use autoApproveFor instead. Kept for migration reference only. */
    requireReviewFor?: string[];
    /** @deprecated Use autoApproveFor instead. */
    autoApprove?: boolean;
    maxAgentsPerUser?: number; // Limit AI agents per user
    allowAgentCreation?: boolean; // Allow users to create custom agents
    /** When true, any workspace member can create their own twin agent without admin approval. Default: false */
    allowSelfServiceTwin?: boolean;
    /** Who can approve AI proposals. Default: "owner_and_admins" */
    proposalApprovalPolicy?: "owner_and_admins" | "any_editor" | "admins_only";
    /**
     * Controls whether AI navigation commands (e.g. [[open:side|view:UUID]])
     * execute automatically or require user confirmation.
     */
    navigationPermissions?: {
      /** When true, AI-suggested panel/surface opens happen immediately without confirmation. */
      autoApprove: boolean;
      /**
       * Resource types the AI is allowed to suggest opening.
       * All types are allowed by default when this field is absent.
       */
      allowedResourceTypes?: Array<
        "entity" | "view" | "doc" | "cell" | "channel" | "automation"
      >;
    };
  };

  // ─── DevPlane settings ───────────────────────────────────────────────────────
  /** Settings for the DevPlane app embedded in this workspace */
  devplane?: {
    /**
     * Allow DevPlane to open a local PTY terminal in the browser.
     * Only safe when the pod is running on a trusted local machine.
     * Disabled by default.
     */
    localTerminalEnabled?: boolean;
  };
}

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),

  // Ownership
  ownerId: text("owner_id").notNull(),

  // Metadata
  name: text("name").notNull(),
  description: text("description"),
  type: text("type").default("personal").notNull(), // 'personal' | 'team' | 'enterprise'

  // Settings (JSONB for flexibility)
  settings: jsonb("settings").$type<WorkspaceSettings>().default({}).notNull(),
  // {
  //   defaultEntityTypes: ['note', 'task'],
  //   theme: 'light',
  //   aiEnabled: true,
  //   allowExternalSharing: false
  // }

  // Hot settings keys promoted to real indexed columns (migration 0039) for fast
  // lookups (pod-admin resolver) + provisioning idempotency. settings JSONB is
  // still dual-written for back-compat; query predicates use these columns.
  systemSlug: text("system_slug"),
  packageSlug: text("package_slug"),
  provisioningProposalId: text("provisioning_proposal_id"),
  provisioningStatus: text("provisioning_status"),
  // Promoted from settings JSONB (migration 0042) for indexed lookup of agent workspaces.
  workspaceType: text("workspace_type").notNull().default("personal"),

  // Billing (optional - for managed hosting)
  subscriptionTier: text("subscription_tier"), // 'solo', 'pro', 'team', 'enterprise'
  subscriptionStatus: text("subscription_status"), // 'active', 'canceled', 'past_due', 'trialing'
  stripeCustomerId: text("stripe_customer_id"),

  // Timestamps
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  // Soft-archive: when set, the workspace is hidden from default list queries.
  // Restore by setting back to NULL. Added in migration 0020.
  archivedAt: timestamp("archived_at", { mode: "date", withTimezone: true }),
});

export const workspaceMembers = pgTable("workspace_members", {
  id: uuid("id").defaultRandom().primaryKey(),

  // References
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),
  userId: text("user_id").notNull(),

  // Role-based access
  role: text("role").notNull(), // 'owner' | 'admin' | 'editor' | 'viewer'

  // Metadata
  joinedAt: timestamp("joined_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  invitedBy: text("invited_by"), // userId of inviter
});

export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),

  // Type: 'workspace' (scoped to one workspace) | 'pod' (all workspaces)
  type: text("type").notNull().$type<"workspace" | "pod">(),

  // Only set for workspace invites
  workspaceId: uuid("workspace_id").references(() => workspaces.id, {
    onDelete: "cascade",
  }),

  // Invite details
  email: text("email").notNull(),
  role: text("role").notNull(), // 'admin' | 'editor' | 'viewer'
  token: text("token").notNull().unique(),

  // Metadata
  invitedBy: text("invited_by").notNull(), // userId
  expiresAt: timestamp("expires_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Relations
export const workspacesRelations = relations(workspaces, ({ many }) => ({
  members: many(workspaceMembers),
  invites: many(invites),
}));

export const workspaceMembersRelations = relations(
  workspaceMembers,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceMembers.workspaceId],
      references: [workspaces.id],
    }),
    user: one(users, {
      fields: [workspaceMembers.userId],
      references: [users.id],
    }),
  })
);

export const invitesRelations = relations(invites, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [invites.workspaceId],
    references: [workspaces.id],
  }),
}));

// Type exports
// Generate Zod schemas (Single Source of Truth)
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// Workspaces
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertWorkspaceSchema = createInsertSchema(workspaces);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectWorkspaceSchema = createSelectSchema(workspaces);

// Members
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertWorkspaceMemberSchema = createInsertSchema(workspaceMembers);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectWorkspaceMemberSchema = createSelectSchema(workspaceMembers);

// Invites (unified — workspace + pod)
export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
// Backward-compat aliases (workspaceInvites table was renamed to invites in 0058)
export type WorkspaceInvite = Invite;
export type NewWorkspaceInvite = NewInvite;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertInviteSchema = createInsertSchema(invites);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectInviteSchema = createSelectSchema(invites);
