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
 *
 * ── STEP = STATUS (work model L5, 2026-10-12) ───────────────────────────────
 * For a run whose subject carries the process's status, the step IS the
 * subject's status. A `"door"` advance into an UNGATED stage that declares a
 * `subjectStatus` (and is the stage that status maps back to) therefore moves
 * the SUBJECT first — through `writeStageSubjectStatus`, whose `moveStatus`
 * call is the one status door (R1, kinds and roles) — and, when that door took
 * it (`via: "status_door"`, a DECLARED lifecycle), does NOT write
 * `current_stage`: the subject's move
 * fires its event and process-sync's follow advances the run through this same
 * door (`skipSubjectWrite`), which writes the column, merges the slots and
 * emits `stage_changed`. A move that is `proposed` advances the run when the
 * person approves it. The result says so (`stageFollowsSubject`).
 *
 * Still writing `current_stage` directly, stated so nobody mistakes it for
 * done: the `"caller"` doors (their multi-field UPDATE, above), a GATED stage
 * (the gate pauses AFTER the stage stands; its pass writes the status), a
 * subject that already holds the value (no event would follow), a failed
 * subject write, and a kind with NO declared lifecycle (its legacy
 * `entities.update` fallback writes the status property; the column is then
 * written here as before). The caller doors and the gated path are pinned by
 * the shrink-only block of `__tripwires__/current-stage-one-door.test.ts` —
 * wave 5: gate executor + routers, with L7.
 */

import { db, focusSessions, eq, and } from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";
import {
  resolveStageGate,
  resolveStageRef,
  stageForSubjectStatus,
} from "@synap/playbooks";
import { loadSessionProcess } from "@synap/jobs/utils/session-process.js";
import { applyStageGateOnAdvance } from "../playbooks/stage-gate.js";
import { mergeEnteredStageSlots } from "./stage-slots.js";
import {
  writeStageSubjectStatus,
  type StageSubjectStatusOutcome,
} from "./stage-subject-status.js";

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
  /**
   * Set ONLY by this door when it returns a run to a failed check gate's
   * `onFail` stage — so that return is never itself re-routed (a target whose
   * own check also fails holds there, it does not ping-pong).
   */
  viaOnFail?: boolean;
  /**
   * The advance FOLLOWS the subject (process-sync: the subject entered the
   * stage's status), so the subject already holds it — never write it back.
   * A follow that wrote back re-fired on every stale event and ping-ponged.
   */
  skipSubjectWrite?: boolean;
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
  /**
   * The forward half of stage ↔ subject status: what happened to the entered
   * stage's `subjectStatus` (written / proposed / skipped + why / failed).
   * Absent when the stage was held by its gate (the gate's pass writes it) and
   * when the advance followed the subject (`skipSubjectWrite`).
   */
  subjectStatus?: StageSubjectStatusOutcome;
  /** Set when a failed check gate returned the run to its `onFail` stage. */
  onFail?: { toStage: string };
  /**
   * STEP = STATUS: the subject was moved (or its move proposed) and this door
   * did NOT write `current_stage` — the follow writes it when the move lands.
   * See the header.
   */
  stageFollowsSubject?: true;
  /**
   * The entered stage's declared `expectedOutputs` merged into the session's
   * slots (`stage-slots.ts`): the labels added, or why the merge failed.
   * Absent when the stage declares none.
   */
  stageSlots?: { added: string[] } | { error: string };
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

  // STEP = STATUS (see the header): the subject moves, the run follows it.
  let subjectFirst: StageSubjectStatusOutcome | undefined;
  if (input.stageWrite === "door" && !input.skipSubjectWrite) {
    subjectFirst = await moveSubjectFirst(input);
    if (
      (subjectFirst?.status === "written" ||
        subjectFirst?.status === "proposed") &&
      subjectFirst.via === "status_door"
    ) {
      return {
        changed: true,
        gated: false,
        paused: false,
        subjectStatus: subjectFirst,
        stageFollowsSubject: true,
      };
    }
  }

  if (input.stageWrite === "door") {
    await db
      .update(focusSessions)
      .set({ currentStage: toStage, updatedAt: new Date() })
      .where(eq(focusSessions.id, session.id));
  }

  // The stage is ENTERED: what it owes becomes the session's slots, gated or
  // not (a gate holds the run, not the stage's deliverables). After the stage
  // write, under the session row lock — the caller's own multi-field UPDATE
  // has landed. A failed merge never undoes the advance; it is reported.
  const stageSlots = await mergeStageSlotsOnEntry(session, toStage);

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

  // An UNGATED stage writes its `subjectStatus` on entry; a GATED stage writes
  // it when its gate passes (a check that passes now, a check resumed later by
  // `resumeCheckGateIfMet`, a human gate on approval) — never while it holds.
  const writeSubject = (): Promise<StageSubjectStatusOutcome> | undefined =>
    input.skipSubjectWrite
      ? undefined
      : // Already attempted (subject-first) — report it, never write twice.
        subjectFirst
        ? Promise.resolve(subjectFirst)
        : writeStageSubjectStatus({
            session,
            toStage,
            userId,
            agentUserId: input.agentUserId ?? null,
          });

  const slots = stageSlots ? { stageSlots } : {};

  if (!gate) {
    const subjectStatus = await writeSubject();
    return {
      changed: true,
      gated: false,
      paused: false,
      ...(subjectStatus ? { subjectStatus } : {}),
      ...slots,
    };
  }

  if (gate.kind === "check") {
    const result: AdvanceSessionStageResult = {
      changed: true,
      gated: true,
      paused: gate.paused,
      check: { passed: gate.passed, failing: gate.failing },
      ...slots,
    };
    if (!gate.paused) {
      const subjectStatus = await writeSubject();
      if (subjectStatus) result.subjectStatus = subjectStatus;
      return result;
    }
    // A HOLDING check gate whose stage declares `onFail` returns the run there
    // (un-paused, through this same door) instead of leaving it parked. The
    // hold's `metadata.checkGate` record stays — it is why the run went back.
    if (!input.viaOnFail) {
      const back = await returnToOnFailStage({ ...input, fromStage });
      if (back) result.onFail = { toStage: back };
    }
    return result;
  }

  // A human gate HOLDS the stage until a person answers: the subject status is
  // written on approval (`playbook-stage-gate.ts` executor), not here.
  return {
    changed: true,
    gated: true,
    paused: gate.paused,
    proposalId: gate.proposalId,
    proposalType: gate.proposalType,
    ...slots,
  };
}

/** Session statuses process-sync's follow moves (`FOLLOWING_SESSION_STATUSES`). */
const SUBJECT_LEADS_STATUSES = new Set(["active", "forming"]);

/**
 * STEP = STATUS: when the entered stage is one the subject's status leads,
 * write the subject FIRST and return its outcome; `undefined` when this
 * advance is not one (it then writes the column as before). Never throws.
 */
async function moveSubjectFirst(
  input: AdvanceSessionStageInput
): Promise<StageSubjectStatusOutcome | undefined> {
  const { session, toStage } = input;
  if (!session.subjectEntityId) return undefined;
  try {
    const proc = await loadSessionProcess({
      sessionId: session.id,
      playbookId: session.playbookId,
    });
    if (!proc?.statusProperty) return undefined;
    const stage = proc.stages.find((s) => s?.key === toStage);
    const value =
      typeof stage?.subjectStatus === "string"
        ? stage.subjectStatus.trim()
        : "";
    if (!stage || !value) return undefined;
    // A gated stage keeps "the stage stands, the gate pauses" (stage-gate.ts).
    if (resolveStageGate(stage)) return undefined;
    // The follow lands on the FIRST stage declaring the value; only when that
    // is this stage does the subject lead to exactly here.
    if (stageForSubjectStatus(proc.stages, value) !== toStage) return undefined;
    // The follow only moves an in-flight run.
    const [row] = await db
      .select({ status: focusSessions.status })
      .from(focusSessions)
      .where(eq(focusSessions.id, session.id))
      .limit(1);
    if (!row || !SUBJECT_LEADS_STATUSES.has(row.status as string))
      return undefined;
    return await writeStageSubjectStatus({
      session,
      toStage,
      userId: input.userId,
      agentUserId: input.agentUserId ?? null,
    });
  } catch (err) {
    logger.warn(
      { err, sessionId: session.id, toStage },
      "subject-first advance not taken (the stage is written directly)"
    );
    return undefined;
  }
}

/** {@link mergeEnteredStageSlots} over the run's own stages; never throws. */
async function mergeStageSlotsOnEntry(
  session: StageAdvanceSession,
  toStage: string
): Promise<AdvanceSessionStageResult["stageSlots"]> {
  try {
    const proc = await loadSessionProcess({
      sessionId: session.id,
      playbookId: session.playbookId,
    });
    if (!proc) return undefined;
    const r = await mergeEnteredStageSlots({
      sessionId: session.id,
      stageKey: toStage,
      stages: proc.stages,
    });
    return r.added.length > 0 ? r : undefined;
  } catch (err) {
    logger.warn(
      { err, sessionId: session.id, toStage },
      "stage slots merge failed (the advance stands)"
    );
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The `onFail` return for a check gate that held: resolve the entered stage's
 * `onFail.toStage` (key or name), un-pause the run (guarded on `paused`), and
 * advance it there through THIS door with `viaOnFail` set. Returns the stage it
 * went to, or null when the stage declares no (resolvable) `onFail`.
 */
async function returnToOnFailStage(
  input: AdvanceSessionStageInput & { fromStage: string | null }
): Promise<string | null> {
  const { session, toStage } = input;
  const proc = await loadSessionProcess({
    sessionId: session.id,
    playbookId: session.playbookId,
  });
  if (!proc) return null;
  const stage = proc.stages.find((s) => s?.key === toStage);
  const target = resolveStageRef(proc.stages, stage?.onFail?.toStage);
  if (!target || target === toStage) return null;
  const resumed = await db
    .update(focusSessions)
    .set({ status: "active", updatedAt: new Date() })
    .where(
      and(eq(focusSessions.id, session.id), eq(focusSessions.status, "paused"))
    )
    .returning({ id: focusSessions.id });
  if (resumed.length === 0) return null;
  await advanceSessionStage({
    session: { ...session, currentStage: toStage },
    toStage: target,
    userId: input.userId,
    agentUserId: input.agentUserId ?? null,
    stageWrite: "door",
    viaOnFail: true,
  });
  return target;
}
