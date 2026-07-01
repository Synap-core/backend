/**
 * mirror-to-external — the FORWARD half of the generic Synap↔Discord channel
 * mirror. When a message is inserted into an EXTERNAL channel bound to a Discord
 * channel (channelType='external', externalSource='discord', externalId=<snowflake>),
 * this posts the same content out to Discord via the bot REST API.
 *
 * Lives in `@synap/database` (not `@synap/api`) so every producer can call it:
 * api-side (chat relay) AND jobs-side (automation-executor, feed/mail/event
 * workers) — the dep graph is api→jobs→database.
 *
 * PURE delivery — no message-row insert (the row already exists; that's what
 * triggered the mirror) and no capability re-gate (the message already passed its
 * producer's governance). The reverse half (Discord→Synap) already exists via
 * `/discord/ingest` → `recordInboundMessage`.
 *
 * Guards:
 *   1. ECHO — `authorType='external'` means the message came FROM the platform
 *      (inbound); never push it back out.
 *   2. FIREWALL — bot/AI output (ai_agent|bot) must NEVER reach a `client-comms`
 *      channel (those mirror to the client's own Telegram). A HUMAN operator
 *      message to client-comms IS the intended operator→client reply, allowed.
 */

import { getDb } from "../client-pg.js";
import { channels, ChannelType } from "../schema/channels.js";
import { MessageAuthorType } from "../schema/messages.js";
import { eq } from "drizzle-orm";
import { createLogger } from "@synap-core/core";
import {
  resolveDiscordBotToken,
  postDiscordChannelMessage,
} from "./discord-rest.js";

const logger = createLogger({ module: "mirror-to-external" });

/** The channel fields the mirror needs. Pass the row to skip a lookup. */
export interface MirrorChannelRef {
  channelType: string;
  externalSource: string | null;
  externalId: string | null;
  externalChannelId?: string | null;
  branchPurpose: string | null;
  workspaceId?: string | null;
}

export interface MirrorMessageParams {
  /** The channel row (preferred — avoids a query). */
  channel?: MirrorChannelRef;
  /** Channel id to look up when `channel` is not provided. */
  channelId?: string;
  /** The message content to mirror. */
  content: string;
  /** authorType of the inserted message — drives the echo + firewall guards. */
  authorType: string;
  /** Optional pod-owner override for bot-token resolution. */
  ownerId?: string;
}

export interface MirrorResult {
  mirrored: boolean;
  reason?: string;
}

/**
 * Mirror a just-inserted channel message out to its bound external platform.
 * Never throws — a mirror failure must never break the producer that inserted
 * the message. Returns a structured result for logging/tests.
 */
export async function mirrorMessageToBoundExternal(
  params: MirrorMessageParams
): Promise<MirrorResult> {
  const { content, authorType } = params;
  if (!content) return { mirrored: false, reason: "empty_content" };

  // (1) ECHO guard — inbound-origin messages are never re-mirrored.
  if (authorType === MessageAuthorType.EXTERNAL) {
    return { mirrored: false, reason: "inbound_origin" };
  }

  let channel = params.channel;
  if (!channel && params.channelId) {
    const database = await getDb();
    const row = await database.query.channels.findFirst({
      where: eq(channels.id, params.channelId),
      columns: {
        channelType: true,
        externalSource: true,
        externalId: true,
        externalChannelId: true,
        branchPurpose: true,
        workspaceId: true,
      },
    });
    channel = row ?? undefined;
  }
  if (!channel) return { mirrored: false, reason: "no_channel" };

  // Only EXTERNAL channels with a resolved external identity mirror.
  if (channel.channelType !== ChannelType.EXTERNAL) {
    return { mirrored: false, reason: "not_external" };
  }
  const externalId = channel.externalId ?? channel.externalChannelId ?? null;
  if (!channel.externalSource || !externalId) {
    return { mirrored: false, reason: "no_external_id" };
  }

  // (2) FIREWALL — bot/AI output must never reach a client-comms channel.
  const isBotOrAI =
    authorType === MessageAuthorType.AI_AGENT ||
    authorType === MessageAuthorType.BOT;
  if (channel.branchPurpose === "client-comms" && isBotOrAI) {
    logger.warn(
      { externalSource: channel.externalSource, externalId, authorType },
      "mirror blocked: bot/AI output must not reach a client-comms channel"
    );
    return { mirrored: false, reason: "blocked_client_comms" };
  }

  // Only Discord is a server-resolvable mirror target today. Other externalSource
  // values (telegram/whatsapp/gmail via Unipile) send through the api messaging
  // path, not this fire-and-forget mirror.
  if (channel.externalSource !== "discord") {
    return {
      mirrored: false,
      reason: `unsupported_provider:${channel.externalSource}`,
    };
  }

  // ownerId override is optional; otherwise the resolver uses the pod owner.
  const token = await resolveDiscordBotToken(params.ownerId);
  if (!token) return { mirrored: false, reason: "no_bot_token" };

  try {
    await postDiscordChannelMessage(token, externalId, content);
    return { mirrored: true };
  } catch (err) {
    logger.warn(
      { err, externalSource: channel.externalSource, externalId },
      "mirror send failed"
    );
    return {
      mirrored: false,
      reason: err instanceof Error ? err.message : "send_failed",
    };
  }
}
