/**
 * The reaper's door for a session that STOPPED ON ITS OWN ASKS (decision E1,
 * founder 2026-10-27): no agent evidence for 7 days, and everything it owes
 * the person is an ask the agent posed to go on (a confirm or a choose).
 *
 * The loop it breaks (needs-truth §2c): the reaper refused to stale a session
 * that owed the person anything, and the owed asks lived as long as their
 * session — so a session whose agent left could never leave, and its asks sat
 * in "needs you" forever. Nobody will go on with an agent's question once the
 * agent is gone, so the question ends WITH the session (Resolve-XP founder
 * default 3): its owed confirm/choose slots are stamped `session_ended`
 * (`stampRetired` + `slotEndsWithSession`, the W2 close door's own rule) and
 * its room's open questions are closed `session_ended`
 * (`closeOpenRoomQuestions`, the one writer of that stamp). The status goes
 * `stale`, the reaper's own non-terminal mark, never a close: a stale session
 * reopens like any other.
 *
 * NEVER for what the person still has to DO: a session owing an act, a form,
 * a provide or plain work, or waiting on a pending plan/deploy gate, is not a
 * candidate at all (`sessionStoppedOnItsAsksWhere`, `@synap/database`), and the
 * TypeScript re-check below refuses it inside the lock as well.
 *
 * Reached from `@synap/jobs` through the `registerStoppedSessionStaler` slot
 * (jobs cannot import api). Returns `null` when the session no longer matches
 * (an agent came back, the person answered) — the sweep moves on.
 */

import {
  db,
  and,
  eq,
  focusSessions,
  closeOpenRoomQuestions,
  sessionStoppedOnItsAsksWhere,
  setSessionStatus,
} from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  isOwedSlot,
  slotEndsWithSession,
  stampRetired,
} from "./owed-outputs.js";
import { settleSessionNeedsYou } from "./notify-needs-you.js";

export interface StaleStoppedSessionResult {
  sessionId: string;
  /** Owed confirm/choose asks stamped `session_ended`. */
  retiredSlots: number;
  /** Open room questions closed `session_ended`. */
  closedQuestions: number;
}

export async function staleStoppedSession(input: {
  sessionId: string;
  now?: Date;
}): Promise<StaleStoppedSessionResult | null> {
  const now = input.now ?? new Date();
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: focusSessions.id,
        channelId: focusSessions.channelId,
        expectedOutputs: focusSessions.expectedOutputs,
      })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.id, input.sessionId),
          sessionStoppedOnItsAsksWhere(now)
        )
      )
      .for("update");
    if (!row) return null;

    const outputs: ExpectedOutput[] = Array.isArray(row.expectedOutputs)
      ? (row.expectedOutputs as ExpectedOutput[])
      : [];
    const owed = outputs.filter(
      (o) => o && typeof o === "object" && isOwedSlot(o)
    );
    // The SQL said every owed slot ends with the session; the rule says so
    // again here, in the lock, before anything is stamped.
    if (owed.length === 0 || !owed.every(slotEndsWithSession)) return null;

    const at = now.toISOString();
    const closedQuestions = row.channelId
      ? (
          await closeOpenRoomQuestions(tx, {
            channelId: row.channelId,
            closed: { reason: "session_ended", at },
          })
        ).length
      : 0;
    // Only the status and the receipts change: `updated_at` is left alone,
    // like the reaper's own stale stamp (it is no agent's activity). The row
    // is locked above and the predicate held it at active/paused.
    await setSessionStatus(tx, {
      sessionId: row.id,
      from: ["active", "paused"],
      to: "stale",
      actor: { kind: "system" },
      reason: "It stopped on its own questions.",
      set: {
        expectedOutputs: stampRetired(
          outputs,
          "session_ended",
          now,
          slotEndsWithSession
        ),
      },
    });
    return {
      sessionId: row.id,
      retiredSlots: owed.length,
      closedQuestions,
    };
  });
  if (result) await settleSessionNeedsYou(result.sessionId);
  return result;
}
