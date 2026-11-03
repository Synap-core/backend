import { describe, it, expect } from "vitest";
import { computeRevisedEnvelope } from "./proposals-service.js";

/**
 * A proposed message's RECIPIENT is not revisable (channels wave, lane D,
 * security review). The author agent may revise the words of its own pending
 * `messaging.external.send`, but a revise that repointed the channel would
 * have the person approve a card for Marie and send to Bob.
 */
const MESSAGE = {
  threadId: null,
  body: "Hello Marie",
  platform: "linkedin",
  channelId: "11111111-1111-4111-8111-111111111111",
  entityId: "22222222-2222-4222-8222-222222222222",
  provider: "linkedin",
  accountId: "acc-1",
};

describe("computeRevisedEnvelope — a message's recipient is pinned", () => {
  it.each([
    "channelId",
    "entityId",
    "accountId",
    "provider",
    "platform",
    "threadId",
  ])("refuses a revise that changes %s", (field) => {
    expect(() =>
      computeRevisedEnvelope({
        proposalType: "messaging.external.send",
        envelope: MESSAGE,
        patch: { kind: "envelope", fields: { [field]: "someone-else" } },
      })
    ).toThrow(new RegExp(field));
  });

  it("still lets the author revise the words", () => {
    const { merged } = computeRevisedEnvelope({
      proposalType: "messaging.external.send",
      envelope: MESSAGE,
      patch: { kind: "envelope", fields: { body: "Hello Marie, again" } },
    });
    expect(merged.body).toBe("Hello Marie, again");
    expect(merged.channelId).toBe(MESSAGE.channelId);
  });

  it("an echo of the same recipient is not a change", () => {
    expect(() =>
      computeRevisedEnvelope({
        proposalType: "messaging.external.send",
        envelope: MESSAGE,
        patch: {
          kind: "envelope",
          fields: { channelId: MESSAGE.channelId, body: "Hi" },
        },
      })
    ).not.toThrow();
  });
});
