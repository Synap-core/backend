/**
 * Unit tests for the provider-agnostic inbound-message lander (Wave A).
 *
 * Covers the FROZEN CONTRACT (email-resolve → key → record; explicit externalId;
 * dedup) AND Discord parity: the migrated /discord/ingest path must reach
 * `recordInboundMessage` with byte-identical args to the pre-migration direct call.
 *
 * `recordInboundMessage` and `resolveIdentity` are mocked so we can assert the
 * exact args the lander forwards without a DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const recordInboundMessage = vi.fn();
const resolveIdentity = vi.fn();

vi.mock("./inbound-recorder.js", () => ({
  recordInboundMessage: (...args: unknown[]) => recordInboundMessage(...args),
}));

vi.mock("@synap/database", () => ({
  db: {},
  resolveIdentity: (...args: unknown[]) => resolveIdentity(...args),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { landInboundMessage } from "./land-inbound-message.js";

const RECORD_RESULT = {
  channelId: "chan-1",
  contextObjectId: null,
  inboundHash: "hash-1",
  recorded: true,
};

beforeEach(() => {
  recordInboundMessage.mockReset();
  resolveIdentity.mockReset();
  recordInboundMessage.mockResolvedValue({ ...RECORD_RESULT });
});

describe("landInboundMessage — email identity path (frozen contract)", () => {
  it("resolves a strong email match → entity id becomes the channel key; folds subject", async () => {
    resolveIdentity.mockResolvedValue({
      match: "strong",
      entity: { id: "entity-42" },
      candidates: [],
      crossKindCandidates: [],
    });

    const res = await landInboundMessage({
      provider: "proton",
      text: "hello there",
      subject: "Re: proposal",
      messageId: "<msg-1@mail>",
      participantEmail: "Alice@Example.com",
      participant: "alice@example.com",
      userId: "user-1",
      workspaceId: null,
    });

    // resolveIdentity called with the SAME shape the Mailgun route uses.
    expect(resolveIdentity).toHaveBeenCalledTimes(1);
    expect(resolveIdentity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "user-1",
        signals: [{ type: "email", value: "Alice@Example.com" }],
      })
    );

    const args = recordInboundMessage.mock.calls[0][0];
    expect(args.externalId).toBe("entity-42");
    expect(args.provider).toBe("proton");
    // Subject folded into the body (mirrors the Mailgun mapper).
    expect(args.text).toBe("Subject: Re: proposal\n\nhello there");
    // Default idempotency seed = messageId.
    expect(args.idempotencySeed).toBe("<msg-1@mail>");
    expect(res).toEqual({ ...RECORD_RESULT, deduped: false });
  });

  it("unresolved email → falls back to the email itself as the channel key", async () => {
    resolveIdentity.mockResolvedValue({
      match: null,
      candidates: [],
      crossKindCandidates: [],
    });

    await landInboundMessage({
      provider: "proton",
      text: "body",
      messageId: "m2",
      participantEmail: "nobody@example.com",
      userId: "user-1",
    });

    const args = recordInboundMessage.mock.calls[0][0];
    expect(args.externalId).toBe("nobody@example.com");
    // No subject → text unchanged.
    expect(args.text).toBe("body");
  });
});

describe("landInboundMessage — explicit externalId path", () => {
  it("skips identity resolution entirely when externalId is supplied", async () => {
    await landInboundMessage({
      provider: "proton",
      text: "hi",
      messageId: "m3",
      externalId: "explicit-key",
      participantEmail: "alice@example.com", // present but ignored — externalId wins
      userId: "user-1",
    });

    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(recordInboundMessage.mock.calls[0][0].externalId).toBe(
      "explicit-key"
    );
  });
});

describe("landInboundMessage — dedup", () => {
  it("reports deduped:true when the recorder reports recorded:false", async () => {
    recordInboundMessage.mockResolvedValue({
      ...RECORD_RESULT,
      recorded: false,
    });

    const res = await landInboundMessage({
      provider: "proton",
      text: "dup",
      messageId: "m4",
      externalId: "k",
      userId: "user-1",
    });

    expect(res.recorded).toBe(false);
    expect(res.deduped).toBe(true);
  });
});

describe("landInboundMessage — Discord parity (byte-identical record args)", () => {
  it("forwards the EXACT args the pre-migration /discord/ingest call built", async () => {
    // The literal arg object the discord route passed to recordInboundMessage
    // BEFORE Wave A (captured from routers/hub-protocol/rest/discord.ts).
    const discordChannelId = "111";
    const discordUserId = "222";
    const discordUsername = "someone";
    const messageId = "333";
    const callerKeyId = "key-9";
    const workspaceId = "44444444-4444-4444-4444-444444444444";
    const text = "hey bot";
    const attachments = [{ type: "image", url: "https://cdn/x.png" }];

    const expectedRecordArgs = {
      provider: "discord",
      externalId: discordChannelId,
      userId: "user-1",
      workspaceId,
      text,
      participant: discordUsername,
      participantExternalId: discordUserId,
      title: `Discord · ${discordUsername ?? discordUserId}`,
      idempotencySeed: `${discordChannelId}:${messageId}`,
      senderExternalId: discordUserId,
      senderKeyId: callerKeyId,
      messageId,
      attachments,
    };

    await landInboundMessage({
      provider: "discord",
      externalId: discordChannelId,
      userId: "user-1",
      workspaceId,
      text,
      participant: discordUsername,
      participantExternalId: discordUserId,
      title: `Discord · ${discordUsername ?? discordUserId}`,
      idempotencySeed: `${discordChannelId}:${messageId}`,
      senderExternalId: discordUserId,
      senderKeyId: callerKeyId,
      messageId,
      attachments,
    });

    // No email/subject on the discord path → no identity resolution, no fold.
    expect(resolveIdentity).not.toHaveBeenCalled();
    // Deep-equal: the recorder receives EXACTLY the prior literal (no sentAt key,
    // since discord passed none).
    expect(recordInboundMessage).toHaveBeenCalledTimes(1);
    expect(recordInboundMessage.mock.calls[0][0]).toEqual(expectedRecordArgs);
  });
});
