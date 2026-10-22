/**
 * An agent's room QUESTION about a slot becomes that slot's ASK (founder
 * decision 4, typed-ask wave).
 *
 * Before: `post_message kind:'question' slotLabel:X` lived only as a room
 * message. The person saw it in the room, the slot itself said nothing, and a
 * tray card for X (if the slot was theirs) carried an older `why` — two places
 * saying what was asked, and a question on an agent-owned slot that no
 * needs-you surface could render as a card at all.
 *
 * Now the question is FILED ON THE SLOT through the ONE hand-over door
 * (`blockExpectedOutput`): the slot becomes the person's (`owner: 'human'`),
 * its `why` IS the question, and its `ask` is the typed ask the agent passed —
 * absent means a free-text answer (today's default). So every surface renders
 * it as the same ask card, and the answer's SSOT is `slot.answer` (the answer
 * door). The room message stays as the conversation's copy of the question —
 * a projection, stamped closed by the answer door; no third store.
 *
 * A slotless question is untouched: it is a question in the room, nothing
 * more. A question naming a slot the session does NOT DECLARE (or posted in a
 * room that is no session's) is REFUSED before anything is posted
 * (`checkRoomQuestionSlot`, called by `postChannelMessage`). Live, 2026-10-22,
 * session 5382a350: `post_message` with `ask` + an undeclared `slotLabel`
 * returned success with `slot: unknown_label` — the message posted, the ask
 * attached to nothing, and no surface could show it as a card. Refusing, not
 * creating the slot: a slot is declared through the session's own doors
 * (`synap_update_session` `outcomes` / `addOutput`, governed, keyed, with
 * `owedSince`), and a chat post minting one would be a second, ungoverned
 * declaration door. A slot already delivered still files nothing and the post
 * reports why (`already_done`): the slot exists, the question is about it.
 */

import { db, focusSessions, and, eq } from "@synap/database";
import type { ExpectedOutput, SlotAsk } from "@synap/playbooks";
import { resolveRoomSession } from "../messaging/room-session.js";
import { deriveSlotKeys, findSlotIndex } from "./slot-keys.js";
import type { RoomQuestionSlotCheck } from "./room-question-slot-refusal.js";
import {
  blockExpectedOutput,
  type BlockExpectedOutputResult,
} from "./block-output.js";

/** The slot doors' `why` ceiling (`expectedOutputWireSchema.why`). */
const WHY_MAX = 500;

export type RoomQuestionSlotResult =
  { status: "no_session" } | BlockExpectedOutputResult;

export async function fileRoomQuestionOnSlot(p: {
  channelId: string;
  slotLabel: string;
  /** The question as posted — becomes the slot's `why`. */
  question: string;
  /** The typed ask, already parsed (`AskSchema`); absent ⇒ free text. */
  ask?: SlotAsk;
  /** The posting agent, from the door's verified auth context. */
  agentUserId: string;
  /**
   * The HUMAN principal the post was made under (an agent key maps to its
   * owner). Only the session OWNER's agent may hand the owner a slot — the
   * same owner floor every slot door applies; anyone else files nothing.
   */
  userId: string;
}): Promise<RoomQuestionSlotResult> {
  const session = await resolveRoomSession(p.channelId);
  if (!session) return { status: "no_session" };
  if (session.userId !== p.userId) return { status: "not_found" };

  // Keep a slot's existing blocker class (a credential stays a credential);
  // an agent-owned slot being asked about is a `decision` the person makes.
  const [row] = await db
    .select({ expectedOutputs: focusSessions.expectedOutputs })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, session.id),
        eq(focusSessions.userId, session.userId)
      )
    )
    .limit(1);
  // KEY first, then the label (`findSlotIndex`) — the same slot
  // `blockExpectedOutput` below resolves `slotLabel` to.
  const slots = Array.isArray(row?.expectedOutputs)
    ? (row.expectedOutputs as ExpectedOutput[])
    : [];
  const existing = slots[findSlotIndex(slots, p.slotLabel)];

  const question = p.question.trim();
  return blockExpectedOutput({
    sessionId: session.id,
    userId: session.userId,
    expectedLabel: p.slotLabel,
    blockedReason:
      existing?.owner === "human" && existing.blockedReason
        ? existing.blockedReason
        : "decision",
    why:
      question.length > WHY_MAX
        ? `${question.slice(0, WHY_MAX - 1)}…`
        : question,
    // `undefined` keeps a stored ask (a plain question re-asked in words does
    // not erase the typed ask it is about); a passed ask replaces it.
    ...(p.ask ? { ask: p.ask } : {}),
    agentUserId: p.agentUserId,
  });
}

/**
 * Does `slotLabel` (a key or a label, `findSlotIndex`) name a slot of the
 * session behind `channelId`? Read-only; the same resolution
 * `fileRoomQuestionOnSlot` makes after the post.
 */
export async function checkRoomQuestionSlot(p: {
  channelId: string;
  slotLabel: string;
  userId: string;
}): Promise<RoomQuestionSlotCheck> {
  const session = await resolveRoomSession(p.channelId);
  if (!session) return { status: "no_session" };
  if (session.userId !== p.userId) return { status: "not_owner" };
  const [row] = await db
    .select({ expectedOutputs: focusSessions.expectedOutputs })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, session.id),
        eq(focusSessions.userId, session.userId)
      )
    )
    .limit(1);
  const slots = Array.isArray(row?.expectedOutputs)
    ? (row.expectedOutputs as ExpectedOutput[])
    : [];
  if (findSlotIndex(slots, p.slotLabel) !== -1) return { status: "ok" };
  const keys = deriveSlotKeys(slots);
  return {
    status: "unknown_label",
    declared: slots.map((s, i) => ({ key: keys[i] ?? "", label: s.label })),
  };
}
