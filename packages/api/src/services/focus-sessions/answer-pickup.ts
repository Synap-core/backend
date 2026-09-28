/**
 * The "Picked up" receipt (V1 gap G5) — the ONE writer of
 * `ExpectedOutput.answerPickedUpAt`.
 *
 * When an AGENT reads a slot answer through an answer door (`wait_for_answer`,
 * Hub `GET /focus-sessions/:id/answers`), each slot answer on the page that has
 * no receipt yet gets one. A person reading their own answers never stamps it —
 * the callers only call this with an acting agent. With it the surfaces can say
 * "Answered · waiting for <agent>" (answer, no receipt) versus "Picked up".
 *
 * Only SLOT answers carry a receipt: a slotless room-question answer has no
 * slot to stamp (stated, not hidden).
 *
 * Under the session row lock, like every other expectedOutputs writer, and it
 * re-checks that the stored answer is still the one that was read (same
 * `answeredAt`) — a newer answer that landed between the read and this write
 * is NOT marked read.
 */

import { db, focusSessions, eq } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { normalizeExpectedLabel } from "./expected-label.js";
import type { SessionAnswerItem } from "./list-session-answers.js";

/** Pure: stamp the receipt on each slot whose CURRENT answer was read. */
export function stampPickedUp(
  outputs: ExpectedOutput[],
  read: ReadonlyArray<Pick<SessionAnswerItem, "slot" | "answeredAt">>,
  now: Date
): { outputs: ExpectedOutput[]; stamped: number } {
  const readAt = new Map<string, Set<string>>();
  for (const item of read) {
    if (!item.slot) continue;
    const key = normalizeExpectedLabel(item.slot.label);
    if (!key) continue;
    if (!readAt.has(key)) readAt.set(key, new Set());
    readAt.get(key)!.add(item.answeredAt);
  }
  let stamped = 0;
  const next = outputs.map((o) => {
    if (!o?.answer || o.answerPickedUpAt) return o;
    const key = normalizeExpectedLabel(o.label);
    const seen = key ? readAt.get(key) : undefined;
    if (!seen?.has(o.answer.answeredAt)) return o;
    stamped += 1;
    return { ...o, answerPickedUpAt: now.toISOString() };
  });
  return { outputs: stamped ? next : outputs, stamped };
}

/**
 * Stamp the receipt for the slot answers an agent just read. Returns how many
 * were stamped. Throws on a failed write — the caller decides whether a failed
 * receipt fails the read (the answer doors log and still return the answers:
 * the person's answer reaching the agent outranks the receipt).
 */
export async function stampAnswersPickedUp(p: {
  sessionId: string;
  answers: ReadonlyArray<SessionAnswerItem>;
  now?: Date;
}): Promise<number> {
  if (!p.answers.some((a) => a.slot)) return 0;
  const now = p.now ?? new Date();
  // Check BEFORE taking the row lock: a re-read of answers already picked up
  // (every poll after the first) is the common case and must not queue
  // behind — or block — the session's writers. The lock below re-checks.
  const [peek] = await db
    .select({ expectedOutputs: focusSessions.expectedOutputs })
    .from(focusSessions)
    .where(eq(focusSessions.id, p.sessionId))
    .limit(1);
  if (!peek) return 0;
  const peeked: ExpectedOutput[] = Array.isArray(peek.expectedOutputs)
    ? (peek.expectedOutputs as ExpectedOutput[])
    : [];
  if (stampPickedUp(peeked, p.answers, now).stamped === 0) return 0;
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ expectedOutputs: focusSessions.expectedOutputs })
      .from(focusSessions)
      .where(eq(focusSessions.id, p.sessionId))
      .for("update");
    if (!locked) return 0;
    const current: ExpectedOutput[] = Array.isArray(locked.expectedOutputs)
      ? (locked.expectedOutputs as ExpectedOutput[])
      : [];
    const { outputs, stamped } = stampPickedUp(current, p.answers, now);
    if (stamped === 0) return 0;
    await tx
      .update(focusSessions)
      .set({ expectedOutputs: outputs })
      .where(eq(focusSessions.id, p.sessionId));
    return stamped;
  });
}
