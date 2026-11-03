/**
 * Where a chat turn goes: the workspace and the channel a streaming chat route
 * (`POST /api/chat/stream`, `POST /api/external/chat/stream`) sends a turn to.
 *
 * ONE resolver for both routes: neither keeps its own copy. An explicit
 * `channelId` is never resolved by id alone. The read floor
 * (`channelVisibilityWhere`) is what refuses a channel with no workspace (a
 * personal agent thread) that is not the caller's, since the
 * workspace-membership check runs only when the channel has a workspace.
 *
 * Rules:
 *  - `workspaceId` given: the caller must be a member. Absent: the caller's
 *    default workspace (`findUserDefaultWorkspaceId`, the ONE fallback).
 *  - `channelId` given: the channel must be ACTIVE and visible to the caller
 *    (the canonical grant-aware read floor), and when it lives in a workspace
 *    the caller must be a member of it. Any refusal is "Channel not found"
 *    (404), never 403: a refusal does not reveal that the channel exists.
 *  - `channelId` absent: the caller's personal thread with the default agent
 *    (`ensureAgentThread`, created on first use).
 */
import { and, eq, type db as Db } from "@synap/database";
import {
  channels,
  ChannelStatus,
  workspaceMembers,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { channelVisibilityWhere } from "./channel-visibility.js";
import { ensureAgentThread, getAgentIdBySlug } from "./personal-channel.js";
import { findUserDefaultWorkspaceId } from "./user-default-workspace.js";

const logger = createLogger({ module: "resolve-chat-target" });

export type ChatTargetFailure =
  | "workspace_denied"
  | "no_workspace"
  | "channel_not_found"
  | "no_default_agent"
  | "thread_failed";

export type ChatTarget =
  | { ok: true; workspaceId: string; channelId: string }
  | {
      ok: false;
      reason: ChatTargetFailure;
      status: 404 | 500;
      error: string;
    };

const FAILURES: Record<
  ChatTargetFailure,
  { status: 404 | 500; error: string }
> = {
  workspace_denied: {
    status: 404,
    error: "Workspace not found or access denied",
  },
  no_workspace: { status: 404, error: "No workspace found for this user" },
  channel_not_found: { status: 404, error: "Channel not found" },
  no_default_agent: { status: 500, error: "Failed to resolve chat channel" },
  thread_failed: { status: 500, error: "Failed to resolve chat channel" },
};

function refuse(reason: ChatTargetFailure): ChatTarget {
  return { ok: false, reason, ...FAILURES[reason] };
}

async function isWorkspaceMember(
  database: typeof Db,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const membership = await database.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    columns: { workspaceId: true },
  });
  return Boolean(membership);
}

export async function resolveChatTarget(
  database: typeof Db,
  userId: string,
  input: { workspaceId?: string; channelId?: string }
): Promise<ChatTarget> {
  let workspaceId: string;
  if (input.workspaceId) {
    if (!(await isWorkspaceMember(database, input.workspaceId, userId))) {
      return refuse("workspace_denied");
    }
    workspaceId = input.workspaceId;
  } else {
    // D7: never the pod-admin console, never archived (the ONE fallback).
    const fallback = await findUserDefaultWorkspaceId(database, userId);
    if (!fallback) return refuse("no_workspace");
    workspaceId = fallback;
  }

  if (input.channelId) {
    const channel = await database.query.channels.findFirst({
      where: and(
        eq(channels.id, input.channelId),
        eq(channels.status, ChannelStatus.ACTIVE),
        channelVisibilityWhere(userId)
      ),
      columns: { id: true, workspaceId: true },
    });
    if (!channel) return refuse("channel_not_found");
    if (
      channel.workspaceId &&
      !(await isWorkspaceMember(database, channel.workspaceId, userId))
    ) {
      return refuse("channel_not_found");
    }
    return { ok: true, workspaceId, channelId: channel.id };
  }

  try {
    const orchestratorId = await getAgentIdBySlug("orchestrator");
    if (!orchestratorId) return refuse("no_default_agent");
    const personalChannel = await ensureAgentThread(userId, orchestratorId);
    return { ok: true, workspaceId, channelId: personalChannel.id };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to resolve the default agent thread"
    );
    return refuse("thread_failed");
  }
}
