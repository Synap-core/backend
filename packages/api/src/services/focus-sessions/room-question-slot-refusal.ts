/**
 * The refusal a room QUESTION gets when its `slotLabel` names nothing it can be
 * filed on. A DB-free LEAF (the `expected-label.ts` precedent), so the post
 * door and its tests read the one wording without loading the DB-bound check
 * (`checkRoomQuestionSlot`, `room-question-slot.ts`). Why a refusal and not a
 * new slot: see that file's docblock.
 */

/** What a question's `slotLabel` names, checked BEFORE the post lands. */
export type RoomQuestionSlotCheck =
  | { status: "ok" }
  /** Not the caller's session: the filing reports `not_found`, as before. */
  | { status: "not_owner" }
  | { status: "no_session" }
  | {
      status: "unknown_label";
      /** The session's declared slots, so the refusal can list them. */
      declared: Array<{ key: string; label: string }>;
    };

/** How many declared slots a refusal names (the MCP error text is capped). */
const REFUSAL_SLOT_LIST_MAX = 12;

/**
 * The refusal sentence for a check that must stop the post, else `null`.
 * Pure. Says NOTHING WAS POSTED, names the slot, lists the declared keys and
 * the door that declares a new one.
 */
export function roomQuestionSlotRefusal(
  check: RoomQuestionSlotCheck,
  slotLabel: string
): string | null {
  if (check.status === "no_session") {
    return `NOTHING WAS POSTED: slotLabel "${slotLabel}" names a session output, but this room belongs to no session. Post the question in the session's room (session.channelId), or drop slotLabel and ask.`;
  }
  if (check.status !== "unknown_label") return null;
  const shown = check.declared.slice(0, REFUSAL_SLOT_LIST_MAX);
  const list =
    shown.length === 0
      ? "it declares none"
      : `declared: ${shown.map((d) => d.key).join(", ")}${check.declared.length > shown.length ? ", …" : ""}`;
  return `NOTHING WAS POSTED: slotLabel "${slotLabel}" names no output of this session. Declare it first with synap_update_session outcomes (owner 'human', blockedReason, why, ask), or resend with a declared key (${list}).`;
}
