/**
 * resolve-or-create-channel — V2 channelType vocabulary.
 *
 * Replaces `resolveAiChannelByFamily()` (kept temporarily for backward compat).
 * Speaks the spec's channel-type vocabulary directly:
 *   personal | thread | sub_thread | feed | external | agent_collab
 *
 * Branches on `channelType`:
 *   PERSONAL    → ensureAgentThread(userId, agentId) — pod-wide AI thread
 *                 (agentSlug resolves to UUID with orchestrator fallback).
 *   THREAD      → workspace context → ensureWorkspaceGroupChannel
 *                 entity/document/view/project/task → upsert per
 *                 (userId, workspaceId, contextObjectType, contextObjectId)
 *   SUB_THREAD  → create child of `parentChannelId` (required) with
 *                 branchPurpose. AI always active for sub-threads.
 *   FEED        → ensureProactiveFeedChannel (feedScope=user)
 *   EXTERNAL    → not bootstrapped here — external channels are upserted by
 *                 sidecar connectors. Throws BAD_REQUEST.
 *   AGENT_COLLAB→ not bootstrapped here — created via createAgentCollabChannel
 *                 procedure (admin-gated). Throws BAD_REQUEST.
 *
 * New rows are written with `channelType` only — `threadKind` is left null
 * (the column was dropped in migration 0010 anyway).
 *
 * Spec: synap-team-docs/content/team/platform/channel-system.mdx
 */

import { TRPCError } from "@trpc/server";
import { db, and, desc, eq } from "@synap/database";
import {
  channels,
  ChannelStatus,
  ChannelType,
  agents,
  type Channel,
} from "@synap/database/schema";
import {
  ensureAgentThread,
  ensureWorkspaceGroupChannel,
  ensureProactiveFeedChannel,
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

export type ContextObjectType =
  | "workspace"
  | "entity"
  | "document"
  | "view"
  | "project"
  | "task"
  | "user"
  | "external";

export const CONTEXT_OBJECT_TYPE_VALUES = [
  "workspace",
  "entity",
  "document",
  "view",
  "project",
  "task",
  "user",
  "external",
] as const satisfies ReadonlyArray<ContextObjectType>;

export interface ResolveOrCreateChannelParams {
  userId: string;
  channelType:
    | typeof ChannelType.PERSONAL
    | typeof ChannelType.THREAD
    | typeof ChannelType.SUB_THREAD
    | typeof ChannelType.FEED
    | typeof ChannelType.EXTERNAL
    | typeof ChannelType.AGENT_COLLAB;
  workspaceId?: string;
  /** Agent UUID — preferred over agentSlug for personal channels. */
  agentId?: string;
  /** Agent slug — used as fallback; resolves to "orchestrator" if unknown. */
  agentSlug?: string;
  contextObjectType?: ContextObjectType;
  contextObjectId?: string;
  /** Required for SUB_THREAD. */
  parentChannelId?: string;
  /** Optional task description for SUB_THREAD. */
  branchPurpose?: string;
}

/**
 * Resolve or create a channel based on its canonical type.
 * Returns the channel row (existing or newly inserted).
 */
export async function resolveOrCreateChannel(
  params: ResolveOrCreateChannelParams
): Promise<Channel> {
  const {
    userId,
    channelType,
    workspaceId,
    agentId,
    agentSlug,
    contextObjectType,
    contextObjectId,
    parentChannelId,
    branchPurpose,
  } = params;

  // ── PERSONAL ───────────────────────────────────────────────────────────────
  if (channelType === ChannelType.PERSONAL) {
    const resolvedAgentId =
      agentId ??
      (agentSlug
        ? ((await resolveSlugToAgentId(agentSlug)) ??
          (await resolveSlugToAgentId("orchestrator")))
        : await resolveSlugToAgentId("orchestrator"));
    if (!resolvedAgentId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          'agentId or agentSlug is required for channelType="personal" (orchestrator fallback failed)',
      });
    }
    return ensureAgentThread(userId, resolvedAgentId);
  }

  // ── FEED ───────────────────────────────────────────────────────────────────
  if (channelType === ChannelType.FEED) {
    return ensureProactiveFeedChannel(userId, workspaceId);
  }

  // ── SUB_THREAD ─────────────────────────────────────────────────────────────
  if (channelType === ChannelType.SUB_THREAD) {
    if (!parentChannelId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: 'parentChannelId is required for channelType="sub_thread"',
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

    const orchestratorAgentId = agentSlug
      ? ((await resolveSlugToAgentId(agentSlug)) ??
        (await resolveSlugToAgentId("orchestrator")))
      : await resolveSlugToAgentId("orchestrator");

    const [branch] = await db
      .insert(channels)
      .values({
        id: randomUUID(),
        userId,
        workspaceId: workspaceId ?? parent.workspaceId ?? null,
        parentChannelId,
        branchPurpose: branchPurpose ?? "Branch",
        assignedAgentId: orchestratorAgentId,
        channelType: ChannelType.SUB_THREAD,
        status: ChannelStatus.ACTIVE,
        metadata: { origin: "resolveOrCreateChannel:sub_thread" },
      })
      .returning();

    return branch;
  }

  // ── THREAD ─────────────────────────────────────────────────────────────────
  if (channelType === ChannelType.THREAD) {
    if (!workspaceId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: 'workspaceId is required for channelType="thread"',
      });
    }

    // Workspace thread — one per (userId, workspaceId)
    if (!contextObjectType || contextObjectType === "workspace") {
      return ensureWorkspaceGroupChannel(userId, workspaceId);
    }

    if (!contextObjectId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "contextObjectId is required when contextObjectType is set on a thread",
      });
    }

    const orchestratorAgentId = agentSlug
      ? ((await resolveSlugToAgentId(agentSlug)) ??
        (await resolveSlugToAgentId("orchestrator")))
      : await resolveSlugToAgentId("orchestrator");

    // Upsert per (userId, workspaceId, contextObjectType, contextObjectId)
    const existing = await db.query.channels.findFirst({
      where: and(
        eq(channels.userId, userId),
        eq(channels.workspaceId, workspaceId),
        eq(channels.channelType, ChannelType.THREAD),
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
        contextObjectId,
        contextObjectType,
        status: ChannelStatus.ACTIVE,
        assignedAgentId: orchestratorAgentId,
        metadata: { origin: "resolveOrCreateChannel:thread" },
      })
      .returning();

    return created;
  }

  // ── EXTERNAL / AGENT_COLLAB — not bootstrapped via this util ───────────────
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `channelType="${channelType}" is not bootstrapped via resolveOrCreateChannel — use the dedicated create procedure.`,
  });
}

/**
 * Translate the legacy `aiChannelFamily` enum into the V2 channelType + context
 * tuple that `resolveOrCreateChannel` expects. The `family` vocabulary is kept
 * on public APIs for backward compatibility with existing frontends; this
 * helper is the single boundary that maps it into the canonical model.
 */
export type LegacyChannelFamily =
  | "agent"
  | "workspace_group"
  | "context"
  | "branch";

export function mapLegacyFamily(args: {
  family: LegacyChannelFamily;
  workspaceId?: string;
  contextObjectType?: ContextObjectType;
  contextObjectId?: string;
}): Pick<
  ResolveOrCreateChannelParams,
  "channelType" | "contextObjectType" | "contextObjectId"
> {
  switch (args.family) {
    case "agent":
      return { channelType: ChannelType.PERSONAL };
    case "workspace_group":
      return {
        channelType: ChannelType.THREAD,
        contextObjectType: "workspace",
        contextObjectId: args.workspaceId,
      };
    case "branch":
      return { channelType: ChannelType.SUB_THREAD };
    case "context":
      return {
        channelType: ChannelType.THREAD,
        contextObjectType: args.contextObjectType,
        contextObjectId: args.contextObjectId,
      };
  }
}
