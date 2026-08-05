/**
 * Channel deep link — the NATIVE url that opens this conversation in the app it
 * came from (Discord, Telegram, …).
 *
 * CHANNEL-LEVEL only. A message-level permalink needs the native message id AND
 * the same channel coordinates; the channel link is what a user actually wants
 * ("take me to this thread"), and it is derivable from ids the pod already
 * stores, so it ships first. Message-level is deliberately deferred.
 *
 * Pure + total: every input shape either yields a url or `null`. NEVER guess —
 * a Discord channel with no guild id has NO derivable url, and returning a
 * broken link would be worse than returning none.
 */

export type ChannelDeepLinkKind = "discord" | "telegram" | "slack" | "web";

export interface ChannelDeepLink {
  url: string;
  kind: ChannelDeepLinkKind;
}

export interface ChannelDeepLinkInput {
  /** `channels.externalSource` (provider slug). */
  source: string | null | undefined;
  /** `channels.externalChannelId` (the provider's own channel/chat id). */
  externalChannelId: string | null | undefined;
  /** `channels.metadata.external.guildId` — Discord server id. */
  guildId?: string | null;
  /** `channels.metadata.external.teamId` — Slack workspace id, when known. */
  teamId?: string | null;
}

/** Discord/Telegram/Slack ids are digit strings; reject anything else. */
function isNumericId(value: string): boolean {
  return /^-?\d+$/.test(value);
}

/**
 * Build the channel-level native url, or null when the ids on hand cannot
 * produce one.
 *
 *   discord   guildId + channelId → https://discord.com/channels/{guild}/{channel}
 *   telegram  supergroup/channel chat id (-100…) → https://t.me/c/{internal}
 *             @username                          → https://t.me/{username}
 *   slack     teamId + channelId → https://slack.com/app_redirect?channel=…&team=…
 *   *         an https external id IS the link (web/rss-shaped providers)
 */
export function buildChannelDeepLink(
  input: ChannelDeepLinkInput
): ChannelDeepLink | null {
  const source = input.source?.trim().toLowerCase() ?? "";
  const channelId = input.externalChannelId?.trim() ?? "";
  const guildId = input.guildId?.trim() ?? "";
  const teamId = input.teamId?.trim() ?? "";

  // An external id that is already an https url is its own deep link — this is
  // how web/feed-shaped providers key their channels. Checked first so it wins
  // over a provider-specific branch that could not use it anyway.
  if (/^https:\/\//i.test(channelId)) {
    return { url: channelId, kind: "web" };
  }

  if (!channelId) return null;

  if (source === "discord") {
    if (!guildId || !isNumericId(guildId) || !isNumericId(channelId)) {
      // A DM channel (no guild) or an id we never captured — no honest url.
      return null;
    }
    return {
      url: `https://discord.com/channels/${guildId}/${channelId}`,
      kind: "discord",
    };
  }

  if (source === "telegram") {
    if (channelId.startsWith("@")) {
      const handle = channelId.slice(1);
      return handle
        ? { url: `https://t.me/${handle}`, kind: "telegram" }
        : null;
    }
    if (!isNumericId(channelId)) return null;
    // Supergroups/channels are `-100<internalId>`; t.me/c wants the internal id.
    if (channelId.startsWith("-100")) {
      const internal = channelId.slice(4);
      return internal
        ? { url: `https://t.me/c/${internal}`, kind: "telegram" }
        : null;
    }
    // A private 1:1 chat id has no public web url.
    return null;
  }

  if (source === "slack") {
    if (!teamId) return null;
    return {
      url: `https://slack.com/app_redirect?channel=${encodeURIComponent(
        channelId
      )}&team=${encodeURIComponent(teamId)}`,
      kind: "slack",
    };
  }

  return null;
}

/**
 * Read the `external` sub-object off a channel's JSONB metadata. Defensive:
 * `channels.metadata` is untyped (`jsonb`), so every access is guarded.
 */
export function readChannelExternalMetadata(
  metadata: unknown
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return {};
  const external = (metadata as Record<string, unknown>).external;
  if (!external || typeof external !== "object" || Array.isArray(external))
    return {};
  return external as Record<string, unknown>;
}
