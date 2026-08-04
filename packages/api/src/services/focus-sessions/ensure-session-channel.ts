/**
 * Ensure a focus session has a work channel (session room).
 *
 * Gate 2 / session-spine: ad-hoc createFocusSession historically left channelId
 * null; only runPlaybook minted a room. One helper keeps both doors consistent.
 *
 * Idempotent: if session.channelId is already set, returns it. Collision with
 * the partial unique "one active session per channel" is avoided by creating a
 * fresh thread bound to this session as contextObject.
 */
import {
  db,
  focusSessions,
  channels,
  ChannelScope,
  ChannelStatus,
  ChannelType,
  eq,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({
  module: "focus-sessions/ensure-session-channel",
});

export async function ensureSessionChannel(args: {
  sessionId: string;
  userId: string;
  workspaceId?: string | null;
  goal?: string | null;
}): Promise<string | null> {
  const session = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, args.sessionId),
    columns: { id: true, channelId: true, goal: true, workspaceId: true },
  });
  if (!session) return null;
  if (session.channelId) return session.channelId;

  const workspaceId = args.workspaceId ?? session.workspaceId ?? null;
  const title =
    (args.goal ?? session.goal)?.slice(0, 120).trim() || "Work session";

  try {
    const [channel] = await db
      .insert(channels)
      .values({
        userId: args.userId,
        workspaceId,
        channelType: ChannelType.THREAD,
        // Workspace-scoped when we have a home; otherwise pod-wide room.
        scope: workspaceId ? ChannelScope.WORKSPACE : ChannelScope.POD,
        status: ChannelStatus.ACTIVE,
        title,
        contextObjectType: "focus_session",
        contextObjectId: session.id,
        metadata: {
          origin: "focus-session-create",
          sessionId: session.id,
        },
      })
      .returning({ id: channels.id });

    if (!channel?.id) return null;

    await db
      .update(focusSessions)
      .set({ channelId: channel.id })
      .where(eq(focusSessions.id, session.id));

    return channel.id;
  } catch (err) {
    // Best-effort: session without room is worse UX but must not fail create.
    logger.warn(
      { err, sessionId: args.sessionId },
      "ensureSessionChannel: failed to mint session room"
    );
    return null;
  }
}
