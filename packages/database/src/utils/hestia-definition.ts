/**
 * Hestia Workspace Definition
 *
 * Workspace template for sovereign infrastructure management.
 * Used with createFromDefinition to set up a Hestia admin workspace.
 *
 * This is a workspace-scoped definition - profiles are created per-workspace
 * and entities are only visible within this workspace.
 */

import type { WorkspaceDefinitionInput } from "./create-workspace-from-definition.js";

export const HESTIA_DEFINITION: WorkspaceDefinitionInput = {
  workspaceName: "Hestia Infrastructure",
  description: "Sovereign AI infrastructure management console",

  // Workspace-scoped profiles for infrastructure management
  profiles: [
    {
      slug: "hearth_node",
      displayName: "Hearth Node",
      icon: "flame",
      color: "#F97316",
      description: "Sovereign infrastructure node (server, VM, or device)",
      scope: "WORKSPACE",
      properties: [
        {
          slug: "hostname",
          label: "Hostname",
          valueType: "STRING",
          inputType: "text",
        },
        {
          slug: "ip_address",
          label: "IP Address",
          valueType: "STRING",
          inputType: "text",
        },
        {
          slug: "role",
          label: "Role",
          valueType: "STRING",
          inputType: "select",
          enumValues: ["primary", "backup", "edge"],
        },
        {
          slug: "install_mode",
          label: "Install Mode",
          valueType: "STRING",
          inputType: "select",
          enumValues: ["usb", "script"],
        },
        {
          slug: "health_status",
          label: "Health Status",
          valueType: "STRING",
          inputType: "select",
          enumValues: ["healthy", "degraded", "offline"],
        },
        {
          slug: "last_heartbeat",
          label: "Last Heartbeat",
          valueType: "DATE",
          inputType: "datetime",
        },
        {
          slug: "intelligence_provider_id",
          label: "Intelligence Provider",
          valueType: "ENTITY_REF",
          inputType: "entity-select",
        },
      ],
    },
    {
      slug: "intelligence_provider",
      displayName: "Intelligence Provider",
      icon: "brain",
      color: "#8B5CF6",
      description: "AI intelligence provider configuration",
      scope: "WORKSPACE",
      properties: [
        {
          slug: "provider_type",
          label: "Provider Type",
          valueType: "STRING",
          inputType: "select",
          enumValues: ["ollama", "openrouter", "anthropic", "openai", "custom"],
        },
        {
          slug: "endpoint_url",
          label: "Endpoint URL",
          valueType: "STRING",
          inputType: "url",
        },
        {
          slug: "api_key_env",
          label: "API Key Environment Variable",
          valueType: "STRING",
          inputType: "text",
        },
        {
          slug: "model",
          label: "Model",
          valueType: "STRING",
          inputType: "text",
        },
        {
          slug: "status",
          label: "Status",
          valueType: "STRING",
          inputType: "select",
          enumValues: ["active", "inactive", "error"],
        },
        {
          slug: "capabilities",
          label: "Capabilities",
          valueType: "JSON",
          inputType: "json",
        },
      ],
    },
    {
      slug: "package_instance",
      displayName: "Package Instance",
      icon: "package",
      color: "#3B82F6",
      description: "Installed package on a hearth node",
      scope: "WORKSPACE",
      properties: [
        {
          slug: "package_name",
          label: "Package Name",
          valueType: "STRING",
          inputType: "text",
        },
        {
          slug: "version",
          label: "Version",
          valueType: "STRING",
          inputType: "text",
        },
        {
          slug: "status",
          label: "Status",
          valueType: "STRING",
          inputType: "select",
          enumValues: ["installed", "running", "stopped", "error", "updating"],
        },
        {
          slug: "hearth_node_id",
          label: "Hearth Node",
          valueType: "ENTITY_REF",
          inputType: "entity-select",
        },
        {
          slug: "config",
          label: "Configuration",
          valueType: "JSON",
          inputType: "json",
        },
        {
          slug: "installed_at",
          label: "Installed At",
          valueType: "DATE",
          inputType: "datetime",
        },
        {
          slug: "last_updated",
          label: "Last Updated",
          valueType: "DATE",
          inputType: "datetime",
        },
      ],
    },
    {
      slug: "hearth_deployment",
      displayName: "Deployment",
      icon: "rocket",
      color: "#10B981",
      description: "Deployed artifact or application",
      scope: "WORKSPACE",
      properties: [
        {
          slug: "artifact_type",
          label: "Artifact Type",
          valueType: "STRING",
          inputType: "select",
          enumValues: ["static", "containerized"],
        },
        {
          slug: "source_type",
          label: "Source Type",
          valueType: "STRING",
          inputType: "select",
          enumValues: ["git", "workspace", "upload"],
        },
        {
          slug: "source_url",
          label: "Source URL",
          valueType: "STRING",
          inputType: "url",
        },
        {
          slug: "status",
          label: "Status",
          valueType: "STRING",
          inputType: "select",
          enumValues: ["pending", "building", "deployed", "failed"],
        },
        {
          slug: "deploy_url",
          label: "Deploy URL",
          valueType: "STRING",
          inputType: "url",
        },
        {
          slug: "hearth_node_id",
          label: "Hearth Node",
          valueType: "ENTITY_REF",
          inputType: "entity-select",
        },
      ],
    },
    {
      slug: "intelligence_query_log",
      displayName: "Query Log",
      icon: "clipboard-list",
      color: "#6B7280",
      description: "Log of intelligence provider queries",
      hideFromCreate: true,
      scope: "WORKSPACE",
      properties: [
        {
          slug: "hearth_node_id",
          label: "Hearth Node",
          valueType: "ENTITY_REF",
          inputType: "entity-select",
        },
        {
          slug: "provider_type",
          label: "Provider Type",
          valueType: "STRING",
          inputType: "select",
          enumValues: ["ollama", "openrouter", "anthropic", "openai", "custom"],
        },
        {
          slug: "model",
          label: "Model",
          valueType: "STRING",
          inputType: "text",
        },
        {
          slug: "prompt_tokens",
          label: "Prompt Tokens",
          valueType: "NUMBER",
          inputType: "number",
        },
        {
          slug: "completion_tokens",
          label: "Completion Tokens",
          valueType: "NUMBER",
          inputType: "number",
        },
        {
          slug: "query_time",
          label: "Query Time",
          valueType: "DATE",
          inputType: "datetime",
        },
      ],
    },
  ],

  // Views for infrastructure management
  views: [
    {
      name: "Hearth Nodes",
      displayName: "Hearth Nodes",
      type: "table",
      scopeProfileSlug: "hearth_node",
      config: {
        columns: [
          "title",
          "hostname",
          "ip_address",
          "role",
          "health_status",
          "last_heartbeat",
        ],
        sortBy: "last_heartbeat",
        sortDir: "desc",
      },
    },
    {
      name: "Infrastructure Map",
      displayName: "Infrastructure Map",
      type: "graph",
      scopeProfileSlugs: [
        "hearth_node",
        "package_instance",
        "intelligence_provider",
      ],
      config: {
        layout: "force",
        showLabels: true,
      },
    },
    {
      name: "Package Status",
      displayName: "Package Status",
      type: "kanban",
      scopeProfileSlug: "package_instance",
      config: {
        groupBy: "status",
        columns: ["installed", "running", "stopped", "error", "updating"],
      },
    },
    {
      name: "Deployments",
      displayName: "Deployments",
      type: "kanban",
      scopeProfileSlug: "hearth_deployment",
      config: {
        groupBy: "status",
        columns: ["pending", "building", "deployed", "failed"],
      },
    },
    {
      name: "Intelligence Providers",
      displayName: "Intelligence Providers",
      type: "table",
      scopeProfileSlug: "intelligence_provider",
      config: {
        columns: ["title", "provider_type", "model", "status"],
        sortBy: "status",
        sortDir: "asc",
      },
    },
  ],

  // Entity links (relations between infrastructure components)
  entityLinks: [
    {
      sourceProfileSlug: "hearth_node",
      targetProfileSlug: "intelligence_provider",
      type: "uses_provider",
      label: "Uses Provider",
    },
    {
      sourceProfileSlug: "package_instance",
      targetProfileSlug: "hearth_node",
      type: "installed_on",
      label: "Installed On",
    },
    {
      sourceProfileSlug: "hearth_deployment",
      targetProfileSlug: "hearth_node",
      type: "deployed_to",
      label: "Deployed To",
    },
  ],

  // Bento dashboard layout
  bentoLayout: [
    // Row 1: Stats
    {
      widgetType: "stat-card",
      pos: { x: 0, y: 0, w: 3, h: 3 },
      config: {
        label: "Hearth Nodes",
        aggregation: "count",
        profileSlug: "hearth_node",
        icon: "Flame",
      },
    },
    {
      widgetType: "stat-card",
      pos: { x: 3, y: 0, w: 3, h: 3 },
      config: {
        label: "Active Providers",
        aggregation: "count",
        profileSlug: "intelligence_provider",
        icon: "Brain",
        filter: { status: "active" },
      },
    },
    {
      widgetType: "stat-card",
      pos: { x: 6, y: 0, w: 3, h: 3 },
      config: {
        label: "Running Packages",
        aggregation: "count",
        profileSlug: "package_instance",
        icon: "Package",
        filter: { status: "running" },
      },
    },
    {
      widgetType: "stat-card",
      pos: { x: 9, y: 0, w: 3, h: 3 },
      config: {
        label: "Active Deployments",
        aggregation: "count",
        profileSlug: "hearth_deployment",
        icon: "Rocket",
        filter: { status: "deployed" },
      },
    },
    // Row 2: Node status + packages
    {
      widgetType: "entity-list",
      pos: { x: 0, y: 3, w: 6, h: 6 },
      config: {
        title: "Hearth Nodes Status",
        profileSlug: "hearth_node",
        columns: ["hostname", "health_status", "last_heartbeat"],
        limit: 5,
      },
    },
    {
      widgetType: "entity-gallery",
      pos: { x: 6, y: 3, w: 6, h: 6 },
      config: {
        title: "Recent Deployments",
        profileSlug: "hearth_deployment",
        limit: 4,
      },
    },
    // Row 3: Intelligence + system health
    {
      widgetType: "entity-list",
      pos: { x: 0, y: 9, w: 6, h: 6 },
      config: {
        title: "Intelligence Providers",
        profileSlug: "intelligence_provider",
        columns: ["provider_type", "model", "status"],
        limit: 5,
      },
    },
    {
      widgetType: "feed",
      pos: { x: 6, y: 9, w: 6, h: 6 },
      config: {
        title: "Infrastructure Activity",
        limit: 10,
      },
    },
  ],

  // Layout config for sidebar/navigation
  layoutConfig: {
    pinnedApps: ["dashboard", "chat", "data"],
    defaultApp: "dashboard",
    sidebarItems: [
      { kind: "app" as const, appId: "dashboard", label: "Home" },
      { kind: "app" as const, appId: "chat", label: "AI Chat" },
      {
        kind: "view" as const,
        viewName: "Hearth Nodes",
        label: "Nodes",
        icon: "flame",
      },
      {
        kind: "view" as const,
        viewName: "Package Status",
        label: "Packages",
        icon: "package",
      },
      {
        kind: "view" as const,
        viewName: "Deployments",
        label: "Deployments",
        icon: "rocket",
      },
      {
        kind: "view" as const,
        viewName: "Intelligence Providers",
        label: "AI Providers",
        icon: "brain",
      },
      {
        kind: "view" as const,
        viewName: "Infrastructure Map",
        label: "Map",
        icon: "map",
      },
    ],
  },
} as const;

export default HESTIA_DEFINITION;
