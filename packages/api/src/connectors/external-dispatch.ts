/**
 * Shared external-action dispatcher — ONE implementation, two entry doors:
 *   1. Human-direct (immediate REST — operator IS the approval)
 *   2. Agent-approved (proposals.ts approve branch — proposal already past governance)
 *
 * Extracted here so the immediate hub paths and the proposal-approval path call
 * the SAME connector.sendMessage / connector.triggerAction — no duplicate sends,
 * no implementation drift.
 */

import { createHash } from "crypto";
import { and, eq } from "@synap/database";
import {
  db,
  messages,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database";
import { channels, ChannelType } from "@synap/database/schema";
import { getMessagingConnector } from "./index.js";
import { syncConnectorRegistry } from "./SyncConnector.js";
import type { NangoConnector } from "./NangoConnector.js";

// ── External messaging send ──────────────────────────────────────────────────

export interface SendExternalMessageInput {
  /** The conversation thread id (external platform id). */
  threadId: string;
  /** The account that sends (Unipile/Stalwart account id). */
  accountId: string;
  /** Message body. */
  body: string;
  /** The user performing the send. */
  userId: string;
}

export interface SendExternalMessageResult {
  success: boolean;
  /** The sent message row id, when successfully mirrored. */
  messageId?: string;
  /**
   * External platform message id — recorded by the proposal-approval path into
   * `proposal.data.materialized` so a retry is a no-op.
   */
  externalId?: string;
}

/**
 * Send a message through the correct messaging connector (Unipile for LinkedIn /
 * WhatsApp / Gmail, Stalwart for self-hosted email), then mirror the outbound
 * message into the DB inbox so the conversation history is complete.
 */
export async function sendExternalMessage(
  input: SendExternalMessageInput
): Promise<SendExternalMessageResult> {
  const { threadId, accountId, body, userId } = input;

  // Resolve the EXTERNAL channel to route to the correct connector provider
  // (stalwart vs unipile vs gmail). Same resolution the immediate REST path
  // already does.
  const linkedChannel = await db.query.channels.findFirst({
    where: and(
      eq(channels.channelType, ChannelType.EXTERNAL),
      eq(channels.externalId as any, threadId)
    ),
    columns: { id: true, externalSource: true },
  });

  const connector = await getMessagingConnector(
    linkedChannel?.externalSource ?? undefined
  );
  if (!connector) {
    return { success: false };
  }

  await connector.sendMessage(accountId, threadId, body);

  // Mirror the outbound message into the messages table.
  let messageId: string | undefined;
  if (linkedChannel) {
    const msgHash = createHash("sha256")
      .update(`outbound:${threadId}:${Date.now()}:${body}`)
      .digest("hex");

    const [msg] = await db
      .insert(messages)
      .values({
        channelId: linkedChannel.id,
        userId,
        role: MessageRole.USER,
        authorType: MessageAuthorType.HUMAN,
        messageCategory: MessageCategory.CHAT,
        content: body,
        hash: msgHash,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });

    messageId = msg?.id;
  }

  return { success: true, messageId };
}

// ── External connector action trigger (Nango) ───────────────────────────────

export interface TriggerConnectorActionInput {
  connectionId: string;
  providerConfigKey: string;
  actionName: string;
  input?: Record<string, unknown>;
}

export interface TriggerConnectorActionResult {
  success: boolean;
  result?: unknown;
}

/**
 * Trigger a pre-defined Nango action (write to an integration through a user's
 * connected account). Actions are defined in the Nango integration config;
 * there is no generic proxy() — only named actions work.
 */
export async function triggerConnectorAction(
  input: TriggerConnectorActionInput
): Promise<TriggerConnectorActionResult> {
  const connector = syncConnectorRegistry.get("nango") as
    | NangoConnector
    | undefined;
  if (!connector || !connector.isConfigured()) {
    return { success: false };
  }

  const {
    connectionId,
    providerConfigKey,
    actionName,
    input: actionInput,
  } = input;
  const result = await connector.triggerAction({
    connectionId,
    providerConfigKey,
    actionName,
    input: actionInput ?? {},
  });

  return { success: true, result };
}
