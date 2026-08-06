/**
 * openProcessChannel — ensure a RUN channel for a live process and seed it with
 * narrative messages (user capture, system status, follow-up questions, chips).
 *
 * Companion opens this channelId; system posts narrate progress; a later user
 * free-text message flips into a real agent turn (trigger-auto-respond treats
 * RUN as IS-eligible).
 */

import { randomUUID } from "crypto";
import {
  db,
  messages,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
  computeMessageHash,
  ChannelRepository,
  type Channel,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";
import { EventNames } from "@synap-core/types/events";
import { deterministicUuidFromKey } from "../../utils/write-door-idempotency.js";

const logger = createLogger({ module: "open-process-channel" });

export type ProcessSeedRole = "user" | "system" | "assistant";

export interface ProcessSeedMessage {
  role: ProcessSeedRole;
  content: string;
  /** Optional metadata (chips, kind: follow_up, partial proposals, …). */
  metadata?: Record<string, unknown>;
  /**
   * Stable idempotency key for this seed line (retries don't duplicate).
   * Defaults to `${flowType}:${flowId}:seed:${index}`.
   */
  idempotencyKey?: string;
}

export interface OpenProcessChannelParams {
  userId: string;
  /** Process kind — stored as contextObjectType (e.g. "capture", "import"). */
  flowType: string;
  /**
   * Stable id for this process instance. Callers that don't have one yet should
   * pass a fresh UUID and keep it for the session.
   */
  flowId: string;
  workspaceId?: string | null;
  title?: string;
  seedMessages?: ProcessSeedMessage[];
  /** Extra metadata merged onto the channel (partial proposals, etc.). */
  channelMetadata?: Record<string, unknown>;
}

export interface OpenProcessChannelResult {
  channel: Channel;
  created: boolean;
  messageIds: string[];
}

function seedMessageId(
  channelId: string,
  flowType: string,
  flowId: string,
  index: number,
  explicitKey?: string
): string {
  const key =
    explicitKey?.trim() || `process-seed:${flowType}:${flowId}:${index}`;
  return deterministicUuidFromKey(`open_process:${channelId}:${key}`);
}

async function insertSeedMessage(params: {
  id: string;
  channelId: string;
  userId: string;
  role: ProcessSeedRole;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; inserted: boolean }> {
  const roleEnum =
    params.role === "user"
      ? MessageRole.USER
      : params.role === "system"
        ? MessageRole.SYSTEM
        : MessageRole.ASSISTANT;
  const authorType =
    params.role === "user"
      ? MessageAuthorType.HUMAN
      : params.role === "system"
        ? MessageAuthorType.BOT
        : MessageAuthorType.AI_AGENT;
  const messageCategory =
    params.role === "system"
      ? MessageCategory.SYSTEM_NOTIFICATION
      : MessageCategory.CHAT;
  const hash = computeMessageHash(params.id, params.content);

  const inserted = await db
    .insert(messages)
    .values({
      id: params.id,
      channelId: params.channelId,
      role: roleEnum,
      authorType,
      messageCategory,
      content: params.content,
      userId: params.userId,
      hash,
      previousHash: "",
      metadata: params.metadata ?? null,
    })
    .onConflictDoNothing({ target: messages.id })
    .returning({ id: messages.id });

  if (inserted.length === 0) {
    return { id: params.id, inserted: false };
  }

  emitChatEvent({
    event: EventNames.CHAT_MESSAGE,
    data: {
      threadId: params.channelId,
      message: {
        id: params.id,
        threadId: params.channelId,
        role: roleEnum,
        authorType,
        content: params.content,
        userId: params.userId,
        timestamp: new Date(),
        previousHash: "",
        hash,
        metadata: params.metadata ?? undefined,
      },
      userId: params.userId,
    },
    workspaceId: null,
    userId: params.userId,
    channelId: params.channelId,
  });

  return { id: params.id, inserted: true };
}

/**
 * Ensure a RUN channel for (flowType, flowId) and seed narrative messages.
 * Idempotent on channel + per-seed message ids.
 */
export async function openProcessChannel(
  params: OpenProcessChannelParams
): Promise<OpenProcessChannelResult> {
  const flowType = params.flowType.trim();
  const flowId = params.flowId.trim();
  if (!flowType || !flowId) {
    throw new Error("openProcessChannel requires flowType and flowId");
  }

  const repo = new ChannelRepository(db);
  const existing = await repo.findRunChannel(flowType, flowId);
  const channel = await repo.ensureRunChannel(flowType, flowId, params.userId, {
    workspaceId: params.workspaceId ?? undefined,
    title: params.title,
    metadata: params.channelMetadata,
  });
  const created = !existing;

  if (created) {
    emitChatEvent({
      event: "channel:created",
      data: { channelId: channel.id, userId: params.userId },
      userId: params.userId,
      channelId: channel.id,
    });
  }

  const messageIds: string[] = [];
  const seeds = params.seedMessages ?? [];
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    if (!seed?.content?.trim()) continue;
    const id = seedMessageId(
      channel.id,
      flowType,
      flowId,
      i,
      seed.idempotencyKey
    );
    try {
      const result = await insertSeedMessage({
        id,
        channelId: channel.id,
        userId: params.userId,
        role: seed.role,
        content: seed.content.trim(),
        metadata: seed.metadata,
      });
      messageIds.push(result.id);
    } catch (err) {
      logger.error(
        { err, channelId: channel.id, index: i },
        "failed to insert process seed message"
      );
      throw err;
    }
  }

  return { channel, created, messageIds };
}

/** Convenience: mint a flow id when the caller has no correlation id yet. */
export function newProcessFlowId(): string {
  return randomUUID();
}
