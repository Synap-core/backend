import { TRPCError } from "@trpc/server";
import { db, and, desc, eq } from "@synap/database";
import {
  channels,
  ChannelStatus,
  ChannelType,
  ThreadKind,
  agents,
  type Channel,
} from "@synap/database/schema";
import type { AIChannelFamily } from "@synap-core/types";
import { ensurePersonalChannel } from "./personal-channel.js";
import { randomUUID } from "crypto";

/**
 * Resolve a slug to a canonical agent UUID by querying the agents table.
 * Returns null if no active agent matches.
 */
async function resolveSlugToAgentId(slug: string): Promise<string | null> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.slug, slug), eq(agents.active, true)))
    .limit(1);
  return agent?.id ?? null;
}

export type ContextObjectType = "entity" | "document" | "view";

interface ResolveAiChannelByFamilyParams {
  userId: string;
  workspaceId?: string;
  family: AIChannelFamily;
  contextObjectId?: string;
  contextObjectType?: ContextObjectType;
  parentChannelId?: string;
  branchPurpose?: string;
  /** Agent slug to assign when creating the channel (e.g. "networking"). Falls back to orchestrator. */
  agentSlug?: string;
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
    agentSlug,
  } = params;

  // Resolve the agent ID: prefer explicit agentSlug, fall back to orchestrator
  const resolvedAgentId = agentSlug
    ? ((await resolveSlugToAgentId(agentSlug)) ??
      (await resolveSlugToAgentId("orchestrator")))
    : await resolveSlugToAgentId("orchestrator");
  // Kept for backward compat — orchestratorAgentId is used in non-personal channel inserts
  const orchestratorAgentId = resolvedAgentId;

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
        assignedAgentId: orchestratorAgentId,
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
      assignedAgentId: orchestratorAgentId,
      metadata: { origin: "family:context" },
    })
    .returning();

  return created;
}
