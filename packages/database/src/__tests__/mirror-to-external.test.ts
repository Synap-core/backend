/**
 * Unit tests for the generic Synap→external channel mirror.
 *
 * After the Wave C cutover the mirror is provider-AGNOSTIC: it ENQUEUES a
 * `post_message` egress intent instead of posting to Discord, and it no longer
 * owns the firewall (bot/AI vs client-comms) — that moved to the bridge, which
 * reads the `authorType` + `branchPurpose` FACTS off the intent. So the mirror's
 * remaining invariants are:
 *   - ECHO: inbound-origin (authorType='external') messages are never enqueued.
 *   - Only EXTERNAL channels with an external id enqueue.
 *   - Bot/AI output STILL enqueues here (the bridge decides whether to drop it) —
 *     the enqueued payload carries the facts the bridge firewall needs.
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

  test("bot output to a client-comms channel STILL enqueues here (bridge drops it) — carrying branchPurpose", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordComms,
      content: "automated",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "post_message",
        payload: expect.objectContaining({
          authorType: MessageAuthorType.BOT,
          branchPurpose: "client-comms",
        }),
      })
    );
  });

  test("ai_agent output enqueues with its authorType FACT", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordComms,
      content: "ai reply",
      authorType: MessageAuthorType.AI_AGENT,
    });
    expect(r.mirrored).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          authorType: MessageAuthorType.AI_AGENT,
          branchPurpose: "client-comms",
        }),
      })
    );
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

  test("human operator message enqueues with its authorType FACT", async () => {
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

  test("a non-discord provider is agnostic — it enqueues with its own externalSource", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: { ...discordTeam, externalSource: "telegram" },
      content: "x",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ externalSource: "telegram" })
    );
  });
});
