/**
 * askAboutSlot — "Ask about it" on something an agent asked of the person.
 *
 * The slot twin of `proposals.askAi` (`routers/proposals/ask-ai.ts`), sharing
 * its seed-once half (`postSeedOnce`). The person does not understand what the
 * agent needs — or wants to push back before answering — so the door opens a
 * THREAD in the session's own room, rooted on a seed message anchored to the
 * slot (`SessionSlotAnchorSchema`, `message-anchor.ts`), and starts a turn of
 * the agent that owns the work through the ONE door `triggerAutoRespond`, with
 * the slot resolved into bounded turn context (`planSlotAnchorTurn`: label,
 * why, the ask as one line, ref, stale mark).
 *
 * One room per session: the thread is a filtered view of the room the session
 * already has, never a room per slot.
 *
 * FLOORS. The session's OWNER only (`focus_sessions` is owner-private; missing
 * and not-yours are the same NOT_FOUND) — an agent key is refused at the
 * router. A delivered or retired slot is refused like the answer door refuses
 * it: there is nothing left to ask about. A session with no room is refused
 * (there is nowhere to hold the thread).
 *
 * IDEMPOTENT under double-tap: while the room's last message is this person's
 * unanswered seed about the SAME slot, the door returns it rather than posting
 * a second seed and starting a second turn.
 */

import { TRPCError } from "@trpc/server";
import { db, focusSessions, and, eq } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { askFingerprint, SLOT_MOVED_ON_PHRASES } from "@synap-core/types/ask";
import { postSeedOnce } from "../messaging/post-seed-once.js";
import { triggerAutoRespond } from "../../utils/trigger-auto-respond.js";
import { planSlotAnchorTurn } from "../../utils/anchored-comment-turn.js";
import {
  SessionSlotAnchorSchema,
  type SessionSlotAnchor,
} from "../../utils/message-anchor.js";
import { selectSlotToAnswer } from "./answer-slot.js";
import { normalizeExpectedLabel } from "./expected-label.js";
import { resolveWakeAgentType } from "./session-answer.js";

/** The sentence the person is understood to be saying. Not a prompt — the
 *  agent's instructions for a slot thread live in the IS prompt. */
export function askAboutSlotSeed(label: string, note?: string): string {
  const head = `Tell me more about "${label}" — what exactly do you need from me?`;
  const extra = note?.trim();
  return extra ? `${head}\n\n${extra}` : head;
}

export const ASK_ABOUT_SLOT_NOTE_MAX = 2000;

export interface AskAboutSlotResult {
  channelId: string;
  /** The thread's root: the seed (new, or the one already waiting). */
  messageId: string;
  /** The thread id — the root message's id. */
  threadId?: string;
  /** false ⇒ an unanswered seed about this slot was already waiting. */
  seeded: boolean;
  triggered: boolean;
}

function readSlotAnchor(metadata: unknown): SessionSlotAnchor | null {
  const anchor = (metadata as { anchor?: unknown } | null)?.anchor;
  const parsed = SessionSlotAnchorSchema.safeParse(anchor);
  return parsed.success ? parsed.data : null;
}

export async function askAboutSlot(params: {
  sessionId: string;
  /** Owner floor AND the asking person. */
  userId: string;
  expectedLabel: string;
  note?: string;
}): Promise<AskAboutSlotResult> {
  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, params.sessionId),
      eq(focusSessions.userId, params.userId)
    ),
    columns: {
      id: true,
      channelId: true,
      expectedOutputs: true,
      agentIds: true,
    },
  });
  if (!session) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Focus session ${params.sessionId} not found`,
    });
  }
  const outputs: ExpectedOutput[] = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as ExpectedOutput[])
    : [];
  const chosen = selectSlotToAnswer(outputs, params.expectedLabel);
  if ("refused" in chosen) {
    const label = params.expectedLabel;
    throw new TRPCError(
      chosen.refused === "unknown_label"
        ? {
            code: "NOT_FOUND",
            message: `This session ${SLOT_MOVED_ON_PHRASES.unknownLabel} "${label}"`,
          }
        : chosen.refused === "already_done"
          ? {
              code: "BAD_REQUEST",
              message: `"${label}" ${SLOT_MOVED_ON_PHRASES.alreadyDone}`,
            }
          : {
              code: "BAD_REQUEST",
              message: `"${label}" ${SLOT_MOVED_ON_PHRASES.retired} with its cancelled session`,
            }
    );
  }
  if (!session.channelId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This session has no room to ask in.",
    });
  }
  const slot = outputs[chosen.index]!;
  const anchor: SessionSlotAnchor = SessionSlotAnchorSchema.parse({
    kind: "session_slot",
    sessionId: session.id,
    label: slot.label,
    askFingerprint: askFingerprint(slot.ask ?? null),
  });
  const note = params.note?.trim().slice(0, ASK_ABOUT_SLOT_NOTE_MAX);
  const content = askAboutSlotSeed(slot.label, note);
  const wanted = normalizeExpectedLabel(slot.label);

  const seed = await postSeedOnce({
    channelId: session.channelId,
    userId: params.userId,
    content,
    idempotencyScope: `ask-slot:${session.id}:${wanted}`,
    isPendingSeed: (latest) => {
      if (latest.role !== "user") return false;
      const prior = readSlotAnchor(latest.metadata);
      return (
        !!prior &&
        prior.sessionId === session.id &&
        normalizeExpectedLabel(prior.label) === wanted
      );
    },
    comment: { anchor },
  });
  if (!seed.seeded) {
    return {
      channelId: session.channelId,
      messageId: seed.messageId,
      threadId: seed.messageId,
      seeded: false,
      triggered: false,
    };
  }

  // A session room is a GROUP room: only a NAMED agent is woken. The agent
  // that owns the work (delegatedTo), else the first pod-run agent staffed on
  // the session, else the orchestrator.
  const agentType =
    (await resolveWakeAgentType({
      slot,
      agentIds: Array.isArray(session.agentIds) ? session.agentIds : [],
    })) ?? "meta";
  const plan = await planSlotAnchorTurn({ anchor, comment: content });
  const triggered = await triggerAutoRespond({
    channelId: session.channelId,
    userMessageId: seed.messageId,
    content,
    sourceUserId: params.userId,
    focusSessionId: session.id,
    agentType,
    turnContext: { anchor: plan.context },
  });

  return {
    channelId: session.channelId,
    messageId: seed.messageId,
    threadId: seed.messageId,
    seeded: true,
    triggered,
  };
}
