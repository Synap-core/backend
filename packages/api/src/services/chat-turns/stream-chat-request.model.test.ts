/**
 * An app's chat turn may name a model (`model`). What is asserted is what REACHES the AI service and what is reserved:
 *  - an enabled model arrives in the IS request body as `agentOverrides.modelOverride`, with the person's OTHER
 *    overrides (prompt append, tools, steps) kept: the request's overrides replace what the IS would read itself;
 *  - a model the pod has not enabled (a disabled provider's, or one nobody lists) is a 400 and NO turn is reserved,
 *    nothing is sent to the IS;
 *  - no `model` = the IS body carries no `agentOverrides` and the overrides are not even read (today's behaviour);
 *  - a failed read of the person's overrides refuses the turn (503) instead of sending "no overrides".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const spies = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return {
    begin: vi.fn(),
    target: vi.fn(),
    overrides: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock("../synap-ai-ceiling.js", () => ({
  synapAiGate: async () => ({ open: true }),
}));
vi.mock("../../utils/resolve-chat-target.js", () => ({
  resolveChatTarget: (...a: unknown[]) => spies.target(...a),
}));
vi.mock("../../utils/intelligence-routing.js", () => ({
  resolveIntelligenceService: async () => ({
    endpoint: "https://is.test",
    serviceApiKey: "is-key",
  }),
}));
vi.mock("../../utils/pod-callback.js", () => ({ getPodCallback: () => ({}) }));
// Every turn acts as the person's ONE personal AI (decision 6b45c6c3).
vi.mock("../../utils/personal-agent-user.js", () => ({
  ensurePersonalAgentUser: async () => "synap-ai",
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  agentOverridesForTurn: (...a: unknown[]) => spies.overrides(...a),
  isDelegationHeaders: () => ({}),
}));
vi.mock("./external-durable-turn.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginExternalDurableTurn: (...a: unknown[]) => spies.begin(...a),
  safeFinishExternalTurn: vi.fn(async () => undefined),
  wrapUpstreamStreamWithTurnLifecycle: ({
    upstream,
  }: {
    upstream: ReadableStream;
  }) => upstream,
}));
vi.mock("./enabled-models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./enabled-models.js")>();
  return {
    ...actual,
    listEnabledModels: async () =>
      actual.selectableModels([
        {
          providerId: "openrouter",
          name: "OpenRouter",
          priority: 1,
          enabled: true,
          models: [{ id: "anthropic/claude-sonnet-4.5" }],
        },
        {
          providerId: "off-provider",
          name: "Off",
          priority: 2,
          enabled: false,
          models: [{ id: "secret-model" }],
        },
      ]),
  };
});

const { handleChatStream } = await import("./stream-chat-request.js");

const PERSON_OVERRIDES = {
  modelOverride: "openrouter/some-old-pin",
  promptAppend: "Answer in French.",
  extraToolIds: ["tool.a"],
  disabledToolIds: ["tool.b"],
  maxStepsOverride: 7,
};

async function post(body: Record<string, unknown>) {
  const app = new Hono();
  app.post("/chat/stream", (c) => handleChatStream(c, { userId: "person" }));
  return app.request("https://pod.test/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "hello", ...body }),
  });
}

const sentBody = () =>
  JSON.parse((spies.fetch.mock.calls[0]![1] as { body: string }).body);

beforeEach(() => {
  spies.begin.mockReset().mockResolvedValue({
    created: true,
    turn: { id: "turn-1", requestId: "req-1", status: "running" },
  });
  spies.target
    .mockReset()
    .mockResolvedValue({ ok: true, workspaceId: "ws", channelId: "ch" });
  spies.overrides.mockReset().mockResolvedValue(PERSON_OVERRIDES);
  spies.fetch
    .mockReset()
    .mockImplementation(
      async () =>
        new Response(new Blob(["data: [DONE]\n\n"]).stream(), { status: 200 })
    );
  vi.stubGlobal("fetch", spies.fetch);
});

describe("POST chat/stream with a model", () => {
  it("an enabled model reaches the IS as modelOverride, the person's other overrides kept", async () => {
    const res = await post({ model: "openrouter/anthropic/claude-sonnet-4.5" });
    expect(res.status).toBe(200);
    expect(spies.fetch).toHaveBeenCalledTimes(1);
    expect(sentBody().agentOverrides).toEqual({
      ...PERSON_OVERRIDES,
      modelOverride: "openrouter/anthropic/claude-sonnet-4.5",
    });
    expect(spies.overrides).toHaveBeenCalledWith({
      userId: "person",
      workspaceId: "ws",
      agentType: "meta",
    });
  });

  it("the person has no overrides row: the model alone, the IS defaults for the rest", async () => {
    spies.overrides.mockResolvedValue(null);
    await post({ model: "openrouter/anthropic/claude-sonnet-4.5" });
    expect(sentBody().agentOverrides).toEqual({
      modelOverride: "openrouter/anthropic/claude-sonnet-4.5",
      promptAppend: null,
      extraToolIds: [],
      disabledToolIds: [],
      maxStepsOverride: null,
    });
  });

  it.each([
    ["a model nobody lists", "openrouter/not-a-model"],
    ["a model of a DISABLED provider", "off-provider/secret-model"],
    ["a bare model id without its provider", "anthropic/claude-sonnet-4.5"],
  ])("%s: 400, no turn reserved, nothing sent to the IS", async (_n, model) => {
    const res = await post({ model });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not enabled/);
    expect(spies.begin).not.toHaveBeenCalled();
    expect(spies.fetch).not.toHaveBeenCalled();
  });

  it("the person's overrides cannot be read: 503, no turn, never sent as 'no overrides'", async () => {
    spies.overrides.mockResolvedValue(undefined);
    const res = await post({ model: "openrouter/anthropic/claude-sonnet-4.5" });
    expect(res.status).toBe(503);
    expect(spies.begin).not.toHaveBeenCalled();
    expect(spies.fetch).not.toHaveBeenCalled();
  });
});

describe("POST chat/stream without a model", () => {
  it("the IS body is unchanged: no agentOverrides, overrides not read", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(sentBody()).toEqual({
      query: "hello",
      threadId: "ch",
      userId: "person",
      // The turn acts as the person's personal AI (decision 6b45c6c3).
      agentUserId: "synap-ai",
      workspaceId: "ws",
      agentType: "meta",
      stream: true,
    });
    expect(spies.overrides).not.toHaveBeenCalled();
  });
});
