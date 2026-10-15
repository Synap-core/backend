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
    workspaceSettings: { proactiveAi: { nudgeDensity: "low" } },
    agentOverrides: {
      modelOverride: "openrouter/model-x",
      promptAppend: null,
      extraToolIds: [],
      disabledToolIds: [],
      maxStepsOverride: null,
    },
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
      agentOverrides: { modelOverride: "openrouter/model-x" },
    });
  });

  it("forwards a null agentOverrides (looked, none) and omits an unknown one", () => {
    // null and absent mean different things to the IS: null = no row, absent =
    // read it yourself. Collapsing them would make a failed pod read look empty.
    const none = buildChatRequestBody(
      { ...request, agentOverrides: null },
      true
    );
    expect(none).toHaveProperty("agentOverrides", null);
    const { agentOverrides: _drop, ...unknown } = request;
    expect(buildChatRequestBody(unknown, true)).not.toHaveProperty(
      "agentOverrides"
    );
  });

  it("forwards the turnContext session sibling verbatim to the IS body", () => {
    // The pod validates `turnContext.session` (channels/helpers.ts) and the IS
    // accepts it (chat-stream.ts). This client must not flatten the object to
    // `{ entries }` in between — that severance is invisible to a typecheck
    // because TurnContext is a passthrough record.
    const session = {
      version: 1,
      id: "session-1",
      goal: "Ship the sibling",
      stage: "build",
      progress: 40,
      depth: 1,
      chain: [{ id: "session-0", goal: "Parent goal" }],
      suspendedIntent: "Finish the audit first",
    };

    const body = buildChatRequestBody(
      {
        ...request,
        turnContext: {
          entries: [{ key: "viewMode", value: "compact" }],
          session,
        },
      },
      true
    ) as { turnContext?: Record<string, unknown> };

    expect(body.turnContext).toEqual({
      entries: [{ key: "viewMode", value: "compact" }],
      session,
    });

    // A session-only turnContext survives too.
    const sessionOnly = buildChatRequestBody(
      { ...request, turnContext: { session } },
      true
    ) as { turnContext?: Record<string, unknown> };
    expect(sessionOnly.turnContext).toEqual({ session });
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
