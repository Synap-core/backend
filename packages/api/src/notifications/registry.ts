/**
 * Notification Type Registry
 *
 * Maps notification type keys to their definition.
 * Adding a new notification type = add one entry here. Zero code.
 *
 * Templates support simple {{variable}} interpolation.
 * Variables come from the `data` object passed to NotificationService.create().
 */

export type DeliveryChannel = "in_app" | "os" | "telegram" | "email_digest";

export interface NotificationActionDef {
  id: string;
  label: string;
  variant: "primary" | "secondary" | "destructive";
  handler:
    | { type: "navigate"; app: string; params?: Record<string, unknown> }
    | { type: "mutation"; procedure: string; inputKey?: string };
}

export interface NotificationDef {
  type: string;
  category: "governance" | "data" | "ai" | "system" | "inbox";
  label: string;
  icon: string; // lucide icon name
  priority: "low" | "normal" | "high" | "urgent";
  /** Mustache-style template: {{variable}} */
  titleTemplate: string;
  bodyTemplate: string;
  /** Default delivery channels (user prefs can override) */
  defaultChannels: DeliveryChannel[];
  /** Inline action buttons */
  actions?: NotificationActionDef[];
  /** Auto-dismiss after ms. 0 = persistent. */
  ttl?: number;
  /** Group notifications sharing the same resolved groupBy field */
  groupBy?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const NOTIFICATION_REGISTRY: NotificationDef[] = [
  // ── Governance ────────────────────────────────────────────────────────────
  {
    type: "proposal.created",
    category: "governance",
    label: "AI Proposal",
    icon: "bot",
    priority: "high",
    titleTemplate: "Review: {{proposalType}}",
    bodyTemplate: "{{description}}",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "approve",
        label: "Approve",
        variant: "primary",
        handler: {
          type: "mutation",
          procedure: "proposals.approve",
          inputKey: "proposalId",
        },
      },
      {
        id: "reject",
        label: "Reject",
        variant: "destructive",
        handler: {
          type: "mutation",
          procedure: "proposals.reject",
          inputKey: "proposalId",
        },
      },
    ],
    ttl: 0,
    groupBy: "agentUserId",
  },
  {
    type: "proposal.auto_approved",
    category: "governance",
    label: "Auto-Approved Action",
    icon: "check-circle",
    priority: "low",
    titleTemplate: "Auto-approved: {{proposalType}}",
    bodyTemplate: "{{description}}",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },
  {
    // Proactive twin of the approve-time preflight: a pending proposal whose
    // target workspace the owner can no longer reach will FAIL on approve. Surface
    // it before they try. Hygiene, not blocking → `normal` (reserve high/urgent for
    // live approvals + auth-expired). Deduped per workspace+reason via groupBy.
    type: "governance.proposal_stale",
    category: "governance",
    label: "Stale Proposal",
    icon: "clock-alert",
    priority: "normal",
    titleTemplate: "Can't be approved: {{proposalType}}",
    bodyTemplate: "Its {{reason}} — withdraw it or re-run fresh.",
    defaultChannels: ["in_app"],
    actions: [
      {
        id: "withdraw",
        label: "Withdraw",
        variant: "destructive",
        handler: {
          type: "mutation",
          procedure: "proposals.reject",
          inputKey: "proposalId",
        },
      },
    ],
    ttl: 0,
    groupBy: "reason",
  },
  {
    type: "ai_request.vault_access",
    category: "governance",
    label: "Vault Access Request",
    icon: "shield",
    priority: "urgent",
    titleTemplate: "AI needs {{secretType}} for {{service}}",
    bodyTemplate: "{{purpose}}",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "open_vault",
        label: "Open Vault",
        variant: "primary",
        handler: { type: "navigate", app: "vault" },
      },
      {
        id: "deny",
        label: "Deny",
        variant: "destructive",
        handler: {
          type: "mutation",
          procedure: "proposals.reject",
          inputKey: "proposalId",
        },
      },
    ],
    ttl: 0,
  },
  {
    type: "ai_request.terminal_exec",
    category: "governance",
    label: "Terminal Command Request",
    icon: "terminal",
    priority: "urgent",
    titleTemplate: "AI wants to run: {{command}}",
    bodyTemplate: "In: {{cwd}}",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "allow",
        label: "Allow",
        variant: "primary",
        handler: {
          type: "mutation",
          procedure: "proposals.approve",
          inputKey: "proposalId",
        },
      },
      {
        id: "deny",
        label: "Deny",
        variant: "destructive",
        handler: {
          type: "mutation",
          procedure: "proposals.reject",
          inputKey: "proposalId",
        },
      },
    ],
    ttl: 0,
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  {
    type: "connector.sync.complete",
    category: "data",
    label: "Connector Sync Complete",
    icon: "refresh-cw",
    priority: "normal",
    titleTemplate: "{{connectorName}} sync complete",
    bodyTemplate: "{{itemCount}} items imported",
    defaultChannels: ["in_app"],
    ttl: 6_000,
  },
  {
    type: "connector.sync.failed",
    category: "data",
    label: "Connector Sync Failed",
    icon: "alert-circle",
    priority: "high",
    titleTemplate: "{{connectorName}} sync failed",
    bodyTemplate: "{{errorMessage}}",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "settings",
        label: "Check Settings",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "settings",
          params: { tab: "connectors" },
        },
      },
    ],
    ttl: 0,
  },
  {
    type: "connector.auth.expired",
    category: "data",
    label: "Connector Auth Expired",
    icon: "key",
    priority: "high",
    titleTemplate: "{{connectorName}} needs re-authorization",
    bodyTemplate: "Your connection expired. Reconnect to resume syncing.",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "reconnect",
        label: "Reconnect",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "settings",
          params: { tab: "connectors" },
        },
      },
    ],
    ttl: 0,
  },
  {
    type: "entity.created_by_ai",
    category: "data",
    label: "AI Created Entity",
    icon: "sparkles",
    priority: "low",
    titleTemplate: "{{agentName}} created {{entityType}}",
    bodyTemplate: "{{entityTitle}}",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },

  // ── AI ────────────────────────────────────────────────────────────────────
  {
    type: "skill.triggered",
    category: "ai",
    label: "Skill Activated",
    icon: "zap",
    priority: "normal",
    titleTemplate: "Skill triggered: {{skillName}}",
    bodyTemplate: "{{description}}",
    defaultChannels: ["in_app"],
    ttl: 4_000,
  },
  {
    type: "agent.task_complete",
    category: "ai",
    label: "Agent Task Complete",
    icon: "check",
    priority: "normal",
    titleTemplate: "{{agentName}} finished a task",
    bodyTemplate: "{{summary}}",
    defaultChannels: ["in_app"],
    ttl: 6_000,
    actions: [
      {
        id: "view",
        label: "View",
        variant: "primary",
        handler: { type: "navigate", app: "chat" },
      },
    ],
  },
  {
    type: "agent.task_failed",
    category: "ai",
    label: "Agent Task Failed",
    icon: "alert-triangle",
    priority: "high",
    titleTemplate: "{{agentName}} encountered an error",
    bodyTemplate: "{{errorMessage}}",
    defaultChannels: ["in_app", "os"],
    // Group repeated failures of the same agent in the bell. The B2 producer
    // (events.ts) additionally passes an explicit agentUserId-keyed groupKey and
    // a cooldown gate — this declares the fallback grouping for any other caller.
    groupBy: "agentName",
    ttl: 0,
    actions: [
      {
        id: "view",
        label: "View",
        variant: "primary",
        handler: { type: "navigate", app: "chat" },
      },
    ],
  },
  {
    type: "agent.insight",
    category: "ai",
    label: "AI Insight",
    icon: "lightbulb",
    priority: "normal",
    titleTemplate: "{{agentName}}: {{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    // An automation the system flipped to status='error' has silently stopped
    // running — surface it so the user can fix/re-enable it (absence-is-invisible
    // otherwise). High (a dead automation means work isn't happening). Deduped per
    // automation via groupBy so a persistently-broken one collapses to one row.
    type: "automation.broken",
    category: "system",
    label: "Automation Broken",
    icon: "alert-octagon",
    priority: "high",
    titleTemplate: "Automation stopped: {{automationName}}",
    bodyTemplate: "{{errorMessage}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    groupBy: "automationId",
  },

  // ── Data: Entity Lifecycle ──────────────────────────────────────────────
  {
    type: "data.entity.deleted",
    category: "data",
    label: "Entity Deleted",
    icon: "trash-2",
    priority: "normal",
    titleTemplate: "Entity deleted: {{entityName}}",
    bodyTemplate: "{{entityType}} was removed",
    defaultChannels: ["in_app"],
    ttl: 6_000,
  },
  {
    type: "data.document.created",
    category: "data",
    label: "Document Created",
    icon: "file-text",
    priority: "low",
    titleTemplate: "New document: {{title}}",
    bodyTemplate: "{{description}}",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },
  {
    type: "data.view.created",
    category: "data",
    label: "View Created",
    icon: "layout-grid",
    priority: "low",
    titleTemplate: "New view: {{title}}",
    bodyTemplate: "{{viewType}} view created",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },
  {
    type: "data.relation.created",
    category: "data",
    label: "Relation Created",
    icon: "link",
    priority: "low",
    titleTemplate: "New relation: {{sourceTitle}} → {{targetTitle}}",
    bodyTemplate: "{{relationType}}",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },

  // ── AI: Proactive Messages ──────────────────────────────────────────────
  {
    type: "ai.proactive.morning_briefing",
    category: "ai",
    label: "Morning Briefing",
    icon: "sunrise",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "ai.proactive.weekly_digest",
    category: "ai",
    label: "Weekly Digest",
    icon: "calendar-range",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "ai.proactive.health_check",
    category: "ai",
    label: "Health Check",
    icon: "heart-pulse",
    priority: "low",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "ai.proactive.insight",
    category: "ai",
    label: "AI Insight",
    icon: "lightbulb",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "ai.proactive.nudge",
    category: "ai",
    label: "AI Nudge",
    icon: "sparkles",
    priority: "low",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },

  // ── System ────────────────────────────────────────────────────────────────
  {
    type: "pod.update_available",
    category: "system",
    label: "Update Available",
    icon: "download",
    priority: "normal",
    titleTemplate: "Synap {{version}} is available",
    bodyTemplate: "Update when you're ready.",
    defaultChannels: ["in_app"],
    ttl: 0,
    actions: [
      {
        id: "update",
        label: "Update Now",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "settings",
          params: { tab: "updates" },
        },
      },
    ],
  },
  {
    type: "system.capability_update_available",
    category: "system",
    label: "Capability Updates Available",
    icon: "package",
    priority: "normal",
    // `count` + `names` come from the boot reconcile report (the caller). One
    // grouped bell item — never one-per-drifted-capability.
    titleTemplate: "{{count}} capability updates available",
    bodyTemplate: "Updated templates are ready to apply: {{names}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    actions: [
      {
        id: "review",
        label: "Review",
        variant: "primary",
        // Apply lives on the capabilities surface (tRPC applyUpdates), not here.
        handler: { type: "navigate", app: "capabilities" },
      },
    ],
  },
  {
    type: "pod.storage_warning",
    category: "system",
    label: "Storage Warning",
    icon: "hard-drive",
    priority: "high",
    titleTemplate: "Storage at {{percent}}% capacity",
    bodyTemplate: "Consider archiving or cleaning up unused data.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
  },
  {
    type: "system.issuer_pending_approval",
    category: "system",
    label: "Issuer Pending Approval",
    icon: "shield-alert",
    priority: "high",
    titleTemplate: "New external issuer needs approval",
    bodyTemplate: "{{displayName}} ({{issuerUrl}}) requested pod access.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
  },
  {
    type: "workspace.invite",
    category: "system",
    label: "Workspace Invite",
    icon: "users",
    priority: "high",
    titleTemplate: "You've been invited to {{workspaceName}}",
    bodyTemplate: "by {{inviterName}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    actions: [
      {
        id: "accept",
        label: "Accept",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "settings",
          params: { tab: "workspaces" },
        },
      },
    ],
  },

  // ── Inbox ─────────────────────────────────────────────────────────────────
  {
    type: "inbox.email",
    category: "inbox",
    label: "New Email",
    icon: "mail",
    priority: "normal",
    titleTemplate: "{{subject}}",
    bodyTemplate: "From: {{sender}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "inbox.mention",
    category: "inbox",
    label: "Mention",
    icon: "at-sign",
    priority: "high",
    titleTemplate: "{{sender}} mentioned you",
    bodyTemplate: "{{preview}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
  },
  {
    type: "inbox.priority_item",
    category: "inbox",
    label: "Priority Item",
    icon: "star",
    priority: "high",
    titleTemplate: "{{subject}}",
    bodyTemplate: "AI scored this as high priority",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    // A HUMAN @mentioned another human in a channel/room. Distinct from
    // `inbox.mention` (imported inbox items) and from agent @handles (which route
    // to an AI, never notify a person). Clicking opens the channel in chat.
    type: "chat.mention",
    category: "inbox",
    label: "Mention",
    icon: "at-sign",
    priority: "high",
    titleTemplate: "{{sender}} mentioned you",
    bodyTemplate: "{{preview}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    actions: [
      {
        id: "view",
        label: "View",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "chat",
          params: { channelId: "{{channelId}}" },
        },
      },
    ],
  },
];

// Fast lookup map (built once at module init)
export const NOTIFICATION_REGISTRY_MAP = new Map<string, NotificationDef>(
  NOTIFICATION_REGISTRY.map((def) => [def.type, def])
);

export function getNotificationDef(type: string): NotificationDef | undefined {
  return NOTIFICATION_REGISTRY_MAP.get(type);
}
