/**
 * DevOps Workspace Definition
 *
 * A workspace preset for infrastructure management: servers, deployments,
 * repositories, and credentials. Pairs with Dokploy for actual deployment
 * orchestration — Synap stores the entity graph, Dokploy runs the operations.
 *
 * Usage:
 *   await createWorkspaceFromDefinition({
 *     userId,
 *     definition: DEVOPS_DEFINITION,
 *   });
 *
 * Or via tRPC:
 *   trpc.workspaces.createFromDefinition({ definition: DEVOPS_DEFINITION })
 */

import type { WorkspaceDefinitionInput } from "../utils/create-workspace-from-definition.js";

export const DEVOPS_DEFINITION: WorkspaceDefinitionInput = {
  workspaceName: "Infrastructure",
  description:
    "Servers, deployments, repositories — your full stack at a glance.",

  // ─── Profiles ─────────────────────────────────────────────────────────────
  profiles: [
    {
      slug: "server",
      displayName: "Server",
      icon: "server",
      color: "#6366F1",
      scope: "pod",
      description: "A managed server or VPS instance.",
      properties: [
        {
          slug: "title",
          label: "Name",
          valueType: "string",
          inputType: "text",
        },
        {
          slug: "provider",
          label: "Provider",
          valueType: "string",
          inputType: "select",
          enumValues: ["hetzner", "ovh", "digitalocean", "aws", "gcp", "other"],
        },
        {
          slug: "ip",
          label: "IP Address",
          valueType: "string",
          inputType: "text",
        },
        {
          slug: "region",
          label: "Region",
          valueType: "string",
          inputType: "text",
        },
        { slug: "os", label: "OS", valueType: "string", inputType: "text" },
        {
          slug: "status",
          label: "Status",
          valueType: "string",
          inputType: "select",
          enumValues: ["online", "offline", "provisioning", "maintenance"],
        },
        {
          slug: "dokployServerId",
          label: "Dokploy Server ID",
          valueType: "string",
          inputType: "text",
        },
        {
          slug: "notes",
          label: "Notes",
          valueType: "string",
          inputType: "textarea",
        },
      ],
    },
    {
      slug: "deployment",
      displayName: "Deployment",
      icon: "rocket",
      color: "#10B981",
      scope: "pod",
      description: "A running service on a server.",
      properties: [
        {
          slug: "title",
          label: "Name",
          valueType: "string",
          inputType: "text",
        },
        {
          slug: "env",
          label: "Environment",
          valueType: "string",
          inputType: "select",
          enumValues: ["production", "staging", "preview", "development"],
        },
        {
          slug: "deployStatus",
          label: "Status",
          valueType: "string",
          inputType: "select",
          enumValues: ["running", "stopped", "deploying", "error", "idle"],
        },
        {
          slug: "version",
          label: "Version / Tag",
          valueType: "string",
          inputType: "text",
        },
        {
          slug: "url",
          label: "Public URL",
          valueType: "string",
          inputType: "url",
        },
        {
          slug: "image",
          label: "Docker Image",
          valueType: "string",
          inputType: "text",
        },
        {
          slug: "deployedAt",
          label: "Last Deployed",
          valueType: "date",
          inputType: "datetime-local",
        },
        {
          slug: "dokployAppId",
          label: "Dokploy App ID",
          valueType: "string",
          inputType: "text",
        },
      ],
    },
    {
      slug: "repository",
      displayName: "Repository",
      icon: "git-branch",
      color: "#F59E0B",
      scope: "pod",
      description:
        "A GitHub / GitLab repository linked to one or more deployments.",
      properties: [
        {
          slug: "title",
          label: "Name",
          valueType: "string",
          inputType: "text",
        },
        {
          slug: "url",
          label: "Repository URL",
          valueType: "string",
          inputType: "url",
        },
        {
          slug: "defaultBranch",
          label: "Default Branch",
          valueType: "string",
          inputType: "text",
        },
        {
          slug: "ciStatus",
          label: "CI Status",
          valueType: "string",
          inputType: "select",
          enumValues: ["passing", "failing", "pending", "unknown"],
        },
        {
          slug: "lastCommitSha",
          label: "Last Commit",
          valueType: "string",
          inputType: "text",
        },
        {
          slug: "lastCommitAt",
          label: "Last Commit At",
          valueType: "date",
          inputType: "datetime-local",
        },
        {
          slug: "language",
          label: "Language",
          valueType: "string",
          inputType: "text",
        },
        {
          slug: "isPrivate",
          label: "Private",
          valueType: "boolean",
          inputType: "checkbox",
        },
      ],
    },
    {
      slug: "infra-credential",
      displayName: "Credential",
      icon: "key",
      color: "#EF4444",
      scope: "pod",
      description:
        "An SSH key, API token, or secret linked to servers or services.",
      properties: [
        {
          slug: "title",
          label: "Label",
          valueType: "string",
          inputType: "text",
        },
        {
          slug: "credentialType",
          label: "Type",
          valueType: "string",
          inputType: "select",
          enumValues: [
            "ssh-key",
            "api-key",
            "env-file",
            "certificate",
            "other",
          ],
        },
        {
          slug: "scope",
          label: "Scope",
          valueType: "string",
          inputType: "select",
          enumValues: ["server", "service", "registry", "dns", "billing"],
        },
        {
          slug: "vaultRef",
          label: "Vault Reference",
          valueType: "string",
          inputType: "text",
        },
        {
          slug: "expiresAt",
          label: "Expires At",
          valueType: "date",
          inputType: "date",
        },
        {
          slug: "notes",
          label: "Notes",
          valueType: "string",
          inputType: "textarea",
        },
      ],
    },
  ],

  // ─── Views ────────────────────────────────────────────────────────────────
  views: [
    {
      name: "Fleet",
      type: "kanban",
      scopeProfileSlug: "server",
      groupBy: "status",
      description: "All servers grouped by status.",
      defaultView: true,
    },
    {
      name: "Deployments",
      type: "table",
      scopeProfileSlug: "deployment",
      sortBy: "deployedAt",
      sortOrder: "desc",
      description: "All deployments across all servers.",
    },
    {
      name: "Repositories",
      type: "grid",
      scopeProfileSlug: "repository",
      description: "All repositories with CI status.",
    },
    {
      name: "Credentials",
      type: "table",
      scopeProfileSlug: "infra-credential",
      description: "Credential inventory.",
    },
    {
      name: "All Infrastructure",
      type: "table",
      scopeProfileSlugs: [
        "server",
        "deployment",
        "repository",
        "infra-credential",
      ],
      description: "Everything in one table.",
    },
  ],

  // ─── Bento dashboard ──────────────────────────────────────────────────────
  bentoLayout: [
    // Row 0-1: header
    {
      widgetType: "section-header",
      pos: { x: 0, y: 0, w: 12, h: 2 },
      config: { title: "Infrastructure", icon: "Server", color: "#6366F1" },
    },
    // Row 2-4: stat cards
    {
      widgetType: "stat-card",
      pos: { x: 0, y: 2, w: 3, h: 3 },
      config: {
        label: "Servers",
        aggregation: "count",
        profileSlug: "server",
        icon: "Server",
        color: "#6366F1",
      },
    },
    {
      widgetType: "stat-card",
      pos: { x: 3, y: 2, w: 3, h: 3 },
      config: {
        label: "Deployments",
        aggregation: "count",
        profileSlug: "deployment",
        icon: "Rocket",
        color: "#10B981",
      },
    },
    {
      widgetType: "stat-card",
      pos: { x: 6, y: 2, w: 3, h: 3 },
      config: {
        label: "Repositories",
        aggregation: "count",
        profileSlug: "repository",
        icon: "GitBranch",
        color: "#F59E0B",
      },
    },
    {
      widgetType: "stat-card",
      pos: { x: 9, y: 2, w: 3, h: 3 },
      config: {
        label: "Online Servers",
        aggregation: "count",
        profileSlug: "server",
        filterBy: { status: "online" },
        icon: "CheckCircle",
        color: "#10B981",
      },
    },
    // Row 5-12: server fleet kanban
    {
      widgetType: "view",
      pos: { x: 0, y: 5, w: 12, h: 8 },
      config: { viewName: "Fleet", profileSlug: "server" },
    },
    // Row 13-20: recent deployments
    {
      widgetType: "view",
      pos: { x: 0, y: 13, w: 8, h: 7 },
      config: { viewName: "Deployments", profileSlug: "deployment" },
    },
    // Row 13-20: AI chat for infra queries
    {
      widgetType: "ai-chat",
      pos: { x: 8, y: 13, w: 4, h: 7 },
      config: { placeholder: "Ask about your infrastructure..." },
    },
  ],

  // ─── Seed entities ────────────────────────────────────────────────────────
  // None — user adds their real servers from Dokploy sync
  seedEntities: [],
};
