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
 * IS-eligible channels: THREAD / AGENT_COLLAB / PERSONAL / RUN, and GROUP only
 * when the caller names the agent (`agentType`). PERSONAL channels
 * are pod-scoped (no workspaceId) — the IS resolves the user's default chat
 * service and runs the turn in personal context (workspaceId omitted, exactly
 * like the interactive `channels.sendMessage` path does for personal channels).
 * RUN channels are live process narration (capture, automation, …): system posts
 * progress; a user free-text flip must still enqueue a real agent turn.
 * Best-effort: the triggering message is already persisted; a failed trigger is
 * logged and swallowed. Returns true iff the job was enqueued.
 */

import { db, eq, and } from "@synap/database";
import {
  channels,
  ChannelType,
  focusSessions,
  messages,
} from "@synap/database/schema";
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
  /**
   * Specialist agent type for the A2AI/IS turn (e.g. workspace-builder).
   * Defaults to "meta" (orchestrator). Parallel dispatch_agent posts this in
   * message metadata so the background job is not always orchestrator.
   */
  agentType?: string | null;
  /**
   * Server-built per-turn context (the SAME `turnContext` contract the
   * interactive door forwards), e.g. the resolved `anchor` of a comment. Never
   * pass a client payload through unvalidated — see `anchored-comment-turn.ts`.
   */
  turnContext?: Record<string, unknown> | null;
}): Promise<boolean> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, params.channelId),
  });
  // A GROUP room (a session room — several humans + agents) is restraint-
  // first: an agent speaks only when SUMMONED. The caller summons by naming the
  // agent (`agentType`) — an @mention the routing engine resolved, an anchored
  // comment, a playbook is-agent step, a delegated output. An un-named trigger
  // (an agent's own post, a generic `triggerAI`) must never wake the room, so
  // the summon check lives HERE, in the one door, not at each caller.
  const summoned =
    typeof params.agentType === "string" && params.agentType.trim() !== "";
  const isEligibleType =
    channel?.channelType === ChannelType.THREAD ||
    channel?.channelType === ChannelType.AGENT_COLLAB ||
    channel?.channelType === ChannelType.PERSONAL ||
    channel?.channelType === ChannelType.RUN ||
    (channel?.channelType === ChannelType.GROUP && summoned);
  if (!channel || !isEligibleType) {
    // LOUD ON PURPOSE. This returned a bare `false` with no log at all, and
    // only 2 of the 6 call sites read the return value — so a user message
    // that never became a turn produced NO error row, NO failed chat_turn, NO
    // history entry, and NO counter anywhere. `agentTurns.completed` only
    // counts turns the IS *started*, so a message dropped here is invisible to
    // that metric too: "the AI is thinking" and "your message went nowhere"
    // were indistinguishable, to the user AND to us.
    // Until every caller reads the boolean, this log is the only evidence the
    // drop happened. Keep it at `warn` and keep it distinguishable from the
    // catch below — the two silent paths have different causes and fixes.
    logger.warn(
      {
        channelId: params.channelId,
        userMessageId: params.userMessageId,
        channelType: channel?.channelType ?? null,
        reason: !channel
          ? "channel_not_found"
          : channel.channelType === ChannelType.GROUP
            ? "group_room_not_summoned"
            : "channel_type_not_is_eligible",
      },
      "triggerAutoRespond skipped — user message will never produce an agent turn"
    );
    return false;
  }
  // A capture clarification part (question / answer) is answered by the
  // capture door, never by an agent turn — whoever posted it. Defense in depth
  // behind `recordCapturePartMessage`, which never calls this door; it also
  // covers an anchored comment aimed at a question block.
  const triggering = await db.query.messages.findFirst({
    where: eq(messages.id, params.userMessageId),
    columns: { metadata: true },
  });
  const capturePart = (triggering?.metadata as { capturePart?: unknown } | null)
    ?.capturePart;
  if (capturePart !== undefined && capturePart !== null) {
    logger.warn(
      {
        channelId: params.channelId,
        userMessageId: params.userMessageId,
        reason: "capture_part",
      },
      "triggerAutoRespond skipped — a capture clarification part never produces an agent turn"
    );
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
        agentType:
          typeof params.agentType === "string" && params.agentType.trim()
            ? params.agentType.trim()
            : "meta",
        sourceAgentUserId: params.sourceUserId ?? null,
        focusSessionId: resolvedFocusSessionId,
        serviceUrl: resolvedService.endpoint,
        serviceApiKey: resolvedService.serviceApiKey,
        serviceId: resolvedService.serviceId,
        agentUserId: resolvedService.agentUserId,
        ...(params.turnContext ? { turnContext: params.turnContext } : {}),
      },
      {
        ...A2AI_TRIGGER_JOB_OPTIONS,
        // One in-flight/queued job per user message — concurrent double-enqueue
        // collapses to a single IS turn (pod chat_turns also key on this id).
        singletonKey: params.userMessageId,
      }
    );
    return true;
  } catch (err) {
    // Same invisibility as the eligibility skip above, but a different cause:
    // the channel WAS eligible and the enqueue itself threw (IS resolution,
    // pg-boss). Carry `userMessageId` so a dropped message is traceable back to
    // the exact row the user sees sitting unanswered in their thread.
    logger.error(
      {
        err,
        channelId: params.channelId,
        userMessageId: params.userMessageId,
        reason: "enqueue_failed",
      },
      "triggerAutoRespond failed — user message will never produce an agent turn"
    );
    return false;
  }
}
