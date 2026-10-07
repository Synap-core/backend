/**
 * `/api/chat/stream` resolves the serving intelligence service through the ONE
 * capability-first door — never from the channel's assigned agent.
 *
 * The defect this pins: when a channel had an `assignedAgentId`, the route
 * called `resolveIntelligenceServiceByAgentId`, which read the legacy
 * `agents.intelligence_service_id` column and routed the turn to whichever IS
 * had published that persona — per-agent IS routing, breaking
 * "agentType ⟂ intelligenceServiceId". It also dropped `capability: "chat"` on
 * the no-agent branch, so the two branches did not even agree on the door.
 *
 * Driven through the real Hono route (`chatStreamApp`). Boundaries mocked: the
 * auth middleware (sets the user), the DB reads (membership, channel, agent
 * slug), the resolver module, and the outbound IS `fetch`. The legacy
 * per-agent resolver is still offered by the mock and points at a DIFFERENT
 * endpoint, so a regression to it is observable as the wrong IS URL.
 *
 * NOT covered, measured: the resolver's own precedence
 * (capability → workspace → user → default → env) — that is
 * `resolveIntelligenceService`'s contract, not this route's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  assignedAgentId: null as string | null,
  canonical: vi.fn(async () => ({
    endpoint: "https://canonical-is.example",
    serviceApiKey: "canonical-key",
  })),
  legacyByAgent: vi.fn(async () => ({
    endpoint: "https://per-agent-is.example",
    serviceApiKey: "per-agent-key",
  })),
  fetch: vi.fn(async () => new Response("data: {}\n\n", { status: 200 })),
}));

vi.mock("@synap/auth", () => ({
  authMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set("userId", "user-1");
    await next();
  },
}));
vi.mock("../../access/guest-containment.js", () => ({
  refuseGuestSession: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("@synap/database", () => {
  const select = {
    select: () => select,
    from: () => select,
    where: () => select,
    limit: async () => [{ slug: "researcher" }],
  };
  return {
    db: {
      query: {
        workspaceMembers: {
          findFirst: async () => ({ workspaceId: "ws-1" }),
        },
        channels: {
          findFirst: async () => ({
            id: "chan-1",
            workspaceId: "ws-1",
            assignedAgentId: h.assignedAgentId,
          }),
        },
      },
      select: () => select,
    },
    eq: () => ({}),
    and: () => ({}),
  };
});
vi.mock("../../utils/intelligence-routing.js", () => ({
  resolveIntelligenceService: h.canonical,
  resolveIntelligenceServiceByAgentId: h.legacyByAgent,
}));
vi.mock("../../utils/pod-callback.js", () => ({ getPodCallback: () => ({}) }));
vi.mock("../../utils/personal-channel.js", () => ({
  ensureAgentThread: async () => ({ id: "chan-1" }),
  getAgentIdBySlug: async () => "orchestrator-id",
}));
vi.mock("../../utils/channel-visibility.js", () => ({
  channelVisibilityWhere: () => ({}),
}));
vi.mock("../../utils/user-default-workspace.js", () => ({
  findUserDefaultWorkspaceId: async () => "ws-1",
}));
// Other routes on this app — inert here.
vi.mock("../../context.js", () => ({ createContext: async () => ({}) }));
vi.mock("../channels.js", () => ({
  channelSendMessageInputSchema: { safeParse: () => ({ success: false }) },
  channelsRouter: {},
}));
vi.mock("../../services/chat-turns/chat-turn-store.js", () => ({}));
vi.mock("../../services/chat-turns/chat-turn-runtime.js", () => ({}));
vi.mock("../../utils/query-channel-messages.js", () => ({}));

import { chatStreamApp } from "../chat-stream.js";

async function stream(body: Record<string, unknown>): Promise<Response> {
  return chatStreamApp.request("/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.canonical.mockClear();
  h.legacyByAgent.mockClear();
  h.fetch.mockClear();
  vi.stubGlobal("fetch", h.fetch);
});

describe("/api/chat/stream — intelligence service resolution", () => {
  it("a channel with an assigned agent is served by the capability-first door, not the agent's IS", async () => {
    h.assignedAgentId = "agent-researcher";
    const res = await stream({
      query: "hi",
      channelId: "11111111-1111-4111-8111-111111111111",
    });
    expect(res.status).toBe(200);

    expect(h.legacyByAgent).not.toHaveBeenCalled();
    expect(h.canonical).toHaveBeenCalledTimes(1);
    expect(h.canonical).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      capability: "chat",
    });

    const [url, init] = h.fetch.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://canonical-is.example/api/chat/stream");
    expect(init.headers["X-API-Key"]).toBe("canonical-key");
    // The agent still decides WHO answers (agentType), just not WHERE.
    expect(JSON.parse(init.body).agentType).toBe("researcher");
  });

  it("a channel with no assigned agent uses the SAME door with the same capability", async () => {
    h.assignedAgentId = null;
    const res = await stream({
      query: "hi",
      channelId: "11111111-1111-4111-8111-111111111111",
    });
    expect(res.status).toBe(200);
    expect(h.canonical).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      capability: "chat",
    });
    const [url, init] = h.fetch.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe("https://canonical-is.example/api/chat/stream");
    expect(JSON.parse(init.body).agentType).toBe("meta");
  });
});
