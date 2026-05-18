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
import {
  ensureAgentThread,
  ensureWorkspaceGroupChannel,
} from "./personal-channel.js";
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

export type AIChannelFamily =
  | "agent"
  | "workspace_group"
  | "branch"
  | "context";

interface ResolveAiChannelByFamilyParams {
  userId: string;
  workspaceId?: string;
  family: AIChannelFamily;
  /** Agent UUID — required for family="agent" */
  agentId?: string;
  contextObjectId?: string;
  contextObjectType?: ContextObjectType;
  parentChannelId?: string;
  branchPurpose?: string;
  /** Agent slug — used for branch/context families as fallback. */
  agentSlug?: string;
}

export async function resolveAiChannelByFamily(
  params: ResolveAiChannelByFamilyParams
): Promise<Channel> {
  const {
    userId,
    workspaceId,
    family,
    agentId,
    contextObjectId,
    contextObjectType,
    parentChannelId,
    branchPurpose,
    agentSlug,
  } = params;

  // ── Per-agent personal thread ──────────────────────────────────────────────
  if (family === "agent") {
    // Accept either agentId or agentSlug; agentSlug falls back to "orchestrator"
    // when the supplied slug doesn't match an active agent — matches the
    // pattern used below for branch/context families.
    const resolvedAgentId =
      agentId ??
      (agentSlug
        ? ((await resolveSlugToAgentId(agentSlug)) ??
          (await resolveSlugToAgentId("orchestrator")))
        : await resolveSlugToAgentId("orchestrator"));
    if (!resolvedAgentId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: 'agentId or agentSlug is required for family="agent"',
      });
    }
    return ensureAgentThread(userId, resolvedAgentId);
  }

  // ── Workspace group thread ─────────────────────────────────────────────────
  if (family === "workspace_group") {
    if (!workspaceId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: 'workspaceId is required for family="workspace_group"',
      });
    }
    return ensureWorkspaceGroupChannel(userId, workspaceId);
  }

  // ── All remaining families require workspaceId ────────────────────────────
  if (!workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "workspaceId is required for non-personal channel family",
    });
  }

  // Resolve agent for branch/context families
  const orchestratorAgentId = agentSlug
    ? ((await resolveSlugToAgentId(agentSlug)) ??
      (await resolveSlugToAgentId("orchestrator")))
    : await resolveSlugToAgentId("orchestrator");

  // ── Branch thread ──────────────────────────────────────────────────────────
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
        branchPurpose: branchPurpose ?? "Branch",
        assignedAgentId: orchestratorAgentId,
        channelType: ChannelType.THREAD,
        threadKind: ThreadKind.BRANCH,
        status: ChannelStatus.ACTIVE,
        metadata: { origin: "family:branch" },
      })
      .returning();

    return branch;
  }

  // ── Context thread ─────────────────────────────────────────────────────────
  if (family !== "context") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Unsupported channel family",
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

  if (existing) return existing;

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
