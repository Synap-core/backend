import { describe, expect, it } from "vitest";
import {
  UNNAMED_AGENT_NAME,
  isAgentSpokenMessage,
  messageSpeakerIds,
  resolveMessageSpeaker,
} from "./index.js";

// One directory, as a surface holds it: the owner AND their agents.
const directory = new Map([
  ["owner-1", "Antoine"],
  ["agent-user-scout", "Scout"],
  ["agents-row-orchestrator", "Orchestrator"],
]);
const lookup = (id: string) => directory.get(id);

describe("which actor spoke", () => {
  // The discriminating row: the old desk rule (`metadata.agentId ?? userId`)
  // and this one disagree here. An agent's own post stores the OWNER as
  // `userId` and the agent user as `routedTeammateId` (`postChannelMessage`).
  it("names the agent on an agent's own post, never its owner", () => {
    const post = {
      role: "assistant",
      authorType: "ai_agent",
      userId: "owner-1",
      routedTeammateId: "agent-user-scout",
      metadata: null,
    };
    expect(resolveMessageSpeaker(post, lookup)).toBe("Scout");
    expect(messageSpeakerIds(post)).not.toContain("owner-1");
  });

  it("an agent the directory cannot name stays unnamed — the owner is never the fallback", () => {
    const reply = {
      role: "assistant",
      authorType: "ai_agent",
      userId: "owner-1",
      routedTeammateId: "agent-user-unknown",
      metadata: { agentId: "agents-row-unknown" },
    };
    expect(resolveMessageSpeaker(reply, lookup)).toBeUndefined();
    // A reply that recorded no agent at all (the a2ai worker) is the same.
    expect(
      resolveMessageSpeaker({ role: "assistant", userId: "owner-1" }, lookup)
    ).toBeUndefined();
  });

  it("the routed agent user outranks the agent definition", () => {
    const routed = {
      role: "assistant",
      authorType: "ai_agent",
      userId: "owner-1",
      routedTeammateId: "agent-user-scout",
      metadata: { agentId: "agents-row-orchestrator" },
    };
    expect(messageSpeakerIds(routed)).toEqual([
      "agent-user-scout",
      "agents-row-orchestrator",
    ]);
    expect(resolveMessageSpeaker(routed, lookup)).toBe("Scout");
  });

  it("an interactive reply with only its definition is named by it", () => {
    const reply = {
      role: "assistant",
      authorType: "ai_agent",
      userId: "owner-1",
      routedTeammateId: null,
      metadata: { agentId: "agents-row-orchestrator" },
    };
    expect(resolveMessageSpeaker(reply, lookup)).toBe("Orchestrator");
  });

  it("a person's message is named by its userId", () => {
    const said = {
      role: "user",
      authorType: "human",
      userId: "owner-1",
      // Ignored for a person, even when present.
      metadata: { agentId: "agents-row-orchestrator" },
    };
    expect(resolveMessageSpeaker(said, lookup)).toBe("Antoine");
  });

  it("an agent is the author when authorType or role says so", () => {
    expect(isAgentSpokenMessage({ authorType: "ai_agent" })).toBe(true);
    expect(isAgentSpokenMessage({ authorType: "bot", role: "system" })).toBe(
      true
    );
    // Relay's transcript carries only `role`.
    expect(isAgentSpokenMessage({ role: "assistant" })).toBe(true);
    expect(isAgentSpokenMessage({ role: "user", authorType: "human" })).toBe(
      false
    );
    expect(isAgentSpokenMessage({ role: "user", authorType: "external" })).toBe(
      false
    );
  });

  it("a bot notice whose userId is 'system' or the owner names no one", () => {
    expect(
      messageSpeakerIds({
        role: "assistant",
        authorType: "bot",
        userId: "system",
      })
    ).toEqual([]);
  });
});

describe("UNNAMED_AGENT_NAME", () => {
  it("is the phone's word for an unknown agent, so both surfaces say the same", () => {
    expect(UNNAMED_AGENT_NAME).toBe("AI");
  });
});
