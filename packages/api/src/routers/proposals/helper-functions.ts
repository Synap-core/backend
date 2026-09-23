// ─── NEW: Helper functions to resolve commonly referenced names ───

// Local utility functions to avoid circular dependencies
function stringProp(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isLikelyUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );
}

// Local copy of displayNameForUser to avoid circular dependency
function displayNameForUser(row: {
  name?: string | null;
  email?: string | null;
}): string {
  return row.name ?? row.email ?? "Unknown";
}

// ProposalRow type - minimal shape needed by resolvers
type ProposalRow = {
  proposalType: string;
  agentUserId?: string | null;
  targetId?: string;
  workspaceId?: string | null;
  subjectUserId?: string | null;
};

export interface NameResolutionContext {
  playbookById: Map<string, { name: string; goalTemplate: string }>;
  projectById: Map<string, { name: string; description: string | undefined }>;
  automationById: Map<string, { name: string }>;
  skillById: Map<string, { name: string; slug: string }>;
  toolById: Map<string, { name: string }>;
  workspaceById: Map<string, { name: string }>;
  channelById: Map<string, { title: string | undefined }>;
  userById: Map<
    string,
    {
      id: string;
      name: string | null;
      email: string;
      userType: string;
      agentMetadata: unknown;
      createdByUserId: string | null;
    }
  >;
}

export function createNameResolvers(ctx: NameResolutionContext) {
  return {
    resolvePlaybookName(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      const pt = row.proposalType;
      if (
        pt.startsWith("session/") ||
        pt.startsWith("project/") ||
        pt.startsWith("playbook/")
      ) {
        const playbookId =
          stringProp(payload, "playbookId") ??
          stringProp(payload, "templateId");
        if (playbookId && isLikelyUUID(playbookId)) {
          return ctx.playbookById.get(playbookId)?.name;
        }
      }
      return undefined;
    },

    resolveProjectName(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      const pt = row.proposalType;
      if (pt.startsWith("session/") || pt.startsWith("project/")) {
        const projectId = stringProp(payload, "projectId");
        if (projectId && isLikelyUUID(projectId)) {
          return ctx.projectById.get(projectId)?.name;
        }
      }
      return undefined;
    },

    resolveAutomationName(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      const pt = row.proposalType;
      if (pt.startsWith("automation/")) {
        const automationId = stringProp(payload, "automationId");
        if (automationId && isLikelyUUID(automationId)) {
          return ctx.automationById.get(automationId)?.name;
        }
      }
      return undefined;
    },

    resolveCapabilityCallLabel(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      const pt = row.proposalType;
      if (pt === "capability.run") {
        const capabilityId =
          stringProp(payload, "capabilityId") ?? stringProp(payload, "skillId");
        const toolId = stringProp(payload, "toolId");
        const provider = stringProp(payload, "provider");
        const verb =
          stringProp(payload, "verb") ??
          stringProp(payload, "verbName") ??
          stringProp(payload, "verbId");
        const path = stringProp(payload, "path");

        // Try skills first
        if (capabilityId && isLikelyUUID(capabilityId)) {
          const skill = ctx.skillById.get(capabilityId);
          if (skill) {
            return `${skill.name}${verb ? ` · ${verb}` : ""}`;
          }
        }
        // Try tools
        if (toolId && isLikelyUUID(toolId)) {
          const tool = ctx.toolById.get(toolId);
          if (tool) {
            return `${tool.name}${path ? ` ${path}` : ""}${verb ? ` · ${verb}` : ""}`;
          }
        }
        // Fallback to provider + verb/path
        if (provider && (verb || path)) {
          return `${provider} ${verb ?? path ?? ""}`.trim();
        }
        if (provider) return provider;
      }
      return undefined;
    },

    resolveWorkspaceName(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      const pt = row.proposalType;
      if (pt.startsWith("workspace/")) {
        const workspaceId = stringProp(payload, "workspaceId") ?? row.targetId;
        if (workspaceId && isLikelyUUID(workspaceId)) {
          return ctx.workspaceById.get(workspaceId)?.name;
        }
      }
      return undefined;
    },

    resolveChannelName(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      const pt = row.proposalType;
      if (pt === "governance.tighten_posture") {
        const channelId = stringProp(payload, "channelId");
        if (channelId && isLikelyUUID(channelId)) {
          return ctx.channelById.get(channelId)?.title;
        }
      }
      return undefined;
    },

    resolveAgentName(
      row: ProposalRow,
      payload: Record<string, unknown> | undefined
    ): string | undefined {
      // For governance proposals, resolve the agent name
      const pt = row.proposalType;
      if (pt.startsWith("governance.")) {
        const agentId = row.agentUserId ?? stringProp(payload, "agentId");
        if (agentId && isLikelyUUID(agentId)) {
          // The agent row is already in userById (we joined all users)
          const agentRow = ctx.userById.get(agentId);
          if (agentRow) {
            return displayNameForUser(agentRow);
          }
        }
      }
      return undefined;
    },
  };
}

// Re-export types and utilities needed
export { stringProp, isLikelyUUID, displayNameForUser };
