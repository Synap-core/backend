/**
 * The app chat door refuses a turn BEFORE it starts unless the person's Synap AI is connected (the grant they set once on
 * the Keys page): nothing is reserved, nothing is sent to the AI service. A connected one goes on to reserve the turn.
 * An API-key turn (no app grant) is not gated. The wiring is the point: `synapAiGate` is tested on its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const spies = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return { gate: vi.fn(), begin: vi.fn(), target: vi.fn() };
});

vi.mock("../synap-ai-ceiling.js", () => ({
  synapAiGate: (...a: unknown[]) => spies.gate(...a),
}));
vi.mock("../../utils/resolve-chat-target.js", () => ({
  resolveChatTarget: (...a: unknown[]) => spies.target(...a),
}));
vi.mock(
  "../../services/chat-turns/external-durable-turn.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    beginExternalDurableTurn: (...a: unknown[]) => spies.begin(...a),
  })
);

const { handleChatStream } = await import("./stream-chat-request.js");

const claim = {
  scopes: [
    {
      permissions: ["chat.stream"],
      workspaceIds: ["ws"],
      projectIds: null,
      entityIds: null,
    },
  ],
  clientId: "app_chat",
};

async function post(opts: Parameters<typeof handleChatStream>[1]) {
  const app = new Hono();
  app.post("/chat/stream", (c) => handleChatStream(c, opts));
  return app.request("https://pod.test/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "hello" }),
  });
}

beforeEach(() => {
  spies.gate.mockReset();
  spies.begin.mockReset().mockRejectedValue(new Error("reserve reached"));
  spies.target
    .mockReset()
    .mockResolvedValue({ ok: true, workspaceId: "ws", channelId: "ch" });
});

describe("the app chat door and Synap AI", () => {
  it("not connected: 409 with the page to connect it, and NOTHING is reserved", async () => {
    spies.gate.mockResolvedValue({
      open: false,
      status: 409,
      body: {
        error: "Connect Synap AI",
        code: "SYNAP_AI_NOT_CONNECTED",
        connectUrl: "https://admin.test/keys",
      },
    });
    const res = await post({ userId: "person", appGrant: claim });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "SYNAP_AI_NOT_CONNECTED",
      connectUrl: "https://admin.test/keys",
    });
    expect(spies.begin).not.toHaveBeenCalled();
    expect(spies.gate).toHaveBeenCalledWith("person", "https://pod.test");
  });

  it("connected: the turn goes on to be reserved", async () => {
    spies.gate.mockResolvedValue({ open: true });
    await expect(
      post({ userId: "person", appGrant: claim })
    ).resolves.toBeDefined();
    expect(spies.begin).toHaveBeenCalledTimes(1);
  });

  it("an API-key turn (no app grant) is not gated", async () => {
    await post({ userId: "person" });
    expect(spies.gate).not.toHaveBeenCalled();
    expect(spies.begin).toHaveBeenCalledTimes(1);
  });

  it("a target outside the app's grant is refused first (403), the gate never runs", async () => {
    const res = await post({
      userId: "person",
      appGrant: claim,
      authorizeTarget: () => false,
    });
    expect(res.status).toBe(403);
    expect(spies.gate).not.toHaveBeenCalled();
  });
});
