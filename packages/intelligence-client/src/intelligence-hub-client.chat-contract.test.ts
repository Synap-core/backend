import { describe, expect, it } from "vitest";
import {
  buildChatRequestBody,
  type IntelligenceHubRequest,
} from "./intelligence-hub-client.js";

describe("buildChatRequestBody", () => {
  const request = {
    query: "Help me configure this workspace",
    threadId: "thread-1",
    userId: "user-1",
    agentId: "agent-1",
    agentType: "personal",
    agentConfig: { tone: "brief" },
    projectId: "project-1",
    workspaceId: "workspace-1",
    sourceMessageId: "message-1",
    agentUserId: "agent-user-1",
    dataPodUrl: "https://pod.example.com",
    dataPodApiKey: "pod-key",
    mcpServers: [
      {
        id: "mcp-1",
        name: "Browser",
        transport: "http",
        url: "https://mcp.example.com",
      },
    ],
    deepAnalysis: true,
    workspaceSettings: { agentModelPreferences: { complex: "opus" } },
    channelKind: "pm",
    focusSessionId: "focus-1",
    contextObjectType: "view",
    contextObjectId: "view-1",
    turnContext: { surface: "crm" },
    forcedSkillName: "onboard",
  } satisfies IntelligenceHubRequest;

  it("keeps resolved turn context identical across stream modes", () => {
    const streaming = buildChatRequestBody(request, true);
    const fallback = buildChatRequestBody(request, false);

    expect(streaming).toEqual({ ...fallback, stream: true });
    expect(fallback).toMatchObject({
      stream: false,
      agentType: "personal",
      agentConfig: { tone: "brief" },
      projectId: "project-1",
      workspaceId: "workspace-1",
      sourceMessageId: "message-1",
      agentUserId: "agent-user-1",
      deepAnalysis: true,
      channelKind: "pm",
      focusSessionId: "focus-1",
      turnContext: { surface: "crm" },
      onboardingSkill: "onboard",
    });
  });

  it("preserves a bounded named integration skill outside onboarding", () => {
    expect(
      buildChatRequestBody(
        { ...request, forcedSkillName: "daily-digest" },
        false
      )
    ).toMatchObject({ forcedSkillName: "daily-digest" });
  });
});
