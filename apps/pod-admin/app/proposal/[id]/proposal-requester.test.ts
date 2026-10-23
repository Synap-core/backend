import { describe, expect, it } from "vitest";
import { proposalRequester } from "./proposal-requester";

describe("proposalRequester — who is asking, in one line", () => {
  it("an agent acting for a person: the agent, then the person", () => {
    expect(
      proposalRequester({
        authorName: "Claude-code",
        agentActorName: "Claude Code on devbox",
        principal: { kind: "delegated", name: "Antoine" },
      })
    ).toBe("Claude Code on devbox, for Antoine");
  });

  it("never the legacy coalesce when an agent acted", () => {
    expect(
      proposalRequester({
        authorName: "Antoine",
        agentActorName: "Scout",
        principal: { kind: "global" },
      })
    ).toBe("Scout");
  });

  it("an unrecorded owner is said, a nameless delegation is not doubted", () => {
    expect(
      proposalRequester({
        agentActorName: "Scout",
        principal: { kind: "unresolved" },
      })
    ).toBe("Scout, owner unknown");
    expect(
      proposalRequester({
        agentActorName: "Scout",
        principal: { kind: "delegated" },
      })
    ).toBe("Scout, for another user");
  });

  it("an Application is named first, with the person it acts for", () => {
    expect(proposalRequester({ appName: "Acme", authorName: "Ana" })).toBe(
      "Acme, for Ana"
    );
    expect(proposalRequester({ appName: "Acme" })).toBe("Acme");
  });

  it("a public form's submission is a guest's, never an AI's", () => {
    expect(
      proposalRequester({
        agentActorName: "Form: Contact",
        actorKind: "guest",
        principal: { kind: "delegated", name: "Antoine" },
      })
    ).toBe("Guest, through Form: Contact");
  });

  it("a person's own proposal names the person; nothing resolved is null", () => {
    expect(proposalRequester({ authorName: "Antoine" })).toBe("Antoine");
    expect(proposalRequester({})).toBeNull();
  });
});
