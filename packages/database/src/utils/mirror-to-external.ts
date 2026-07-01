/**
 * mirror-to-external — the FORWARD half of the generic Synap↔external channel
 * mirror. When a message is inserted into an EXTERNAL channel bound to an
 * external chat channel (channelType='external', externalSource=<provider>,
 * externalId=<channel id>), this ENQUEUES a provider-AGNOSTIC `post_message`
 * egress intent onto the `channel_egress` outbox. It no longer posts to Discord
 * (or any platform) directly — the external bridge consumes the outbox and does
 * the delivery.
 *
 * Lives in `@synap/database` (not `@synap/api`) so every producer can call it:
 * api-side (chat relay) AND jobs-side (automation-executor, feed/mail/event
 * workers) — the dep graph is api→jobs→database.
 *
 * PURE enqueue — no message-row insert (the row already exists; that's what
 * triggered the mirror) and no capability re-gate (the message already passed its
 * producer's governance) and no network I/O. The reverse half (external→Synap)
 * already exists via `/discord/ingest` → `recordInboundMessage`.
 *
 * Guard here:
 *   ECHO — `authorType='external'` means the message came FROM the platform
 *   (inbound); never push it back out.
 *
 * The FIREWALL (bot/AI output must never reach a client-comms channel) now lives
 * in the bridge, which reads `payload.authorType` + `payload.branchPurpose` FACTS
 * off the enqueued intent and drops what it must. This layer only emits facts.
 */

import { getDb } from "../client-pg.js";
import { channels, ChannelType } from "../schema/channels.js";
import { MessageAuthorType } from "../schema/messages.js";
import { eq } from "drizzle-orm";
import { enqueueChannelEgress } from "./channel-egress.js";

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
  /** authorType of the inserted message — drives the echo guard + rides the
   * intent as a FACT the bridge firewall reads. */
  authorType: string;
}

export interface MirrorResult {
  mirrored: boolean;
  reason?: string;
}

/**
 * Mirror a just-inserted channel message out to its bound external platform by
 * ENQUEUEING an agnostic egress intent. Never throws — a mirror failure must
 * never break the producer that inserted the message. Returns a structured
 * result for logging/tests.
 */
export async function mirrorMessageToBoundExternal(
  params: MirrorMessageParams
): Promise<MirrorResult> {
  const { content, authorType } = params;
  if (!content) return { mirrored: false, reason: "empty_content" };

  // ECHO guard — inbound-origin messages are never re-mirrored.
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

  // Only Discord has a bridge that CONSUMES the egress outbox today. Other
  // externalSource values (telegram/whatsapp/gmail via Unipile) deliver through
  // the api messaging path, not this fire-and-forget mirror — enqueuing them here
  // would pile up unconsumed rows and falsely report `mirrored: true`. Restore the
  // provider guard until each source has its own egress consumer. (The outbox row
  // shape stays agnostic; only the mirror's set of sources is gated.)
  if (channel.externalSource !== "discord") {
    return {
      mirrored: false,
      reason: `no_egress_consumer:${channel.externalSource}`,
    };
  }

  // Enqueue an agnostic `post_message` intent. The bridge delivers it and owns
  // the firewall — it reads `authorType` + `branchPurpose` FACTS to decide.
  await enqueueChannelEgress({
    externalSource: channel.externalSource,
    externalId,
    kind: "post_message",
    payload: {
      content,
      authorType,
      branchPurpose: channel.branchPurpose ?? null,
    },
    workspaceId: channel.workspaceId ?? null,
  });
  return { mirrored: true };
}
