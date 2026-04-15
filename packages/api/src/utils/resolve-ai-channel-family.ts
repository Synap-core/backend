import { TRPCError } from "@trpc/server";
import { db, and, desc, eq } from "@synap/database";
import {
  channels,
  ChannelAgentType,
  ChannelStatus,
  ChannelType,
  ThreadKind,
} from "@synap/database/schema";
import type { Channel } from "@synap/database/schema";
import type { AIChannelFamily } from "@synap-core/types";
import { ensurePersonalChannel } from "./personal-channel.js";
import { randomUUID } from "crypto";

export type ContextObjectType = "entity" | "document" | "view";

interface ResolveAiChannelByFamilyParams {
  userId: string;
  workspaceId?: string;
  family: AIChannelFamily;
  contextObjectId?: string;
  contextObjectType?: ContextObjectType;
  parentChannelId?: string;
  branchPurpose?: string;
  agentType?: string;
}

export async function resolveAiChannelByFamily(
  params: ResolveAiChannelByFamilyParams
): Promise<Channel> {
  const {
    userId,
    workspaceId,
    family,
    contextObjectId,
    contextObjectType,
    parentChannelId,
    branchPurpose,
    agentType,
  } = params;

  if (family === "personal") {
    return ensurePersonalChannel(userId, workspaceId);
  }

  if (!workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "workspaceId is required for non-personal channel family",
    });
  }

  if (family === "branch") {
    if (!parentChannelId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "parentChannelId is required for branch family",
      });
    }

    const parent = await db.query.channels.findFirst({
      where: and(
        eq(channels.id, parentChannelId),
        eq(channels.userId, userId),
        eq(channels.status, ChannelStatus.ACTIVE)
      ),
    });

    if (!parent) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Parent channel not found",
      });
    }

    const [branch] = await db
      .insert(channels)
      .values({
        id: randomUUID(),
        userId,
        workspaceId,
        parentChannelId,
        branchPurpose: branchPurpose ?? "Branch from personal AI",
        agentId: "orchestrator",
        agentType: agentType ?? ChannelAgentType.META,
        channelType: ChannelType.THREAD,
        threadKind: ThreadKind.BRANCH,
        status: ChannelStatus.ACTIVE,
        metadata: { origin: "family:branch" },
      })
      .returning();

    return branch;
  }

  if (family !== "context") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Unsupported channel family for resolver",
    });
  }

  if (!contextObjectId || !contextObjectType) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "contextObjectId and contextObjectType are required for context family",
    });
  }

  const mappedThreadKind =
    contextObjectType === "entity"
      ? ThreadKind.ENTITY
      : contextObjectType === "document"
        ? ThreadKind.DOCUMENT
        : ThreadKind.VIEW;

  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.workspaceId, workspaceId),
      eq(channels.channelType, ChannelType.THREAD),
      eq(channels.threadKind, mappedThreadKind),
      eq(channels.contextObjectId, contextObjectId),
      eq(channels.contextObjectType, contextObjectType),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
    orderBy: [desc(channels.updatedAt)],
  });

  if (existing) {
    return existing;
  }

  const [created] = await db
    .insert(channels)
    .values({
      id: randomUUID(),
      userId,
      workspaceId,
      channelType: ChannelType.THREAD,
      threadKind: mappedThreadKind,
      contextObjectId,
      contextObjectType,
      status: ChannelStatus.ACTIVE,
      agentId: "orchestrator",
      agentType: agentType ?? ChannelAgentType.META,
      metadata: { origin: "family:context" },
    })
    .returning();

  return created;
}
