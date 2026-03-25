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
];

// Fast lookup map (built once at module init)
export const NOTIFICATION_REGISTRY_MAP = new Map<string, NotificationDef>(
  NOTIFICATION_REGISTRY.map((def) => [def.type, def])
);

export function getNotificationDef(type: string): NotificationDef | undefined {
  return NOTIFICATION_REGISTRY_MAP.get(type);
}
