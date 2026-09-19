/**
 * advanceSessionStage — THE ONE DOOR for advancing a focus session's stage.
 *
 * ── The defect this exists to close ─────────────────────────────────────────
 * A playbook stage may declare `gate: { kind: "human" }` (`@synap/playbooks`,
 * `resolveStageGate`). Until this module, the gate was honoured by exactly ONE
 * of the four writers of `focus_sessions.current_stage`:
 *
 *   honoured   services/focus-sessions/update-session.ts   (MCP synap_update_session)
 *   WALKED     routers/focus-sessions.ts                   (tRPC focusSessions.update)
 *   WALKED     routers/hub-protocol/rest/focus-sessions.ts (Hub PATCH /focus-sessions/:id)
 *   WALKED     jobs/src/workers/steps/output.ts            (automation `session_update`)
 *
 * The three walkers each carried their OWN hand-copied `stage_changed` emit, and
 * the gated one carried a comment naming the other two as follow-ups. That is the
 * hand-maintained-projection shape: four copies of one rule, three of them a
 * field behind, and no instrument that could notice.
 *
 * The fix is CONSOLIDATION, not a fourth copy of the gate. Every user-initiated
 * advance calls this function; it owns change-detection, the `stage_changed`
 * side-effect and the gate. Adding a rule to a stage advance now has exactly one
 * place to land.
 *
 * ── Who is NOT a caller (and why that is correct) ───────────────────────────
 * Three classes of `current_stage` write deliberately do NOT come through here.
 * They are enumerated, with a checkable reason each, in the tripwire
 * `__tripwires__/current-stage-one-door.test.ts` — read it before adding a writer.
 *
 *   MATERIALIZATION  create-session / schedule-session / playbook-lifecycle seed
 *                    `stages[0]` at birth. Nobody "advanced into" the first
 *                    stage; gating it would pause every run the moment it starts.
 *   APPROVAL RE-APPLY  the proposal executors (`focus_session/update`,
 *                    dev-approval). A human has just answered; re-gating asks the
 *                    same person for the same advance twice.
 *   RESUME           the stage-gate executor itself never touches `current_stage`
 *                    — the stage already stands (see services/playbooks/stage-gate.ts).
 *
 * ── Why `stageWrite` is an explicit, required discriminator ─────────────────
 * Three of the four doors write the stage inside a MULTI-FIELD `UPDATE` that also
 * carries goal / progress / expectedOutputs; splitting that write out would turn
 * one statement into two and re-open the TOCTOU the outputs lock exists to close.
 * The fourth (the automation door) has no such bundled write. So the caller
 * declares which it is rather than this door guessing:
 *
 *   "caller" — the stage column was already written by the caller's own UPDATE.
 *   "door"   — nobody has written it; this door issues the single-column UPDATE.
 *
 * It is a required field, not an option with a default, so a new door cannot
 * silently inherit the wrong half of that pair.
 */

import { db, focusSessions, eq } from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";
import { applyStageGateOnAdvance } from "../playbooks/stage-gate.js";

const logger = createLogger({ module: "focus-sessions/advance-stage" });

/**
 * The columns this door reads off the session row as it stood BEFORE the
 * advance. Structural (not `typeof focusSessions.$inferSelect`) so the
 * @synap/jobs IoC slot can mirror it with no import across the api↔jobs cycle.
 */
export interface StageAdvanceSession {
  id: string;
  currentStage: string | null;
  workspaceId: string | null;
  projectId: string | null;
  channelId: string | null;
  playbookId: string | null;
  subjectEntityId: string | null;
}

export interface AdvanceSessionStageInput {
  /** The session row as loaded BEFORE the advance — `fromStage` is read from it. */
  session: StageAdvanceSession;
  /** The stage key being entered (`PlaybookStage.key`). */
  toStage: string;
  /**
   * The human this advance is attributed to and, when the stage gates, the human
   * who reviews the gate proposal. The session owner on every door today.
   */
  userId: string;
  /** Set when an AGENT key drove the advance, so provenance sees it. */
  agentUserId?: string | null;
  /** See the header — who wrote `focus_sessions.current_stage`. */
  stageWrite: "caller" | "door";
}

export interface AdvanceSessionStageResult {
  /** False when `toStage` equals the stage the session was already on. */
  changed: boolean;
  /** True when the stage entered declares a gate (human or check). */
  gated: boolean;
  /**
   * True only when the session row was actually flipped to `paused` by the gate.
   * Names what the UPDATE returned, never that the gate code reached its end —
   * a session a human already paused, or one that closed mid-advance, is not
   * dragged back into a state it left.
   */
  paused: boolean;
  proposalId?: string;
  proposalType?: string;
  /**
   * A `check` gate's outcome: whether the left stage's required criteria pass,
   * and which do not. Present only when the stage entered is check-gated.
   */
  check?: { passed: boolean; failing: string[] };
}

const UNCHANGED: AdvanceSessionStageResult = {
  changed: false,
  gated: false,
  paused: false,
};

/**
 * Advance a session into `toStage`: write the stage (when the caller has not),
 * emit `focus_session.stage_changed`, then resolve and apply the human gate.
 *
 * A no-op when the stage did not actually move — the resolver is only consulted
 * on a real transition, so an ungated or stageless run costs nothing.
 *
 * ORDER IS LOAD-BEARING. The gate runs AFTER the stage write and AFTER the emit:
 * the gate is a PAUSE, not a veto (services/playbooks/stage-gate.ts explains
 * why at length). The stage stands; the run is simply not running until a person
 * answers, and approval is then a one-field state change rather than a replay of
 * a stale patch.
 */
export async function advanceSessionStage(
  input: AdvanceSessionStageInput
): Promise<AdvanceSessionStageResult> {
  const { session, toStage, userId } = input;
  const fromStage = session.currentStage ?? null;

  if (toStage === fromStage) return UNCHANGED;

  if (input.stageWrite === "door") {
    await db
      .update(focusSessions)
      .set({ currentStage: toStage, updatedAt: new Date() })
      .where(eq(focusSessions.id, session.id));
  }

  // Fire-and-forget, as all four doors already did — a fan-out failure must not
  // fail the advance that already landed. The `.catch` is this door's only
  // behavioural addition over the copies it replaces: three of them left the
  // rejection unhandled, one logged it.
  void emitSideEffects({
    subjectType: "focus_session",
    action: "stage_changed",
    subjectId: session.id,
    userId,
    workspaceId: session.workspaceId,
    data: {
      sessionId: session.id,
      subjectId: session.subjectEntityId,
      playbookId: session.playbookId,
      fromStage,
      toStage,
      workspaceId: session.workspaceId,
      userId,
    },
  }).catch((err) => {
    logger.warn(
      { err, sessionId: session.id, toStage },
      "stage_changed emit failed (non-fatal)"
    );
  });

  const gate = await applyStageGateOnAdvance({
    sessionId: session.id,
    userId,
    agentUserId: input.agentUserId ?? null,
    workspaceId: session.workspaceId,
    projectId: session.projectId,
    channelId: session.channelId,
    playbookId: session.playbookId,
    toStage,
    fromStage,
  });

  if (!gate) return { changed: true, gated: false, paused: false };

  if (gate.kind === "check") {
    return {
      changed: true,
      gated: true,
      paused: gate.paused,
      check: { passed: gate.passed, failing: gate.failing },
    };
  }

  return {
    changed: true,
    gated: true,
    paused: gate.paused,
    proposalId: gate.proposalId,
    proposalType: gate.proposalType,
  };
}
