/**
 * A STATUS MOVE GOES THROUGH THE STAGE GATE IT WOULD WALK (finding 8f2dee79).
 *
 * With a subject, the step IS the subject's status: moving the thing moves
 * every open session about it (process-sync's follow). Before this module the
 * status door wrote the status FIRST and the follow then entered the gated
 * stage, filing its gate AFTER the fact: the gate held the session, never the
 * thing. Live (8 Nov 2026, session 03a2bf4f, "Win a deal"): an agent moved a
 * deal draft → proposed; the move landed, the check gate of the skipped stage
 * "Write proposal" was never asked, and the human gate of "Send proposal" was
 * filed only once the status was already "proposed". `update_session
 * currentStage` refuses the very same skip.
 *
 * So an AGENT's move (the status door's `actor.kind === "agent"`) on a thing
 * that is the subject of an open session following a playbook is, for each
 * session the follow would move, checked BEFORE anything is written:
 *
 *  1. The SAME refusal as a stage advance (`refuseAgentGateBypass`, the floor
 *     the two agent session doors run): a move that would skip a gated stage,
 *     leave a stage that awaits a named approval, or move a run held at its
 *     gate is refused, and nothing is changed.
 *  2. A move into a status owned by a HUMAN- or CHECK-gated stage is routed as
 *     the stage advance itself (`advanceSessionStage`, the one door): the
 *     session enters the stage and its gate runs as for any advance.
 *       - human gate: the run pauses and the gate proposal is filed; the status
 *         is NOT written. Approving the gate writes it (the stage-gate
 *         executor's `writeStageSubjectStatus`, as the approver).
 *       - check gate that passes: the stage stands, and the status door goes on
 *         with the move it was asked for (governed as before).
 *       - check gate that holds: the status is not written; the run pauses or
 *         returns to the stage's `onFail`, exactly as the advance does.
 *     The advance runs with `skipSubjectWrite`: the status door that called it
 *     owns the subject's write (it either makes it, or the gate's pass does).
 *  3. Anything else (an ungated stage, an `awaits` stage being entered, a
 *     backward move, a status no stage owns) is not this module's business:
 *     the move lands and the session follows it, as before.
 *
 * NOT routed, and why (decided from the code, stated so it can be overridden):
 *  - a PERSON's move (`human`): a person moving their own thing is the person
 *    deciding. That is how the gate floor treats a person's session advance
 *    (`gate-bypass-floor.ts`: "Deliberately AGENT-only") and how the follow
 *    treats a person's edit (`process-sync.ts`: "A person's own edit is their
 *    decision and is followed as written").
 *  - `system` (server code), an approved replay (governance already decided:
 *    the gate executor's own write comes back through the door this way or as
 *    the approver) and a session BIRTH move (its writer runs the session's
 *    own lifecycle and seeds the first stage, which is never gated on entry).
 */

import {
  db,
  focusSessions,
  and,
  eq,
  inArray,
  isNotNull,
} from "@synap/database";
import {
  resolveStageGate,
  stageForSubjectStatus,
  type PlaybookStage,
} from "@synap/playbooks";
import { loadSessionProcess } from "@synap/jobs/utils/session-process.js";
import { FOLLOWING_SESSION_STATUSES } from "@synap/jobs/utils/following-sessions.js";
import { refuseAgentGateBypass } from "./gate-bypass-floor.js";
import {
  advanceSessionStage,
  type StageAdvanceSession,
} from "./advance-stage.js";

/** The open session row the plan reads, and the advance needs. */
interface FollowingSession extends StageAdvanceSession {
  userId: string;
  status: string;
  metadata: unknown;
}

/** One session whose follow would ENTER a human- or check-gated stage. */
export interface GatedStageEntry {
  session: FollowingSession;
  stage: PlaybookStage;
}

export type SubjectMoveGatePlan =
  | { kind: "none" }
  | { kind: "refused"; sessionId: string; reason: string }
  | { kind: "enter"; entries: GatedStageEntry[] };

/**
 * READ ONLY: what the stage gates of the open sessions about this thing say
 * about moving its `property` to `to`. Writes nothing; the caller decides,
 * then calls {@link enterGatedStages} for an `enter` plan.
 */
export async function planSubjectMoveGates(input: {
  entityId: string;
  /** The ROLE whose status moves (a facet move), or null for the kind's. */
  role: string | null;
  property: string;
  to: string;
}): Promise<SubjectMoveGatePlan> {
  const sessions: FollowingSession[] = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      status: focusSessions.status,
      metadata: focusSessions.metadata,
      currentStage: focusSessions.currentStage,
      workspaceId: focusSessions.workspaceId,
      projectId: focusSessions.projectId,
      channelId: focusSessions.channelId,
      playbookId: focusSessions.playbookId,
      subjectEntityId: focusSessions.subjectEntityId,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.subjectEntityId, input.entityId),
        inArray(focusSessions.status, [...FOLLOWING_SESSION_STATUSES]),
        isNotNull(focusSessions.playbookId)
      )
    );

  const entries: GatedStageEntry[] = [];
  for (const session of sessions) {
    const proc = await loadSessionProcess({
      sessionId: session.id,
      playbookId: session.playbookId,
    });
    // Exactly the sessions process-sync's follow would move for this move.
    if (!proc?.statusProperty || proc.statusProperty !== input.property)
      continue;
    if (input.role && proc.profileSlug && proc.profileSlug !== input.role)
      continue;
    const toStage = stageForSubjectStatus(proc.stages, input.to);
    if (!toStage || toStage === session.currentStage) continue;
    const keys = proc.stages.map((s) => s?.key);
    const from =
      session.currentStage === null ? -1 : keys.indexOf(session.currentStage);
    // A backward move is followed back, never gated (gates guard entry).
    if (session.currentStage !== null && keys.indexOf(toStage) < from) continue;

    const refusal = await refuseAgentGateBypass({ session, toStage });
    if (refusal) {
      return {
        kind: "refused",
        sessionId: session.id,
        reason: `Moving ${input.property} to "${input.to}" moves a session about this thing to stage "${stageName(proc.stages, toStage)}". ${refusal}`,
      };
    }
    const stage = proc.stages.find((s) => s?.key === toStage);
    const gate = resolveStageGate(stage);
    if (stage && gate && gate.kind !== "awaits") {
      entries.push({ session, stage });
    }
  }
  return entries.length > 0 ? { kind: "enter", entries } : { kind: "none" };
}

export type GatedStageOutcome =
  | {
      kind: "gate_filed";
      sessionId: string;
      stageKey: string;
      proposalId: string;
      proposalType: string;
    }
  | { kind: "held"; sessionId: string; reason: string }
  | { kind: "passed" };

/**
 * Enter each gated stage through THE advance door (the subject's write stays
 * with the caller: `skipSubjectWrite`). The first human gate filed or check
 * held is what the move answers; a check that passes lets the move go on.
 */
export async function enterGatedStages(input: {
  entries: GatedStageEntry[];
  property: string;
  to: string;
  agentUserId: string | null;
}): Promise<GatedStageOutcome> {
  let filed: GatedStageOutcome | null = null;
  let held: GatedStageOutcome | null = null;
  for (const { session, stage } of input.entries) {
    const res = await advanceSessionStage({
      session,
      toStage: stage.key,
      // The session owner reviews the gate, as for every advance.
      userId: session.userId,
      agentUserId: input.agentUserId,
      stageWrite: "door",
      skipSubjectWrite: true,
    });
    if (res.proposalId && res.proposalType) {
      filed ??= {
        kind: "gate_filed",
        sessionId: session.id,
        stageKey: stage.key,
        proposalId: res.proposalId,
        proposalType: res.proposalType,
      };
    } else if (res.check && !res.check.passed) {
      const name = stage.name ?? stage.key;
      const then = res.onFail
        ? ` The session went back to stage "${res.onFail.toStage}".`
        : " The session waits until the check passes.";
      held ??= {
        kind: "held",
        sessionId: session.id,
        reason: `Moving ${input.property} to "${input.to}" enters stage "${name}", whose check did not pass (${res.check.failing.join(", ")}). The status was not moved.${then}`,
      };
    }
  }
  return filed ?? held ?? { kind: "passed" };
}

function stageName(stages: readonly PlaybookStage[], key: string): string {
  const stage = stages.find((s) => s?.key === key);
  return stage?.name ?? key;
}
