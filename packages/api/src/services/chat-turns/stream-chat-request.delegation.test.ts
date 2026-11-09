/**
 * `chatTurnDelegation`: the token an app's chat turn carries to the AI service. It names the person's OWN Synap AI as
 * the acting agent (so the hub can bound the turn by the standing grant they gave it) and carries the app's claim;
 * a turn with no app grant is the person's own token, unchanged.
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
      userId: "person",
      appGrant: claim,
      turn,
    });
    expect(headers).toEqual({ [IS_DELEGATION_HEADER]: "signed-token" });
    expect(spies.agent).toHaveBeenCalledWith("person");
    expect(spies.mint).toHaveBeenCalledWith({
      ...turn,
      appGrant: claim,
      agentUserId: "synap-ai-agent",
    });
    expect(spies.person).not.toHaveBeenCalled();
  });

  it("a turn with no app grant is the person's own token: no agent named, the agent is not even created", async () => {
    const headers = await chatTurnDelegation({
      userId: "person",
      appGrant: null,
      turn,
    });
    expect(headers).toEqual({ [IS_DELEGATION_HEADER]: "person-token" });
    expect(spies.person).toHaveBeenCalledWith(turn);
    expect(spies.mint).not.toHaveBeenCalled();
    expect(spies.agent).not.toHaveBeenCalled();
  });

  it("an app turn that cannot sign or cannot name its agent THROWS (the caller refuses the turn, never a fallback)", async () => {
    spies.mint.mockImplementation(() => {
      throw new Error("cannot sign");
    });
    await expect(
      chatTurnDelegation({ userId: "person", appGrant: claim, turn })
    ).rejects.toThrow("cannot sign");
    spies.mint.mockReturnValue("signed-token");
    spies.agent.mockRejectedValue(new Error("no agent"));
    await expect(
      chatTurnDelegation({ userId: "person", appGrant: claim, turn })
    ).rejects.toThrow("no agent");
  });
});
