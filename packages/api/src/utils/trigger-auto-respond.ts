/**
 * Canonical IS auto-respond kickoff — the ONE path that makes the Intelligence
 * Service respond to a user message in a channel.
 *
 * Resolves the workspace's chat IS endpoint, then enqueues the A2AI_TRIGGER
 * pg-boss job. Extracted from the (previously inline-duplicated) threads.ts
 * postMessage / postMessagesBatch handlers so every caller — REST threads AND
 * the playbook executor (P3) — uses the SAME path, never a side-channel
 * reimplementation (a bare websocket broadcast does NOT enqueue the IS).
 *
 * IS-eligible channels: THREAD / AGENT_COLLAB / PERSONAL. PERSONAL channels are
 * pod-scoped (no workspaceId) — the IS resolves the user's default chat service
 * and runs the turn in personal context (workspaceId omitted, exactly like the
 * interactive `channels.sendMessage` path does for personal channels). This is
 * what makes the documented headless flow (get personal channel → post with
 * triggerAI) actually dispatch instead of silently no-op'ing.
 * Best-effort: the triggering message is already persisted; a failed trigger is
 * logged and swallowed. Returns true iff the job was enqueued.
 */

import { db, eq, and } from "@synap/database";
import { channels, ChannelType, focusSessions } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "trigger-auto-respond" });

export async function triggerAutoRespond(params: {
  channelId: string;
  userMessageId: string;
  content: string;
  /** The principal whose message triggered the response (sourceAgentUserId). */
  sourceUserId?: string | null;
  /** Active focus session ID for this channel — forwarded so the IS wakes up
   *  session-aware and tags all hub calls with X-Session-Id automatically. */
  focusSessionId?: string | null;
}): Promise<boolean> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, params.channelId),
  });
  const isEligibleType =
    channel?.channelType === ChannelType.THREAD ||
    channel?.channelType === ChannelType.AGENT_COLLAB ||
    channel?.channelType === ChannelType.PERSONAL;
  if (!channel || !isEligibleType) {
    return false;
  }
  try {
    // Resolve active focus session if not provided by the caller — the channel
    // may have an explicit user-visible session that the IS needs to know about.
    const resolvedFocusSessionId =
      params.focusSessionId ??
      (
        await db.query.focusSessions.findFirst({
          where: and(
            eq(focusSessions.channelId, params.channelId),
            eq(focusSessions.status, "active")
          ),
          columns: { id: true },
          orderBy: (fs, { desc }) => [desc(fs.startedAt)],
        })
      )?.id;
    const { resolveIntelligenceService } =
      await import("./intelligence-routing.js");
    const { getBoss, A2AI_TRIGGER_QUEUE, A2AI_TRIGGER_JOB_OPTIONS } =
      await import("@synap/jobs");
    const resolvedService = await resolveIntelligenceService({
      userId: channel.userId,
      // PERSONAL channels are pod-scoped (null) → undefined = user-default routing.
      workspaceId: channel.workspaceId ?? undefined,
      capability: "chat",
    });
    await getBoss().send(
      A2AI_TRIGGER_QUEUE,
      {
        channelId: params.channelId,
        userMessageId: params.userMessageId,
        content: params.content,
        userId: channel.userId,
        workspaceId: channel.workspaceId,
        agentType: "meta",
        sourceAgentUserId: params.sourceUserId ?? null,
        focusSessionId: resolvedFocusSessionId,
        serviceUrl: resolvedService.endpoint,
        serviceApiKey: resolvedService.serviceApiKey,
        serviceId: resolvedService.serviceId,
        agentUserId: resolvedService.agentUserId,
      },
      A2AI_TRIGGER_JOB_OPTIONS
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, channelId: params.channelId },
      "triggerAutoRespond failed"
    );
    return false;
  }
}
