/**
 * resolve-or-create-channel — V2 channelType vocabulary.
 *
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
import { db, and, desc, eq, resolveProjectPlacement } from "@synap/database";
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
import { ensureExternalChannel } from "@synap/database";
import {
  recordChannelOrigin,
  type ChannelOrigin,
} from "../services/channels/channel-origin.js";
import { assertProposalVisibleTo } from "./proposal-visibility.js";
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
  | "external"
  // A pending proposal — the target of an on-demand "discuss/refine this
  // proposal with the AI" thread (one dedup'd thread per proposal). The channel
  // binds to the proposal so getThreadContext can hydrate it into the prompt.
  | "proposal";

export const CONTEXT_OBJECT_TYPE_VALUES = [
  "workspace",
  "entity",
  "document",
  "view",
  "project",
  "task",
  "user",
  "external",
  "proposal",
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
  /** Project lens tag for directly-created channels (sub_thread/thread). */
  projectId?: string;
  /** Required for SUB_THREAD. */
  parentChannelId?: string;
  /** Optional task description for SUB_THREAD; firewall role for EXTERNAL. */
  branchPurpose?: string;
  /** Required for EXTERNAL — the connector provider (e.g. 'discord'). */
  externalSource?: string;
  /** Required for EXTERNAL — the provider's channel id. */
  externalId?: string;
  /** Optional title for EXTERNAL channels. */
  title?: string;
  /**
   * WHO is creating this channel. Recorded as a `producer --produced--> channel`
   * edge at BIRTH only (services/channels/channel-origin.ts). `ensureExternalChannel`
   * lives in @synap/database and cannot reach the api-side `createLinks` one
   * door, so this api-side wrapper stamps the edge using the `created` flag that
   * door already returns.
   */
  origin?: ChannelOrigin;
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
    projectId,
    parentChannelId,
    branchPurpose,
    externalSource,
    externalId,
    title,
    origin,
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

    // PROJECT LENS — a branch of a project-tagged room belongs to that project.
    // Rung 3 (bound channel) of the deterministic ladder, asked with the parent
    // this door already loaded. An explicit `projectId` is rung 1 and still
    // wins; no context → NULL, never a guess.
    const branchPlacement = await resolveProjectPlacement(db, {
      userId,
      explicitProjectId: projectId ?? null,
      channelId: parentChannelId,
    });

    const [branch] = await db
      .insert(channels)
      .values({
        id: randomUUID(),
        userId,
        workspaceId: workspaceId ?? parent.workspaceId ?? null,
        projectId: branchPlacement.projectId,
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

    // SECURITY (IDOR chokepoint) — a "proposal" thread binds the channel to its
    // primary contextObject, which `hub-protocol/context.ts` later hydrates into
    // the AI prompt (renderProposalForPrompt). Without a gate here, a guessed
    // proposal UUID → blind upsert → attacker-owned channel → the proposal's
    // contents leak into the prompt. Gate the bind on the SAME visibility the
    // Studio proposal-detail page enforces, so a user can only open a discuss
    // thread for a proposal they may already see. (entity/document/view bind from
    // separately-authorized channel_context_items and are inert here.)
    if (contextObjectType === "proposal") {
      await assertProposalVisibleTo(contextObjectId, userId);
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

    // PROJECT LENS — a thread ABOUT an entity belongs to that entity's project.
    // Rung 4 (relational gravity) with exactly ONE bounded id, so the ladder's
    // strict-majority test degenerates to "the subject's own project, if it has
    // exactly one"; an entity in two projects is a tie and abstains. Only an
    // `entity` context object is passed — a proposal/document/view id is not an
    // entity id and feeding it in would be fabricating an input.
    const threadPlacement = await resolveProjectPlacement(db, {
      userId,
      explicitProjectId: projectId ?? null,
      ...(contextObjectType === "entity"
        ? { relatedEntityIds: [contextObjectId] }
        : {}),
    });

    const [created] = await db
      .insert(channels)
      .values({
        id: randomUUID(),
        userId,
        workspaceId,
        projectId: threadPlacement.projectId,
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

  // ── EXTERNAL — delegate to the race-safe ensureExternalChannel door ─────────
  if (channelType === ChannelType.EXTERNAL) {
    if (!externalSource || !externalId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          'externalSource and externalId are required for channelType="external"',
      });
    }
    // ONE external door: race-safe upsert on (externalSource, externalId), plus
    // firewall-role + subject-binding upgrades. Bind at birth when the caller
    // supplies the subject (contextObjectId), so a Discord/Telegram channel lands
    // linked to its real-world entity instead of orphaned.
    const { channelId, created } = await ensureExternalChannel({
      provider: externalSource,
      externalId,
      userId,
      workspaceId: workspaceId ?? null,
      title,
      branchPurpose,
      contextObjectType,
      contextObjectId,
    });
    if (created && origin) {
      await recordChannelOrigin({
        channelId,
        workspaceId: workspaceId ?? null,
        origin,
      });
    }
    const channel = await db.query.channels.findFirst({
      where: eq(channels.id, channelId),
    });
    if (!channel) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "External channel vanished immediately after resolve",
      });
    }
    return channel;
  }

  // ── AGENT_COLLAB — not bootstrapped via this util ──────────────────────────
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `channelType="${channelType}" is not bootstrapped via resolveOrCreateChannel — use the dedicated create procedure (createAgentCollabChannel).`,
  });
}
