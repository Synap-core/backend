/**
 * Unit tests for the generic Synap→Discord channel mirror guards.
 *
 * These are the SECURITY-CRITICAL invariants of the mirror:
 *   - ECHO: inbound-origin (authorType='external') messages are never re-mirrored.
 *   - FIREWALL: bot/AI output must never reach a client-comms channel; a human
 *     operator message to client-comms IS allowed (operator→client reply).
 *   - Only EXTERNAL discord-bound channels with an external id mirror.
 *
 * `discord-rest` is mocked so no network/DB is touched; channels are passed
 * inline so `getDb` is never called.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";

const { tokenMock, postMock } = vi.hoisted(() => ({
  tokenMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock("../utils/discord-rest.js", () => ({
  resolveDiscordBotToken: tokenMock,
  postDiscordChannelMessage: postMock,
}));

import { mirrorMessageToBoundExternal } from "../utils/mirror-to-external.js";
import { MessageAuthorType } from "../schema/messages.js";

const discordTeam = {
  channelType: "external",
  externalSource: "discord",
  externalId: "chan-123",
  externalChannelId: "chan-123",
  branchPurpose: "team",
};
const discordComms = { ...discordTeam, branchPurpose: "client-comms" };

beforeEach(() => {
  tokenMock.mockReset();
  postMock.mockReset();
  tokenMock.mockResolvedValue("bot-token");
  postMock.mockResolvedValue(undefined);
});

describe("mirrorMessageToBoundExternal — guards", () => {
  test("ECHO: inbound-origin (external) message is not re-mirrored", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordTeam,
      content: "hi",
      authorType: MessageAuthorType.EXTERNAL,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("inbound_origin");
    expect(postMock).not.toHaveBeenCalled();
  });

  test("FIREWALL: bot output to a client-comms channel is blocked", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordComms,
      content: "automated",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("blocked_client_comms");
    expect(postMock).not.toHaveBeenCalled();
  });

  test("FIREWALL: ai_agent output to a client-comms channel is blocked", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordComms,
      content: "ai reply",
      authorType: MessageAuthorType.AI_AGENT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("blocked_client_comms");
    expect(postMock).not.toHaveBeenCalled();
  });

  test("FIREWALL: human operator message to client-comms IS allowed (operator→client)", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordComms,
      content: "reply to client",
      authorType: MessageAuthorType.HUMAN,
    });
    expect(r.mirrored).toBe(true);
    expect(postMock).toHaveBeenCalledWith(
      "bot-token",
      "chan-123",
      "reply to client"
    );
  });

  test("bot output to a team channel is mirrored", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: discordTeam,
      content: "digest item",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(true);
    expect(postMock).toHaveBeenCalledWith(
      "bot-token",
      "chan-123",
      "digest item"
    );
  });

  test("non-external channel does not mirror", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: { ...discordTeam, channelType: "feed" },
      content: "x",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("not_external");
    expect(postMock).not.toHaveBeenCalled();
  });

  test("external channel without an external id does not mirror", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: { ...discordTeam, externalId: null, externalChannelId: null },
      content: "x",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("no_external_id");
    expect(postMock).not.toHaveBeenCalled();
  });

  test("non-discord provider is not mirrored (goes through the messaging path)", async () => {
    const r = await mirrorMessageToBoundExternal({
      channel: { ...discordTeam, externalSource: "telegram" },
      content: "x",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("unsupported_provider:telegram");
    expect(postMock).not.toHaveBeenCalled();
  });

  test("missing bot token is a clean skip, not a throw", async () => {
    tokenMock.mockResolvedValue(null);
    const r = await mirrorMessageToBoundExternal({
      channel: discordTeam,
      content: "x",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("no_bot_token");
  });

  test("a send failure is swallowed into a structured result (never throws)", async () => {
    postMock.mockRejectedValue(new Error("429 rate limited"));
    const r = await mirrorMessageToBoundExternal({
      channel: discordTeam,
      content: "x",
      authorType: MessageAuthorType.BOT,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toContain("429");
  });
});
