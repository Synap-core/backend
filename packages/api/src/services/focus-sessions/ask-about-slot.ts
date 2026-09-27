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
 * IDEMPOTENT by ANCHOR: while the person's newest seed about this slot has
 * no agent reply after it (`slot-thread.ts`), the door returns THAT seed and
 * re-triggers its turn rather than posting a second one — the re-trigger is
 * safe because the ONE turn door keys its job on the seed's message id
 * (`triggerAutoRespond` `singletonKey`), so a turn still queued or running is
 * not duplicated, and a turn that was dropped is finally run. Concurrent taps
 * collapse on the seed's deterministic id (`postSeedOnce`).
 *
 * The client may send the `askFingerprint` of the ask it RENDERED; that is
 * what the anchor carries, so the agent's turn sees CHANGED when the person
 * was looking at an older ask than the one now on the slot.
 */

import { db, focusSessions, and, eq } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { askFingerprint, ASK_LIMITS } from "@synap-core/types/ask";
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
import { agentRepliedAfter, findNewestSlotThreadSeed } from "./slot-thread.js";

/** The sentence the person is understood to be saying. Not a prompt — the
 *  agent's instructions for a slot thread live in the IS prompt. */
export function askAboutSlotSeed(label: string, note?: string): string {
  const head = `Tell me more about "${label}". What exactly do you need from me?`;
  const extra = note?.trim();
  return extra ? `${head}\n\n${extra}` : head;
}

/**
 * The note's bound: the person's own words about an ask, the same ceiling as
 * their free-text answer to one.
 */
export const ASK_ABOUT_SLOT_NOTE_MAX = ASK_LIMITS.answerTextMaxChars;

export type AskAboutSlotResult =
  /** The same refusals as the answer door — worded by `describeAnswerRefusal`. */
  | { status: "not_found" | "unknown_label" | "already_done" | "retired" }
  /** The session has no room to hold the thread. */
  | { status: "no_room" }
  | {
      status: "asked";
      channelId: string;
      /** The thread's root: the seed (new, or the one already waiting). */
      messageId: string;
      /** The thread id — the root message's id. */
      threadId: string;
      /** false ⇒ an unanswered seed about this slot was already waiting. */
      seeded: boolean;
      triggered: boolean;
    };

export async function askAboutSlot(params: {
  sessionId: string;
  /** Owner floor AND the asking person. */
  userId: string;
  expectedLabel: string;
  note?: string;
  /** `askFingerprint(ask)` of the ask the client rendered; default: the slot's. */
  askFingerprint?: string;
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
  if (!session) return { status: "not_found" };
  const outputs: ExpectedOutput[] = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as ExpectedOutput[])
    : [];
  const chosen = selectSlotToAnswer(outputs, params.expectedLabel);
  if ("refused" in chosen) return { status: chosen.refused };
  if (!session.channelId) return { status: "no_room" };
  const channelId = session.channelId;
  const slot = outputs[chosen.index]!;
  const anchor: SessionSlotAnchor = SessionSlotAnchorSchema.parse({
    kind: "session_slot",
    sessionId: session.id,
    label: slot.label,
    askFingerprint: params.askFingerprint ?? askFingerprint(slot.ask ?? null),
  });
  const note = params.note?.trim().slice(0, ASK_ABOUT_SLOT_NOTE_MAX);
  const content = askAboutSlotSeed(slot.label, note);
  const wanted = normalizeExpectedLabel(slot.label);

  // A session room is a GROUP room: only a NAMED agent is woken. The agent
  // that owns the work (delegatedTo), else the first pod-run agent staffed on
  // the session, else the orchestrator.
  const startTurn = async (
    seedId: string,
    seedContent: string,
    seedAnchor: SessionSlotAnchor
  ) => {
    const agentType =
      (await resolveWakeAgentType({
        slot,
        agentIds: Array.isArray(session.agentIds) ? session.agentIds : [],
      })) ?? "meta";
    const plan = await planSlotAnchorTurn({
      anchor: seedAnchor,
      comment: seedContent,
    });
    return triggerAutoRespond({
      channelId,
      userMessageId: seedId,
      content: seedContent,
      sourceUserId: params.userId,
      focusSessionId: session.id,
      agentType,
      turnContext: { anchor: plan.context },
    });
  };

  const waiting = await findNewestSlotThreadSeed({
    channelId,
    sessionId: session.id,
    label: slot.label,
    userId: params.userId,
  });
  if (waiting && !(await agentRepliedAfter(channelId, waiting.id))) {
    return {
      status: "asked",
      channelId,
      messageId: waiting.id,
      threadId: waiting.id,
      seeded: false,
      // The WAITING seed's own words and anchor: its turn is about what the
      // person asked then, not about this tap.
      triggered: await startTurn(waiting.id, waiting.content, waiting.anchor),
    };
  }

  const seed = await postSeedOnce({
    channelId,
    userId: params.userId,
    content,
    // Keyed on the seed this decision was made against (the answered one, or
    // none): two concurrent taps derive the SAME id and one insert wins.
    idempotencyScope: `ask-slot:${session.id}:${wanted}:${waiting?.id ?? "none"}`,
    // The anchor lookup above already decided there is no waiting seed; the
    // "last message" heuristic is exactly what it replaced.
    isPendingSeed: () => false,
    comment: { anchor },
  });
  if (!seed.seeded) {
    // A concurrent tap won the insert and starts the turn itself.
    return {
      status: "asked",
      channelId,
      messageId: seed.messageId,
      threadId: seed.messageId,
      seeded: false,
      triggered: false,
    };
  }

  return {
    status: "asked",
    channelId,
    messageId: seed.messageId,
    threadId: seed.messageId,
    seeded: true,
    triggered: await startTurn(seed.messageId, content, anchor),
  };
}
