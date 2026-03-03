/**
 * Pod Administration Workspace — System Template
 *
 * Auto-created once per data pod for users with admin access.
 * Drives the browser's "data pod" profile sidebar via workspace.settings.layout.
 *
 * The workspace is identified by settings.systemSlug = 'pod-admin' so that
 * ensurePodAdminWorkspace can find it idempotently across reconnections.
 *
 * Sidebar items use __POD_URL__ as a placeholder which the browser resolves
 * to the active pod URL at render time.
 */

import type { WorkspaceDefinitionInput } from "@synap/database";

export const POD_ADMIN_SYSTEM_SLUG = "pod-admin";
export const POD_ADMIN_WORKSPACE_NAME = "Pod Administration";

export const POD_ADMIN_DEFINITION: WorkspaceDefinitionInput = {
  workspaceName: POD_ADMIN_WORKSPACE_NAME,
  description:
    "System workspace for managing your Synap data pod — intelligence services, channels, proposals, and workspaces.",

  // No user-facing profiles on this workspace.
  // Pod-level data (channels, proposals, workspaces) is surfaced through
  // dedicated views scoped to the data pod, not a profile entity type.
  profiles: [],

  views: [
    // Channels across all workspaces — no profile scope = pod-level
    {
      name: "All Channels",
      type: "table",
      config: {
        podLevel: true,
        channelTypes: ["ai_thread", "branch", "direct", "external_import"],
      },
    },
    // Proposals inbox — governance proposals across all workspaces
    {
      name: "Proposals",
      type: "table",
      config: { podLevel: true },
    },
    // Workspace manager — list + member management
    {
      name: "Workspaces",
      type: "table",
      config: { podLevel: true },
    },
  ],

  bentoLayout: [
    // Welcome header with pod name
    {
      widgetType: "welcome-header",
      pos: { x: 0, y: 0, w: 12, h: 2 },
      config: {
        title: "Pod Administration",
        subtitle: "Manage your Synap data pod",
      },
    },
    // Workspace list with member counts
    {
      widgetType: "workspace-list",
      pos: { x: 0, y: 2, w: 6, h: 4 },
      config: {},
    },
    // Intelligence service status
    {
      widgetType: "intelligence-status",
      pos: { x: 6, y: 2, w: 6, h: 4 },
      config: {},
    },
    // Recent proposals requiring attention
    {
      widgetType: "proposals-inbox",
      pos: { x: 0, y: 6, w: 8, h: 3 },
      config: { limit: 5 },
    },
    // API keys quick-access
    {
      widgetType: "api-keys-summary",
      pos: { x: 8, y: 6, w: 4, h: 3 },
      config: {},
    },
  ],

  bentoViewName: "Admin Dashboard",

  layoutConfig: {
    pinnedApps: ["dashboard", "intelligence", "data", "browser"],
    defaultView: "dashboard",
    sidebarItems: [
      // Home dashboard (bento view above)
      { kind: "app", appId: "dashboard", label: "Pod Home", icon: "Home" },
      // Intelligence services management
      {
        kind: "app",
        appId: "intelligence",
        label: "Services",
        icon: "Sparkles",
      },
      // All channels across the pod — opens the Channels browser app
      {
        kind: "app",
        appId: "channels",
        label: "Channels",
        icon: "MessageSquare",
      },
      // Governance proposals — opens the Proposals browser app
      {
        kind: "app",
        appId: "proposals",
        label: "Proposals",
        icon: "Inbox",
      },
      // Workspace manager (data view scoped to workspaces profile)
      {
        kind: "view",
        viewName: "Workspaces",
        label: "Workspaces",
        icon: "Layers",
      },
      // Raw data explorer (pod-level, no workspace filter)
      { kind: "app", appId: "data", label: "Data", icon: "Database" },
      // External link to pod admin panel
      {
        kind: "external",
        url: "__POD_URL__/admin",
        label: "Admin Panel",
        icon: "ExternalLink",
      },
      // Settings (bottom, separated by convention)
      { kind: "app", appId: "settings", label: "Settings", icon: "Settings" },
    ],
  },
};
