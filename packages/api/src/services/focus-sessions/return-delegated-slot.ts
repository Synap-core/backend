/**
 * returnDelegatedSlot — the other half of the delegation loop: a REJECTION hands
 * the deliverable back.
 *
 * WHY. `delegateExpectedOutput` stamps `delegatedTo`, and approval stamps `done`
 * through `satisfyExpectedOutputs`. Rejection had NO half at all: the reviewer's
 * reason went into `proposals.rejection_reason`, a row nothing on the session
 * board reads, and the slot sat there still marked as delegated to an agent that
 * had already been told no. The board therefore showed "in progress" forever,
 * and the reason — the single most useful sentence in the whole loop, the one
 * that says what to do differently — reached nobody.
 *
 * WHAT IT DOES. Exactly two things, on the ONE slot the rejected proposal
 * CLAIMED (`proposals.data.expectedLabel`, written by governance's
 * `resolveSessionSlotClaim` — never guessed here):
 *   1. posts ONE message in the session room through the ONE message door,
 *      naming the slot and carrying the reason;
 *   2. clears `delegatedTo`/`delegatedAt` and records `returnedReason` +
 *      `returnedAt`, so the owed card can read "Returned · <reason>".
 *
 * NO NEW STATUS VALUE. The slot was `pending` and stays `pending` — being
 * returned is not a fourth lifecycle state, it is a pending slot that carries a
 * note. Inventing `returned` would fork every reader of `status !== "done"`
 * (`complete-session.ts`'s close warning, `session-outputs.ts`'s
 * `pendingExpected`) into two answers about the same slot.
 *
 * BEST-EFFORT BY CONTRACT. A rejection is a governance act that has already
 * happened; it must never fail because a room message or a JSONB stamp did not
 * land. Every failure here is logged and swallowed, exactly like the approval
 * side's `satisfyExpectedOutputs` call.
 *
 * ATTRIBUTION: the message is posted as the SESSION OWNER, not the reviewer. The
 * room is the owner's (`postChannelMessage` floors on channel visibility, and a
 * workspace admin rejecting someone else's proposal may not see their personal
 * session channel). Same rule, same reason, as `recordSessionArtifact` filing
 * the ledger row under the session's owner however acted.
 */

import { db, focusSessions, eq } from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { ExpectedOutput } from "@synap/playbooks";
import { normalizeExpectedLabel } from "./satisfy-expected-output.js";
import { updateExpectedOutputsLocked } from "./delegate-output.js";
import { postChannelMessage } from "../messaging/post-message.js";

const logger = createLogger({ module: "focus-sessions/return-delegated-slot" });

export interface ReturnDelegatedSlotParams {
  sessionId: string;
  /** The slot the rejected proposal claimed. */
  expectedLabel: string;
  /** The reviewer's free-text reason, when they gave one. */
  reason?: string | null;
}

export interface ReturnDelegatedSlotResult {
  /** `true` ⇒ the slot was found open and the return landed. */
  returned: boolean;
  /** The room message posted, when one was. Exactly one per rejection. */
  messageId?: string;
}

export async function returnDelegatedSlot(
  params: ReturnDelegatedSlotParams
): Promise<ReturnDelegatedSlotResult> {
  const { sessionId } = params;
  const wanted = normalizeExpectedLabel(params.expectedLabel);
  if (!wanted) return { returned: false };

  try {
    const session = await db.query.focusSessions.findFirst({
      where: eq(focusSessions.id, sessionId),
      columns: {
        id: true,
        userId: true,
        channelId: true,
        expectedOutputs: true,
      },
    });
    if (!session) return { returned: false };

    const outputs: ExpectedOutput[] = Array.isArray(session.expectedOutputs)
      ? (session.expectedOutputs as ExpectedOutput[])
      : [];
    const slot = outputs.find(
      (o) => normalizeExpectedLabel(o.label) === wanted
    );
    // A claim naming no open slot returns nothing and says nothing. An already
    // satisfied slot is not handed back either — its `done` came from a
    // DIFFERENT, approved proposal, and a later rejection is not evidence
    // against it.
    if (!slot || slot.status === "done") return { returned: false };

    await updateExpectedOutputsLocked(sessionId, (current) =>
      stampReturned(current, slot.label, params.reason)
    );

    // ONE message, and only when the session actually has a room. No room is
    // minted here: unlike a delegation (which is an ask that NEEDS somewhere to
    // land), a return into a freshly created empty channel nobody is reading is
    // noise, and the stamp above already carries the reason to the board.
    let messageId: string | undefined;
    if (session.channelId) {
      const reason = (params.reason ?? "").trim();
      const content = reason
        ? `"${slot.label}" returned: ${reason}`
        : `"${slot.label}" returned.`;
      const posted = await postChannelMessage({
        channelId: session.channelId,
        content,
        // SYSTEM, not user: a return is a record of what a reviewer decided, not
        // a new instruction. `role === "user"` is the only role the message
        // doors let start an agent turn, so this also guarantees a rejection can
        // never kick off a turn by itself.
        role: "system",
        triggerAI: false,
        userId: session.userId,
      });
      messageId = posted.messageId;
    }

    return { returned: true, messageId };
  } catch (err) {
    logger.warn(
      { err, sessionId, expectedLabel: params.expectedLabel },
      "slot return failed after a rejection — the rejection stands"
    );
    return { returned: false };
  }
}

/**
 * Clear the delegation and record the return on the named slot. Pure, so the
 * rule is testable without a database.
 */
export function stampReturned(
  outputs: ExpectedOutput[],
  label: string,
  reason?: string | null
): ExpectedOutput[] {
  const wanted = normalizeExpectedLabel(label);
  const returnedAt = new Date().toISOString();
  const trimmed = (reason ?? "").trim();
  return outputs.map((o) => {
    if (normalizeExpectedLabel(o.label) !== wanted) return o;
    const { delegatedTo: _t, delegatedAt: _a, ...rest } = o;
    return {
      ...rest,
      ...(trimmed ? { returnedReason: trimmed } : {}),
      returnedAt,
    };
  });
}
