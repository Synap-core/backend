/**
 * HELD BY AN ORCHESTRATOR (founder decision D-O1, 18 Nov 2026: "enforce it
 * now"). A session an orchestrator coordinates (`session --orchestrated_by-->
 * orchestrator`, written by api `start-orchestrator.ts`) changes no stage
 * until the person has answered the orchestrator's `plan-approval` slot. Its
 * hold (`answer:<orchestrator>/plan-approval`) already keeps it paused; this
 * rule keeps a move of its STAGE from slipping past the plan while it waits.
 *
 * The wait is over, and moves work again, when the slot carries an answer
 * (yes or no: the decision D-O2 resumes the sessions either way) or when the
 * orchestrator ended (closed, cancelled, failed) without one — the same
 * "over" the hold-resume job reads, so the stage and the status free together.
 *
 * Read by the ONE stage-move rule every door asks before it writes or files
 * anything (`refuseUndeclaredStage`, `stage-declared.ts`). It lives in
 * @synap/jobs because jobs cannot import api; api re-exports the slot key.
 * Owner floor: only an orchestrator the held session's own owner owns counts,
 * so an edge someone else wrote never freezes another person's work.
 */
import { db, and, eq, inArray, focusSessions, links } from "@synap/database";
import { isTerminalSessionStatus } from "@synap-core/types/focus-sessions";
import { holdWaitSlotMatches } from "@synap-core/types/lifecycle";

/** The person's yes on an orchestrator: the slot every held session waits on. */
export const ORCHESTRATOR_APPROVAL_SLOT = "plan-approval";

export interface HoldingOrchestrator {
  id: string;
  /** Its title, else its goal, clipped: what the refusal names. */
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SlotLike = {
  key?: unknown;
  label?: unknown;
  answer?: { answeredAt?: unknown } | null;
};

/**
 * The orchestrator still waiting on the person's answer to its plan that
 * coordinates this session, or null. Two reads: the session's
 * `orchestrated_by` edges (none, the usual case, ends here), then those
 * orchestrators on the session owner's floor.
 */
export async function orchestratorHolding(
  sessionId: string
): Promise<HoldingOrchestrator | null> {
  const edges = await db
    .select({ toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.fromId, sessionId),
        eq(links.toType, "session"),
        eq(links.linkType, "orchestrated_by")
      )
    );
  const ids = edges.map((e) => e.toId).filter((id) => UUID.test(id));
  if (ids.length === 0) return null;
  const [held] = await db
    .select({ userId: focusSessions.userId })
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1);
  if (!held) return null;
  const orchestrators = await db
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      status: focusSessions.status,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(
      and(inArray(focusSessions.id, ids), eq(focusSessions.userId, held.userId))
    );
  for (const o of orchestrators) {
    if (isTerminalSessionStatus(o.status)) continue;
    const slots = Array.isArray(o.expectedOutputs)
      ? (o.expectedOutputs as SlotLike[])
      : [];
    const approval = slots.find((s) =>
      holdWaitSlotMatches(s, ORCHESTRATOR_APPROVAL_SLOT)
    );
    if (!approval || typeof approval.answer?.answeredAt === "string") continue;
    return {
      id: o.id,
      name: (o.title?.trim() || o.goal.trim()).slice(0, 80),
    };
  }
  return null;
}

/** The refusal's one sentence (D-O1). */
export function heldByOrchestratorReason(o: HoldingOrchestrator): string {
  return `Waiting on the orchestrator's plan: ${o.name}. This session changes no stage until the person answers it (orchestrator session ${o.id}). Nothing was changed.`;
}
