/**
 * Unit tests for the generic Synap→external channel mirror.
 *
 * The mirror is provider-AGNOSTIC: it ENQUEUES a `post_message` egress intent
 * instead of posting to Discord. Its invariants:
 *   - ECHO: inbound-origin (authorType='external') messages are never enqueued.
 *   - Only EXTERNAL channels with an external id enqueue.
 *   - FIREWALL (fail-closed, defense-in-depth): AUTONOMOUS AI/agent output
 *     (authorType !== 'human') to a client-comms firewall target is DROPPED here
 *     (reason 'blocked_client_comms_mirror'), never enqueued — the same predicate
 *     delivery-router.ts uses. HUMAN-authored messages to the SAME channel are
 *     legitimate client delivery and STILL enqueue. Non-firewall channels (team /
 *     null-purpose / unbound) enqueue regardless of authorType.
 *
 * `channel-egress` is mocked so no network/DB is touched; channels are passed
 * inline so `getDb` is never called.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";

const { enqueueMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(),
}));

vi.mock("../utils/channel-egress.js", () => ({
  enqueueChannelEgress: enqueueMock,
}));

import { mirrorMessageToBoundExternal } from "../utils/mirror-to-external.js";
import { MessageAuthorType } from "../schema/messages.js";

const discordTeam = {
  channelType: "external",
  externalSource: "discord",
  externalId: "chan-123",
  externalChannelId: "chan-123",
  branchPurpose: "team",
  workspaceId: "ws-1",
};
const discordComms = { ...discordTeam, branchPurpose: "client-comms" };
const discordNullPurpose = { ...discordTeam, branchPurpose: null };
// An external channel BOUND to a subject entity, NOT explicitly 'team' — the
// second firewall case (a conversation with that party).
const discordEntityBound = {
  ...discordTeam,
  branchPurpose: null,
  contextObjectId: "entity-1",
};

beforeEach(() => {
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue({ id: "egress-1" });
});

describe("mirrorMessageToBoundExternal — agnostic enqueue", () => {
  test("ECHO: inbound-origin (external) message is NOT enqueued", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordTeam,
      content: "hi",
      authorType: MessageAuthorType.EXTERNAL,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("inbound_origin");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("empty content is NOT enqueued", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordTeam,
      content: "",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("empty_content");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("bot output enqueues a post_message intent with the firewall FACTS", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordTeam,
      content: "digest item",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith({
      externalSource: "discord",
      externalId: "chan-123",
      kind: "post_message",
      payload: {
        content: "digest item",
        authorType: MessageAuthorType.BOT,
        branchPurpose: "team",
      },
      workspaceId: "ws-1",
    });
  });

  test("FIREWALL: bot output to a client-comms channel is DROPPED (not enqueued)", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordComms,
      content: "automated",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("blocked_client_comms_mirror");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("FIREWALL: ai_agent output to a client-comms channel is DROPPED (not enqueued)", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordComms,
      content: "ai reply",
      authorType: MessageAuthorType.AI_AGENT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("blocked_client_comms_mirror");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("FIREWALL: ai_agent output to an entity-bound (non-team) external channel is DROPPED", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordEntityBound,
      content: "ai reply",
      authorType: MessageAuthorType.AI_AGENT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("blocked_client_comms_mirror");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("null branchPurpose rides the intent as null (bridge decides)", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordNullPurpose,
      content: "automated",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ branchPurpose: null }),
      })
    );
  });

  test("FIREWALL PRESERVES DELIVERY: human operator message to a client-comms channel STILL enqueues", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordComms,
      content: "reply to client",
      authorType: MessageAuthorType.HUMAN,
    });
    expect(r.mirrored).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          authorType: MessageAuthorType.HUMAN,
        }),
      })
    );
  });

  test("non-external channel does not enqueue", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: { ...discordTeam, channelType: "feed" },
      content: "x",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("not_external");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("external channel without an external id does not enqueue", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: { ...discordTeam, externalId: null, externalChannelId: null },
      content: "x",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("no_external_id");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test("a non-discord provider is NOT mirrored yet — only Discord consumes the egress outbox", async () => {
    // The provider guard deliberately gates the mirror to Discord (the only source
    // with an egress consumer today); enqueuing telegram would pile up unconsumed
    // rows and falsely report mirrored:true. This asserts that documented behavior.
    const r = await mirrorMessageToBoundExternal({
      channel: { ...discordTeam, externalSource: "telegram" },
      content: "x",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("no_egress_consumer:telegram");
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
