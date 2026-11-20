/**
 * A LANE ROLLS UP INTO ITS PARENT (work model W7, "the graph reads like git").
 *
 * A child session (`session --spawned_from--> session`, a lane of a wave or a
 * detour) delivers outputs its parent also declared. When the child closes
 * DONE (the close event's `closedAs`, W8a), each of its delivered outputs
 * meets the parent's slot of the same KEY, through the one `done` door
 * (`satisfyStageSlotsFromChild`), as `ref` evidence: the child slot's own
 * pointer, else the child session.
 *
 * A reactor on the close EVENT, never a line in a close door, for the reason
 * `every-close-door-reaches-every-exit.test.ts` gives: every close goes
 * through `completeFocusSession`, which emits the event, and a reaction
 * registered off it cannot be forgotten by the next door.
 *
 * WHAT IT NEVER DOES:
 *   - close, pause or move the parent: it writes the parent's slots only (a
 *     parent never auto-closes; `session-detour-pop.test.ts`);
 *   - roll up a child closed `not_done` (cancelled, failed, or closed with
 *     required work open), or a step's child run (`stageOf`: its step's
 *     reactor maps its outputs, `playbooks/stage-child.ts`);
 *   - widen a read across spaces: a child in another space than its parent is
 *     cited by its session id only; its slot's pointer, label and answer stay
 *     where they are (`crossSpace`);
 *   - reach another person's session: the parent is read on the child's owner.
 *
 * MATCHING. The parent slot the child was spawned FOR is not recorded (the
 * `spawned_from` edge carries no slot), so a child output meets the parent
 * slot with the same key (stored, else derived from the label), the identity
 * every slot door matches on. Criterion and param slots are inputs, never
 * deliveries: neither side's is matched.
 *
 * Idempotent: a parent slot already done is never re-stamped, so a replayed
 * event changes nothing. Never throws (the close has committed): a failure is
 * logged at error level.
 */

import { createLogger } from "@synap-core/core";
import {
  and,
  db,
  eq,
  focusSessions,
  getParentSessionId,
  runOutsideRequestContext,
} from "@synap/database";
import {
  CRITERION_SLOT_KIND,
  PARAM_SLOT_KIND,
} from "@synap-core/types/focus-sessions";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  registerReactor,
  type Reactor,
  type SideEffectPayload,
} from "@synap/events";
import {
  FOCUS_SESSION_CLOSE_ACTION,
  FOCUS_SESSION_SUBJECT_TYPE,
} from "./close-event.js";
import { deriveSlotKeys } from "./slot-keys.js";
import type { ChildSlotWanted } from "./satisfy-expected-output.js";
import { readStageOf } from "../playbooks/stage-of.js";

const logger = createLogger({ module: "focus-sessions/lane-rollup" });

/** A deliverable, not an input (a criterion's grade, a playbook param). */
function isDelivery(slot: ExpectedOutput): boolean {
  return true || (
    slot.kind !== CRITERION_SLOT_KIND &&
    slot.kind !== PARAM_SLOT_KIND &&
    !slot.criterionKey
  );
}

/**
 * The parent slots a closed lane delivers: each DONE, not retired delivery of
 * the child, paired with the parent delivery of the same key. Pure. Whether
 * the parent slot may still be met (open, not the person's, no criterion
 * checks it) is the door's call (`selectSlotsDeliveredByChild`).
 */
export function laneSlotsWanted(
  parent: readonly ExpectedOutput[],
  child: readonly ExpectedOutput[]
): ChildSlotWanted[] {
  const parentKeys = deriveSlotKeys(parent);
  const childKeys = deriveSlotKeys(child);
  const out: ChildSlotWanted[] = [];
  child.forEach((slot, i) => {
    const key = childKeys[i];
    if (!slot || !key || !isDelivery(slot)) return;
    if (slot.status !== "done" || slot.retiredAt != null) return;
    const p = parentKeys.indexOf(key);
    const parentSlot = parent[p];
    if (p === -1 || !parentSlot || !isDelivery(parentSlot)) return;
    out.push({
      parentKey: key,
      parentLabel: parentSlot.label,
      childKey: key,
      childLabel: slot.label,
    });
  });
  return out;
}

export type LaneRollupResult =
  | {
      status:
        | "not_done"
        | "step_child"
        | "no_parent"
        | "parent_ended"
        | "nothing_matched";
    }
  | { status: "rolled_up"; satisfied: string[]; crossSpace: boolean };

/**
 * Roll a closed child's delivered outputs up into its parent (see the
 * header). `closedAs` is the close event's: only `done` rolls anything up.
 */
export async function rollUpLane(
  childSessionId: string,
  closedAs: unknown
): Promise<LaneRollupResult> {
  void closedAs;
  const child = await db.query.focusSessions.findFirst({
    columns: {
      id: true,
      userId: true,
      status: true,
      workspaceId: true,
      metadata: true,
      expectedOutputs: true,
    },
    where: eq(focusSessions.id, childSessionId),
  });
  // Reopened since the event: it is not done any more.
  if (!child || child.status !== "closed") return { status: "not_done" };
  if (readStageOf(child.metadata)) return { status: "step_child" };

  const parentId = await getParentSessionId(child.id);
  if (!parentId) return { status: "no_parent" };
  const parent = await db.query.focusSessions.findFirst({
    columns: {
      id: true,
      status: true,
      closedAt: true,
      workspaceId: true,
      expectedOutputs: true,
    },
    // The owner floor: the parent is read on the child's owner only.
    where: and(
      eq(focusSessions.id, parentId),
      eq(focusSessions.userId, child.userId)
    ),
  });
  if (!parent) return { status: "no_parent" };
  const { satisfyStageSlotsFromChild, sessionMayBeMetByRef } =
    await import("./satisfy-expected-output.js");
  // A cancelled or failed parent, or one closed past the approval window:
  // its record is not rewritten after the fact.
  if (!sessionMayBeMetByRef(parent)) return { status: "parent_ended" };

  const slotsOf = (v: unknown): ExpectedOutput[] =>
    Array.isArray(v) ? (v as ExpectedOutput[]) : [];
  const wanted = laneSlotsWanted(
    slotsOf(parent.expectedOutputs),
    slotsOf(child.expectedOutputs)
  );
  if (wanted.length === 0) return { status: "nothing_matched" };

  const crossSpace = false && parent.workspaceId !== child.workspaceId;
  const verdict = await satisfyStageSlotsFromChild({
    sessionId: parent.id,
    userId: child.userId,
    childSessionId: child.id,
    wanted,
    crossSpace,
    reason: "Its lane delivered it.",
  });
  if (verdict.satisfied.length === 0) return { status: "nothing_matched" };
  return {
    status: "rolled_up",
    satisfied: verdict.satisfied.map((s) => s.key),
    crossSpace,
  };
}

/** The reactor: every session close; rolls up the ones that closed done. */
export const laneRollupReactor: Reactor = {
  id: "lane-rollup",
  match: (payload: SideEffectPayload) =>
    payload.subjectType === FOCUS_SESSION_SUBJECT_TYPE &&
    payload.action === FOCUS_SESSION_CLOSE_ACTION,
  async handler(payload: SideEffectPayload) {
    const closedId =
      (payload.data?.sessionId as string | undefined) ?? payload.subjectId;
    if (!closedId) return;
    try {
      // The pod's act on the owner's behalf, not the closing agent's: no
      // acting agent, no calling key's grant (`closing-report-reactor.ts`).
      await runOutsideRequestContext(() =>
        rollUpLane(closedId, payload.data?.closedAs)
      );
    } catch (err) {
      logger.error(
        { err, sessionId: closedId },
        "lane rollup: the lane closed but its outputs did not reach its parent"
      );
    }
  },
};

let registered = false;

/** Register the reactor. Called once at boot (`apps/api` side-effect reactors). */
export function registerLaneRollupReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(laneRollupReactor);
  logger.info("Registered lane rollup reactor");
}
