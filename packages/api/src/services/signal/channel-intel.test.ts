import { describe, expect, it } from "vitest";

/**
 * Channel-intelligence pure logic:
 *   • the channel-level deep-link builder (U2),
 *   • the matcher-faithful channel⇄automation binding classifier (U3/U4),
 *   • the origin `produced` edge shape (U1),
 *   • primary-automation selection for a bare rerun (U5).
 *
 * All four are pure — no DB, no mocks. The DB-touching layers around them are
 * covered by the existing signal service tests.
 */

import {
  buildChannelDeepLink,
  readChannelExternalMetadata,
} from "../channels/channel-deep-link.js";
import {
  channelOriginLinkInputs,
  producerEndpointType,
  producerTypeFromEndpoint,
  pickProducerToolByScope,
} from "../channels/channel-origin.js";
import {
  classifyChannelAutomationBinding,
  matchesEventPattern,
} from "./channel-automation-binding.js";
import { pickPrimaryChannelAutomation } from "./channel-rerun.js";
import { summarizeAutomationTrigger } from "./channel-stack.js";

// ── U2: deep link ─────────────────────────────────────────────────────────────

describe("buildChannelDeepLink", () => {
  it("builds a Discord channel url from guild + channel id", () => {
    expect(
      buildChannelDeepLink({
        source: "discord",
        externalChannelId: "1234567890",
        guildId: "9876543210",
      })
    ).toEqual({
      url: "https://discord.com/channels/9876543210/1234567890",
      kind: "discord",
    });
  });

  it("returns null for Discord WITHOUT a guild id rather than a broken url", () => {
    expect(
      buildChannelDeepLink({
        source: "discord",
        externalChannelId: "1234567890",
      })
    ).toBeNull();
  });

  it("rejects non-numeric Discord ids (an entity-uuid channel key)", () => {
    expect(
      buildChannelDeepLink({
        source: "discord",
        externalChannelId: "0f2b1c44-0000-4000-8000-000000000000",
        guildId: "9876543210",
      })
    ).toBeNull();
  });

  it("builds a Telegram supergroup url by stripping the -100 prefix", () => {
    expect(
      buildChannelDeepLink({
        source: "telegram",
        externalChannelId: "-1001234567890",
      })
    ).toEqual({ url: "https://t.me/c/1234567890", kind: "telegram" });
  });

  it("builds a Telegram url from an @handle, and null for a private chat id", () => {
    expect(
      buildChannelDeepLink({ source: "telegram", externalChannelId: "@synap" })
    ).toEqual({ url: "https://t.me/synap", kind: "telegram" });
    expect(
      buildChannelDeepLink({
        source: "telegram",
        externalChannelId: "445566",
      })
    ).toBeNull();
  });

  it("needs a Slack team id", () => {
    expect(
      buildChannelDeepLink({ source: "slack", externalChannelId: "C123" })
    ).toBeNull();
    expect(
      buildChannelDeepLink({
        source: "slack",
        externalChannelId: "C123",
        teamId: "T999",
      })
    ).toEqual({
      url: "https://slack.com/app_redirect?channel=C123&team=T999",
      kind: "slack",
    });
  });

  it("treats an https external id as its own link, and unknown providers as null", () => {
    expect(
      buildChannelDeepLink({
        source: "rss",
        externalChannelId: "https://example.com/feed",
      })
    ).toEqual({ url: "https://example.com/feed", kind: "web" });
    expect(
      buildChannelDeepLink({ source: "mailgun", externalChannelId: "a@b.com" })
    ).toBeNull();
    expect(
      buildChannelDeepLink({ source: "discord", externalChannelId: null })
    ).toBeNull();
  });
});

describe("readChannelExternalMetadata", () => {
  it("is total over garbage metadata", () => {
    expect(readChannelExternalMetadata(null)).toEqual({});
    expect(readChannelExternalMetadata("nope")).toEqual({});
    expect(readChannelExternalMetadata({ external: [1, 2] })).toEqual({});
    expect(readChannelExternalMetadata({ external: { guildId: "1" } })).toEqual(
      {
        guildId: "1",
      }
    );
  });
});

// ── U1: origin edge ───────────────────────────────────────────────────────────

describe("channel origin edge", () => {
  it("writes producer --produced--> channel with the declared kind cached", () => {
    expect(
      channelOriginLinkInputs({
        channelId: "chan-1",
        workspaceId: "ws-1",
        origin: {
          producerType: "tool",
          producerId: "tool-1",
          producerName: "Mailgun inbound",
        },
      })
    ).toEqual([
      {
        workspaceId: "ws-1",
        fromType: "tool",
        fromId: "tool-1",
        toType: "channel",
        toId: "chan-1",
        linkType: "produced",
        metadata: { producerKind: "tool", producerName: "Mailgun inbound" },
      },
    ]);
  });

  it("carries a capability producer on the honest `skill` endpoint", () => {
    const [edge] = channelOriginLinkInputs({
      channelId: "chan-1",
      workspaceId: null,
      origin: { producerType: "capability", producerId: "skill-9" },
    });
    expect(edge.fromType).toBe("skill");
    expect(edge.metadata).toEqual({ producerKind: "capability" });
    // …and reads back as the contract's coarse kind.
    expect(producerTypeFromEndpoint(edge.fromType)).toBe("capability");
  });

  it("round-trips every producer kind", () => {
    for (const kind of ["capability", "tool", "source", "agent"] as const) {
      expect(producerTypeFromEndpoint(producerEndpointType(kind))).toBe(kind);
    }
    expect(producerTypeFromEndpoint("playbook")).toBeNull();
  });

  it("emits nothing without a producer id", () => {
    expect(
      channelOriginLinkInputs({
        channelId: "c",
        workspaceId: null,
        origin: { producerType: "tool", producerId: "" },
      })
    ).toEqual([]);
  });
});

// ── U3/U4: binding classifier ─────────────────────────────────────────────────

const CHANNEL = {
  channelId: "chan-1",
  boundEntityId: "ent-1",
  provider: "discord",
};

describe("matchesEventPattern", () => {
  it("mirrors the matcher: exact, trailing wildcard, arity", () => {
    expect(
      matchesEventPattern("external_message.received.completed", undefined)
    ).toBe(false);
    expect(
      matchesEventPattern(
        "external_message.received.completed",
        "external_message.received.completed"
      )
    ).toBe(true);
    expect(
      matchesEventPattern(
        "external_message.received.completed",
        "external_message.*"
      )
    ).toBe(true);
    expect(
      matchesEventPattern("external_message.received.completed", "entity.*")
    ).toBe(false);
    expect(
      matchesEventPattern(
        "external_message.received.completed",
        "external_message.received"
      )
    ).toBe(false);
  });

  it("mirrors the matcher's message.received synthetic alias (both physical events)", () => {
    for (const evt of [
      "external_message.received.completed",
      "channel_message.created.completed",
    ]) {
      expect(matchesEventPattern(evt, "message.received")).toBe(true);
      expect(matchesEventPattern(evt, "message.*")).toBe(true);
      expect(matchesEventPattern(evt, "message.received.*")).toBe(true);
    }
    // The alias covers ONLY the physical message events, nothing else.
    expect(
      matchesEventPattern("entity.create.completed", "message.received")
    ).toBe(false);
  });
});

describe("classifyChannelAutomationBinding", () => {
  it("returns null for a non-message trigger", () => {
    expect(
      classifyChannelAutomationBinding(
        { eventPattern: "entity.create.completed" },
        CHANNEL
      )
    ).toBeNull();
  });

  it("workspace-wide when nothing narrows it", () => {
    expect(
      classifyChannelAutomationBinding(
        { eventPattern: "external_message.received.completed" },
        CHANNEL
      )
    ).toBe("workspace");
  });

  it("counts a message.received-alias automation for the channel (mirror lockstep)", () => {
    // No narrowing → workspace binding, reported for the channel.
    expect(
      classifyChannelAutomationBinding(
        { eventPattern: "message.received" },
        CHANNEL
      )
    ).toBe("workspace");
    // channelId binding composes with the alias.
    expect(
      classifyChannelAutomationBinding(
        { eventPattern: "message.received", channelId: "chan-1" },
        CHANNEL
      )
    ).toBe("channel");
    expect(
      classifyChannelAutomationBinding(
        { eventPattern: "message.received", channelId: "chan-OTHER" },
        CHANNEL
      )
    ).toBeNull();
  });

  it("channel-bound when triggerConfig.channelId matches, excluded when it does not", () => {
    expect(
      classifyChannelAutomationBinding(
        {
          eventPattern: "external_message.*",
          channelId: "chan-1",
        },
        CHANNEL
      )
    ).toBe("channel");
    expect(
      classifyChannelAutomationBinding(
        {
          eventPattern: "external_message.*",
          channelId: "chan-OTHER",
        },
        CHANNEL
      )
    ).toBeNull();
  });

  it("entity-bound via filters.entityId; a different entity is excluded", () => {
    expect(
      classifyChannelAutomationBinding(
        {
          eventPattern: "external_message.received.completed",
          filters: { entityId: "ent-1" },
        },
        CHANNEL
      )
    ).toBe("entity");
    expect(
      classifyChannelAutomationBinding(
        {
          eventPattern: "external_message.received.completed",
          filters: { entityId: "ent-2" },
        },
        CHANNEL
      )
    ).toBeNull();
    // An entity filter on an UNBOUND channel can never match.
    expect(
      classifyChannelAutomationBinding(
        {
          eventPattern: "external_message.received.completed",
          filters: { entityId: "ent-1" },
        },
        { ...CHANNEL, boundEntityId: null }
      )
    ).toBeNull();
  });

  it("honors a generic provider/channelId filter the event data carries", () => {
    expect(
      classifyChannelAutomationBinding(
        {
          eventPattern: "external_message.*",
          filters: { provider: "mailgun" },
        },
        CHANNEL
      )
    ).toBeNull();
    expect(
      classifyChannelAutomationBinding(
        {
          eventPattern: "external_message.*",
          filters: { provider: "discord" },
        },
        CHANNEL
      )
    ).toBe("workspace");
  });

  it("keeps a per-MESSAGE filter reportable (it narrows which message, not whether)", () => {
    expect(
      classifyChannelAutomationBinding(
        {
          eventPattern: "external_message.*",
          filters: { participantName: "Ada" },
        },
        CHANNEL
      )
    ).toBe("workspace");
  });

  it("also binds in-pod channel_message automations", () => {
    expect(
      classifyChannelAutomationBinding(
        {
          eventPattern: "channel_message.created.completed",
          channelId: "chan-1",
        },
        CHANNEL
      )
    ).toBe("channel");
  });
});

// ── U4/U5: presentation + primary pick ────────────────────────────────────────

describe("summarizeAutomationTrigger", () => {
  it("strips the wildcard/completed tail, falling back to the trigger type", () => {
    expect(
      summarizeAutomationTrigger("event", {
        eventPattern: "external_message.received.completed",
      })
    ).toBe("external_message.received");
    expect(
      summarizeAutomationTrigger("event", {
        eventPattern: "external_message.*",
      })
    ).toBe("external_message");
    expect(summarizeAutomationTrigger("cron", {})).toBe("cron");
    expect(summarizeAutomationTrigger(null, null)).toBeNull();
  });
});

describe("pickPrimaryChannelAutomation", () => {
  const a = (id: string, binding: string, enabled = true) => ({
    id,
    binding,
    enabled,
  });

  it("prefers the most specific binding, enabled first", () => {
    expect(
      pickPrimaryChannelAutomation([
        a("w", "workspace"),
        a("c", "channel"),
        a("e", "entity"),
      ])?.id
    ).toBe("c");
    expect(
      pickPrimaryChannelAutomation([a("w", "workspace"), a("e", "entity")])?.id
    ).toBe("e");
    // A disabled channel binding loses to an enabled workspace one.
    expect(
      pickPrimaryChannelAutomation([
        a("c", "channel", false),
        a("w", "workspace"),
      ])?.id
    ).toBe("w");
    expect(pickPrimaryChannelAutomation([])).toBeNull();
  });
});

// ── U6: source→tool producer resolution precedence ────────────────────────────

describe("pickProducerToolByScope", () => {
  const t = (id: string, workspaceId: string | null) => ({ id, workspaceId });

  it("returns null for no matches (keeps the honest source slug)", () => {
    expect(pickProducerToolByScope([], "ws-1")).toBeNull();
  });

  it("returns the sole match regardless of scope", () => {
    expect(pickProducerToolByScope([t("a", null)], "ws-1")?.id).toBe("a");
    expect(pickProducerToolByScope([t("a", "ws-1")], null)?.id).toBe("a");
  });

  it("a workspace-scoped tool OVERRIDES a pod-wide tool of the same name", () => {
    expect(
      pickProducerToolByScope([t("pod", null), t("ws", "ws-1")], "ws-1")?.id
    ).toBe("ws");
  });

  it("falls back to the sole pod-wide tool when no workspace match", () => {
    expect(
      pickProducerToolByScope([t("pod", null), t("other", "ws-2")], "ws-1")?.id
    ).toBe("pod");
  });

  it("returns null when still ambiguous after precedence (two pod-wide)", () => {
    expect(
      pickProducerToolByScope([t("p1", null), t("p2", null)], "ws-1")
    ).toBeNull();
  });

  it("returns null when two tools share the same workspace", () => {
    expect(
      pickProducerToolByScope([t("w1", "ws-1"), t("w2", "ws-1")], "ws-1")
    ).toBeNull();
  });
});
