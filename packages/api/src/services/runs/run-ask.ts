/**
 * THE ONE WAY the pod asks the person something at a run's turn end.
 *
 * A run never asks (founder, 2026-11-05 and 9 Nov 2026): it has no session,
 * ask or room tool. When a run needs the person — its continuations are spent
 * ("Keep the run going", `run-turn-end.ts`) or a stage declares a question
 * the person answers before the next stage (`stage-end-ask.ts`) — the POD
 * raises it, here, through the existing slot doors:
 *   1. declare the slot fresh (an earlier round's slot of the same label is
 *      replaced, as the agent-approval card does);
 *   2. with the turn's agent known and a decision to make, post an agent
 *      QUESTION in the room filed on that slot (`postChannelMessage kind:'question' slotLabel`), so the
 *      answer wakes that agent (`session-answer.ts`);
 *   3. otherwise, or when the question did not file, hand the slot over
 *      directly (`blockExpectedOutput`, which notifies), its cause the run.
 * `true` iff the slot is now the person's. Never throws: a failure is logged
 * and answered `false`, and the caller leaves the run live.
 */

import type { BlockedReason, ExpectedOutput, SlotAsk } from "@synap/playbooks";
import { createLogger } from "@synap-core/core";
import { postChannelMessage } from "../messaging/post-message.js";
import { normalizeExpectedLabel } from "../focus-sessions/expected-label.js";
import { updateExpectedOutputsLocked } from "../focus-sessions/delegate-output.js";
import { blockExpectedOutput } from "../focus-sessions/block-output.js";

const logger = createLogger({ module: "run-ask" });

export interface RunAskInput {
  runId: string;
  session: { id: string; userId: string; channelId: string | null };
  /** The turn's agent, from the request's VERIFIED auth context, if any. */
  askingAgentUserId: string | null;
  /** The slot to declare (the person's once handed over). */
  slot: ExpectedOutput;
  blockedReason: BlockedReason;
  /** The facts, once: the slot's `why`. */
  why: string;
  /** The room post's words (the facts and the question, as a message reads). */
  question: string;
  ask: SlotAsk;
  /** The room post's idempotency key (one question per turn). */
  idempotencyKey: string;
}

export async function raiseRunAsk(p: RunAskInput): Promise<boolean> {
  const wanted = normalizeExpectedLabel(p.slot.label);
  try {
    const declared = await updateExpectedOutputsLocked(
      p.session.id,
      (current) => [
        ...current.filter((o) => normalizeExpectedLabel(o?.label) !== wanted),
        p.slot,
      ]
    );
    if (!declared) return false;

    // The room question files its slot as a `decision` (the room-question
    // door's rule for an agent-owned slot), so another blocker class (a
    // credential, a file only the person holds) is handed over directly,
    // keeping its class; the answer then wakes the session's agent.
    if (
      p.blockedReason === "decision" &&
      p.askingAgentUserId &&
      p.session.channelId
    ) {
      const posted = await postChannelMessage({
        channelId: p.session.channelId,
        content: p.question,
        userId: p.session.userId,
        role: "assistant",
        agentUserId: p.askingAgentUserId,
        kind: "question",
        slotLabel: p.slot.label,
        ask: p.ask,
        idempotencyKey: p.idempotencyKey,
      });
      if (posted.slot?.status === "blocked") return true;
      logger.warn(
        { runId: p.runId, slot: posted.slot?.status ?? null },
        "run-ask: the question did not file on the slot; handing it over directly"
      );
    }
    const blocked = await blockExpectedOutput({
      sessionId: p.session.id,
      userId: p.session.userId,
      expectedLabel: p.slot.label,
      blockedReason: p.blockedReason,
      why: p.why,
      ask: p.ask,
      agentUserId: p.askingAgentUserId,
      askCause: { kind: "run", ref: { kind: "run", id: p.runId } },
    });
    return blocked.status === "blocked";
  } catch (err) {
    logger.error(
      { err, runId: p.runId, sessionId: p.session.id, label: p.slot.label },
      "run-ask: could not ask the person"
    );
    return false;
  }
}
