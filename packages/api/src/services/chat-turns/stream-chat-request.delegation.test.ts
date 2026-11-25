/**
 * `chatTurnDelegation`: the token a chat turn carries to the AI service. Every turn names the person's OWN Synap AI as
 * the acting agent (decision 6b45c6c3), so the hub accepts it as the persona of the turn's writes and bounds the turn
 * by the standing grant they gave it; an app's turn also carries the app's claim and refuses to fall back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return { mint: vi.fn(), person: vi.fn(), agent: vi.fn() };
});

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  mintIsDelegationToken: (...a: unknown[]) => spies.mint(...a),
  isDelegationHeaders: (...a: unknown[]) => spies.person(...a),
}));
vi.mock("../../utils/personal-agent-user.js", () => ({
  ensurePersonalAgentUser: (...a: unknown[]) => spies.agent(...a),
}));

const { chatTurnDelegation } = await import("./stream-chat-request.js");
const { IS_DELEGATION_HEADER } = await import("@synap/database");

const turn = {
  isUrl: "https://is.test",
  operatorUserId: "person",
  channelId: "ch",
  runId: "run",
};
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

beforeEach(() => {
  spies.mint.mockReset().mockReturnValue("signed-token");
  spies.person
    .mockReset()
    .mockReturnValue({ [IS_DELEGATION_HEADER]: "person-token" });
  spies.agent.mockReset().mockResolvedValue("synap-ai-agent");
});

describe("chatTurnDelegation", () => {
  it("an app's turn: the person's Synap AI is the acting agent and the app's claim rides along", async () => {
    const headers = await chatTurnDelegation({
      appGrant: claim,
      agentUserId: "synap-ai-agent",
      turn,
    });
    expect(headers).toEqual({ [IS_DELEGATION_HEADER]: "signed-token" });
    expect(spies.mint).toHaveBeenCalledWith({
      ...turn,
      appGrant: claim,
      agentUserId: "synap-ai-agent",
    });
    expect(spies.person).not.toHaveBeenCalled();
  });

  it("a turn with no app grant ALSO names the person's Synap AI (decision 6b45c6c3: every turn acts as it)", async () => {
    const headers = await chatTurnDelegation({
      appGrant: null,
      agentUserId: "synap-ai-agent",
      turn,
    });
    expect(headers).toEqual({ [IS_DELEGATION_HEADER]: "person-token" });
    expect(spies.person).toHaveBeenCalledWith({
      ...turn,
      agentUserId: "synap-ai-agent",
    });
    expect(spies.mint).not.toHaveBeenCalled();
  });

  it("an app turn that cannot sign THROWS (the caller refuses the turn, never a fallback)", async () => {
    spies.mint.mockImplementation(() => {
      throw new Error("cannot sign");
    });
    await expect(
      chatTurnDelegation({
        appGrant: claim,
        agentUserId: "synap-ai-agent",
        turn,
      })
    ).rejects.toThrow("cannot sign");
  });
});
