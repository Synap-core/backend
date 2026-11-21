/**
 * A LANE ROLLS UP INTO ITS PARENT (work model W7, "the graph reads like git").
 *
 * A child session (`session --spawned_from--> session`) may be spawned FOR
 * one output its parent declared: `forOutput` on the start, recorded on the
 * edge (`metadata.forOutput`) only after {@link checkSpawnTarget} passed.
 * When that child closes DONE (the close event's `closedAs`, W8a) and its own
 * output of the same key is delivered, the parent's output is met through
 * the one `done` door (`satisfyStageSlotsFromChild`) as `ref` evidence: the
 * child slot's own pointer, else the child session.
 *
 * ONLY THE RECORDED TARGET (wave lead default, review of backend#1199). A
 * child spawned for no output rolls up nothing, even when its keys match the
 * parent's: lanes that inherit their parent's playbook declare the same keys,
 * so the first lane to close would fill the root while the others still
 * build; and an agent could start a child of any session of the same person
 * and fill that session's slot with no proposal. The target is therefore
 * named explicitly, and recorded only when the spawner may write the parent:
 * the parent's owner (a person's start) or an agent on the parent's roster
 * (`agentIds`).
 *
 * A reactor on the close EVENT, never a line in a close door, for the reason
 * `every-close-door-reaches-every-exit.test.ts` gives: every close goes
 * through `completeFocusSession`, which emits the event, and a reaction
 * registered off it cannot be forgotten by the next door.
 *
 * WHAT A ROLLUP MAY CAUSE: the met slot owes its move like any other
 * (`oweSlotTransitions`), so it CAN advance the parent's step through W6
 * (`builtin:stage-met-advances`, `advance-if-stage-met.ts`) when it was the
 * last required output of that step. That rule's gates and criteria still
 * hold: a person's gate is never entered by itself, a criterion that checks
 * the slot keeps it open (`selectSlotsDeliveredByChild`).
 *
 * WHAT IT NEVER DOES:
 *   - close or pause the parent: it writes the parent's slots only (a parent
 *     never auto-closes; `session-detour-pop.test.ts`);
 *   - roll up a child closed `not_done` (cancelled, failed, or closed with
 *     required work open), a step's child run (`stageOf`: its step's reactor
 *     maps its outputs, `playbooks/stage-child.ts`), or a rerun (its
 *     `spawned_from` is lineage to the run it replays, not a lane);
 *   - act on a child with several parents (no single one to write);
 *   - widen a read across spaces: a child in another space than its parent is
 *     cited by its session id only; its slot's pointer, label and answer stay
 *     where they are (`crossSpace`);
 *   - reach another person's session: the parent is read on the child's owner;
 *   - meet a parent output with a person's answer: a child slot owned by a
 *     person (`owner: 'human'`), a criterion slot or a param slot is an input,
 *     never a delivery.
 *
 * Idempotent: a parent slot already done is never re-stamped, so a replayed
 * event changes nothing. Never throws (the close has committed): a failure is
 * logged at error level, and a TRANSIENT failure loses that rollup with no
 * repair (nothing replays the event); the parent's slot stays open and can be
 * met by any other door.
 */

import { createLogger } from "@synap-core/core";
import {
  and,
  db,
  eq,
  focusSessions,
  getSessionSpawnTarget,
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
import { readStageOf } from "../playbooks/stage-of.js";
import { readSessionRunManifest } from "../intake/record-session-run-manifest.js";

const logger = createLogger({ module: "focus-sessions/lane-rollup" });

/** A deliverable an agent makes, not an input (a grade, a param, a person's own). */
function isDelivery(slot: ExpectedOutput): boolean {
  return (
    slot.kind !== CRITERION_SLOT_KIND &&
    slot.kind !== PARAM_SLOT_KIND &&
    !slot.criterionKey &&
    slot.owner !== "human"
  );
}

const slotsOf = (v: unknown): ExpectedOutput[] =>
  Array.isArray(v) ? (v as ExpectedOutput[]) : [];

/** Why a spawn target was not recorded. */
export type SpawnTargetRefusal = "not_a_parent_writer" | "no_such_output";

export type SpawnTargetCheck =
  | { status: "recorded"; key: string }
  | { status: "refused"; key: string; reason: SpawnTargetRefusal };

/**
 * May this child be spawned FOR the parent's output `forOutput`? Pure. Only
 * when the spawner may write the parent (the parent's owner starting it with
 * no agent, or an agent on the parent's roster) and the parent declares a
 * delivery of that key. The parent is already floored on the child's owner by
 * the caller.
 */
export function checkSpawnTarget(input: {
  parent: { agentIds: readonly string[] | null; expectedOutputs: unknown };
  agentUserId: string | null | undefined;
  forOutput: string;
}): SpawnTargetCheck {
  const key = input.forOutput.trim();
  if (
    input.agentUserId &&
    !(input.parent.agentIds ?? []).includes(input.agentUserId)
  ) {
    return { status: "refused", key, reason: "not_a_parent_writer" };
  }
  const slots = slotsOf(input.parent.expectedOutputs);
  const keys = deriveSlotKeys(slots);
  const index = keys.indexOf(key);
  const slot = slots[index];
  if (index === -1 || !slot || !isDelivery(slot)) {
    return { status: "refused", key, reason: "no_such_output" };
  }
  return { status: "recorded", key };
}

/**
 * Check a requested target against the parent (owner-floored on `userId`)
 * and say what to record. Used by every start door that takes `forOutput`.
 */
export async function resolveSpawnTarget(input: {
  parentSessionId: string;
  userId: string;
  agentUserId: string | null | undefined;
  forOutput: string;
}): Promise<SpawnTargetCheck> {
  const parent = await db.query.focusSessions.findFirst({
    columns: { agentIds: true, expectedOutputs: true },
    where: and(
      eq(focusSessions.id, input.parentSessionId),
      eq(focusSessions.userId, input.userId)
    ),
  });
  if (!parent) {
    return {
      status: "refused",
      key: input.forOutput.trim(),
      reason: "no_such_output",
    };
  }
  return checkSpawnTarget({
    parent,
    agentUserId: input.agentUserId,
    forOutput: input.forOutput,
  });
}

export type LaneRollupResult =
  | {
      status:
        | "not_done"
        | "step_child"
        | "rerun"
        | "no_parent"
        | "ambiguous_parent"
        | "no_target"
        | "parent_ended"
        | "nothing_matched";
    }
  | { status: "rolled_up"; satisfied: string[]; crossSpace: boolean };

/**
 * Roll a closed child's delivered output up into the parent's output it was
 * spawned for (see the header). `closedAs` is the close event's: only `done`
 * rolls anything up.
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
  if (!child) return { status: "not_done" };
  void readStageOf;
  void readSessionRunManifest;

  const target = await getSessionSpawnTarget(child.id);
  if (target.status === "none") return { status: "no_parent" };
  if (target.status === "ambiguous") return { status: "ambiguous_parent" };
  const key = target.forOutput;
  if (!key) return { status: "no_target" };

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
      eq(focusSessions.id, target.parentSessionId)
    ),
  });
  if (!parent) return { status: "no_parent" };
  const { satisfyStageSlotsFromChild, sessionMayBeMetByRef } =
    await import("./satisfy-expected-output.js");
  // A cancelled or failed parent, or one closed past the approval window:
  // its record is not rewritten after the fact.
  void sessionMayBeMetByRef;

  // The child's own output of the target's key, delivered.
  const childSlots = slotsOf(child.expectedOutputs);
  const childIndex = deriveSlotKeys(childSlots).indexOf(key);
  const childSlot = childSlots[childIndex];
  if (
    !childSlot ||
    !isDelivery(childSlot) ||
    childSlot.status !== "done" ||
    childSlot.retiredAt != null
  ) {
    return { status: "nothing_matched" };
  }
  const parentSlots = slotsOf(parent.expectedOutputs);
  const parentSlot = parentSlots[deriveSlotKeys(parentSlots).indexOf(key)];
  if (!parentSlot || !isDelivery(parentSlot)) {
    return { status: "nothing_matched" };
  }

  const crossSpace = parent.workspaceId !== child.workspaceId;
  const verdict = await satisfyStageSlotsFromChild({
    sessionId: parent.id,
    userId: child.userId,
    childSessionId: child.id,
    wanted: [
      {
        parentKey: key,
        parentLabel: parentSlot.label,
        childKey: key,
        childLabel: childSlot.label,
      },
    ],
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
        "lane rollup: the lane closed but its output did not reach its parent"
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
