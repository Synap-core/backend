/**
 * answerHistory — keep what the person answered before, instead of dropping it.
 *
 * Three doors clear a slot's `answer`: a second answer (`stampAnswered`), a
 * re-ask by the targeted block door (`stampBlocked`), and a wholesale patch
 * handing the slot back to the person (`mergeExpectedOutputs`). Each was right
 * to clear it — an old answer read as the new one is the bug those doors
 * prevent — but each also THREW AWAY a decision the person had made. They now
 * archive it here first. Pure, server-stamped (`answerHistory` sits in
 * `SERVER_STAMPED_OUTPUT_FIELDS`), capped at `SLOT_ANSWER_HISTORY_MAX`.
 */

import {
  SLOT_ANSWER_HISTORY_MAX,
  type ExpectedOutput,
  type SlotAnswer,
} from "@synap/playbooks";

/**
 * The slot's history with its CURRENT answer appended (oldest first, newest
 * last, capped). `undefined` when there is nothing to archive and no history —
 * so a slot that never had an answer never grows an empty key.
 */
export function archivedAnswerHistory(
  slot: Pick<ExpectedOutput, "answer" | "answerHistory">
): SlotAnswer[] | undefined {
  const prior = Array.isArray(slot.answerHistory) ? slot.answerHistory : [];
  if (!slot.answer) return prior.length > 0 ? prior : undefined;
  return [...prior, slot.answer].slice(-SLOT_ANSWER_HISTORY_MAX);
}
