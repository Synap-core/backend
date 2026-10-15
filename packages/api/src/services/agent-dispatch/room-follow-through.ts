/**
 * What a room does AFTER the route answered (`route-room.ts`), when the answer
 * is not "this house agent replies":
 *
 *   offerRoomChoice      several house agents fit and nobody was mentioned:
 *                        one system message asks "who should answer?", its
 *                        candidates drawn as chips (`RouteChoiceMeta`).
 *   wakeMentionedAgents  an EXTERNAL member was @mentioned. It never gets an IS
 *                        turn under its name; it is reached its own way
 *                        (founder decision 2026-10-14: wake it):
 *                          dispatch  the message goes to its live run in this
 *                                    session through the binding's `send` verb;
 *                          pull      it is put on the session's roster, so its
 *                                    orient lists the session as handed to it
 *                                    (a worker already resumes on room follow-ups).
 *
 * Both never throw: the person's message has already landed.
 */

import { createLogger } from "@synap-core/core";
import type { AgentReach } from "@synap-core/types/agents";
import { db, eq, focusSessions } from "@synap/database";
import { postChannelMessage } from "../messaging/post-message.js";
import { attachSessionAgent } from "../focus-sessions/attach-session-agent.js";
import { agentDisplayName, postDispatchNotice } from "./binding-call.js";
import { wakeExternalAgent } from "./wake-external-agent.js";
import type { RoomCandidate } from "./route-room.js";

const logger = createLogger({ module: "agent-dispatch/room-follow-through" });

export async function offerRoomChoice(p: {
  channelId: string;
  senderId: string;
  triggerMessageId: string;
  candidates: readonly RoomCandidate[];
}): Promise<void> {
  try {
    await postChannelMessage({
      channelId: p.channelId,
      userId: p.senderId,
      role: "system",
      content: `Who should answer? ${p.candidates
        .map((c) => c.name ?? c.agentType ?? "Agent")
        .join(" · ")}`,
      idempotencyKey: `route-choice:${p.triggerMessageId}`,
      routeChoice: {
        triggerMessageId: p.triggerMessageId,
        candidates: p.candidates.map((c) => ({
          agentUserId: c.agentUserId,
          name: c.name ?? c.agentType ?? "Agent",
        })),
      },
    });
  } catch (err) {
    logger.error(
      { err, channelId: p.channelId, triggerMessageId: p.triggerMessageId },
      "room choice NOT offered — the message stays unanswered"
    );
  }
}

export async function wakeMentionedAgents(p: {
  channelId: string;
  senderId: string;
  messageId: string;
  content: string;
  wake: ReadonlyArray<{ agentUserId: string; reach: AgentReach }>;
}): Promise<void> {
  if (p.wake.length === 0) return;
  const session = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.channelId, p.channelId),
    columns: { id: true, userId: true },
  });
  for (const agent of p.wake) {
    try {
      const name = await agentDisplayName(agent.agentUserId);
      if (!session) {
        await postDispatchNotice({
          channelId: p.channelId,
          ownerId: p.senderId,
          content: `${name} only picks up work from a session. Start one with it to hand it this.`,
          idempotencyKey: `mention-wake:${p.messageId}:${agent.agentUserId}`,
        });
        continue;
      }
      // Only the session OWNER speaks to its agents' live runs (the answer
      // loop's own v1 rule): a teammate's words never reach a run acting with
      // the owner's authority.
      if (p.senderId !== session.userId) {
        await postDispatchNotice({
          channelId: p.channelId,
          ownerId: session.userId,
          content: `${name} takes instructions from this session's owner only, so your message was not passed on.`,
          idempotencyKey: `mention-wake:${p.messageId}:${agent.agentUserId}`,
        });
        continue;
      }
      if (agent.reach === "dispatch") {
        const sent = await wakeExternalAgent({
          sessionId: session.id,
          agentUserId: agent.agentUserId,
          kind: "message",
          text: p.content,
          idempotencyKey: `mention:${p.messageId}`,
        });
        if (sent.status === "not_dispatch") {
          await postDispatchNotice({
            channelId: p.channelId,
            ownerId: session.userId,
            content: `${name} is not working on this session, so your message was not sent to it. Hand it the work first.`,
            idempotencyKey: `mention-wake:${p.messageId}:${agent.agentUserId}`,
          });
        }
        continue;
      }
      // pull: on the roster ⇒ its orient lists the session as handed to it.
      await attachSessionAgent({
        sessionId: session.id,
        agentId: agent.agentUserId,
        userId: session.userId,
      });
    } catch (err) {
      logger.error(
        { err, channelId: p.channelId, agentUserId: agent.agentUserId },
        "mentioned external agent NOT woken"
      );
    }
  }
}
