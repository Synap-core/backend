/**
 * STAGE ↔ SUBJECT STATUS — the forward half (a run entering a stage writes the
 * subject's lifecycle value).
 *
 * A stage may declare `subjectStatus` (the value of the playbook's
 * `subjectProfile.statusProperty` it corresponds to). When a run advances INTO
 * such a stage, this writes that value onto the run's SUBJECT — through the
 * GOVERNED entity-update door (`entities.update`, which runs
 * `checkPermissionOrPropose`), never a raw UPDATE. An agent-driven advance may
 * therefore come back `proposed`: that is SUCCESS (the human reviews the status
 * change), not an error.
 *
 * Skips, each reported (never thrown — the stage already stands, and a status
 * write that could not happen must not un-advance the run):
 *  - no subject, or the stage declares no `subjectStatus`;
 *  - no status property: the process names none AND its subject kind (or
 *    role) declares no lifecycle. A process that names none follows the
 *    declared lifecycle — `loadSessionProcess` resolves it, once, for every
 *    reader (finding bfae3b84);
 *  - the subject ALREADY holds the value (`already_set`).
 * A caller's reply carries the outcome as `subjectMove`
 * ({@link reportedSubjectMove}) whenever the stage asked for a move.
 *
 * BIRTH (finding e100ddf6): a session born from a staged playbook is seeded
 * INTO its first stage (`create-session.ts`), so that stage's value is written
 * at birth by the same rule — {@link writeBirthStageSubjectStatus}.
 *
 * NOT called (by the advance door) when:
 *  - the advance FOLLOWS the subject (`skipSubjectWrite`, `@synap/jobs`
 *    `utils/process-sync.ts`): the subject is the source of truth there, and a
 *    follow that wrote back ping-ponged on stale events;
 *  - the stage is held by its gate — entering a gated stage is not agreed yet.
 *    A gate's PASS writes it: the stage-gate approval executor
 *    (`routers/proposals/executors/playbook-stage-gate.ts`) for a human gate,
 *    `resumeCheckGateIfMet` (`evaluations/evaluate.ts`) for a held check.
 *
 * STEP = STATUS (work model L5, 2026-10-12): for an ungated `"door"` advance
 * the subject leads, the advance door calls this FIRST and leaves
 * `current_stage` to process-sync's follow (`advance-stage.ts` header). Every
 * other path still calls it after the stage write, as described above.
 *
 * A value listed in `subjectProfile.humanOnlyStatuses` is written with
 * `forcePropose`: whoever drove the advance, a person decides it.
 *
 * A ROLE subject (`subjectProfile.profileSlug` is a role-profile, e.g. `lead`):
 * the status lives on the role's FACET, so the move names the role and goes
 * through the status door only. There is no plain-property fallback for a role
 * — writing `leadStage` into the parent entity's JSONB would be a status no
 * reader looks at, reported as `written`. A role move the door refuses
 * (role not attached, no declared lifecycle, unknown option) is `failed`.
 *
 * Source of the definition: `loadSessionProcess` (@synap/jobs) — the RUN's
 * frozen `definitionSnapshot` first, the live playbook second.
 *
 * ── REACHED ON APPROVAL (decision D2, 17 Nov 2026) ─────────────────────────
 * A stage's `subjectStatus` is the status written when it is ENTERED (an
 * in-progress status). Its `onApproved` is the status the subject REACHES
 * when the stage's work is APPROVED (a result status), written by
 * {@link writeStageReachedStatus} through the same {@link writeSubjectStatusValue}
 * door, at exactly two signals:
 *  1. the stage's declared outputs are all delivered
 *     (the reactions reactor's built-in rule on a slot moving to done:
 *     {@link stagesApprovedBySettledSlots} plans it, one engine — D1);
 *  2. else the NEXT stage's gate passes ({@link writeGatePassStatuses}: the
 *     stage-gate executor, `resumeCheckGateIfMet`, a check gate that passes
 *     on advance) — the reached status of the stage LEFT, THEN the entered
 *     status of the gated stage, both named with the session.
 * Never on a session's end (decision 5e377b06), never at birth. A reached
 * write never moves the subject backwards from any status the process puts
 * after it. A humanOnly `onApproved` is written AS THE APPROVING PERSON (a
 * human actor: governance does not force a person into a proposal), so a
 * person's approval never turns into a second proposal; an agent-driven or
 * automatic approval moves as the agent and proposes it.
 * A run started before D2 keeps its `definitionSnapshot`: a stage with only
 * `subjectStatus` behaves exactly as before.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  entities,
  eq,
  focusSessions,
  getWorkspaceMembership,
  resolveStatusMoveTarget,
  type StatusMoveActor,
} from "@synap/database";
import {
  findLifecycleOption,
  type Hold,
  type LifecycleCategory,
  type TransitionCause,
} from "@synap-core/types/lifecycle";
// The ONE reader of a session's process definition — shared with the reverse
// half in @synap/jobs (`process-sync.ts`).
import { loadSessionProcess } from "@synap/jobs/utils/session-process.js";
import {
  resolveStageGate,
  stageOnApproved,
  type ExpectedOutput,
  type PlaybookStage,
} from "@synap/playbooks";
import type { Context } from "../../types/context.js";
import { moveStatus, type MoveStatusResult } from "../lifecycle/move-status.js";
import { readSubjectProfile } from "../playbooks/playbook-activators.js";
import { deriveSlotKeys } from "@synap-core/types/units";
import {
  stageOutputsApproved,
  stagesDeclaringSlots,
  type SettledSlot,
} from "./stage-outputs-approved.js";

const logger = createLogger({ module: "focus-sessions/stage-subject-status" });

/**
 * `via: "status_door"` — the write went through `moveStatus` (a declared
 * lifecycle, kind or role), so it emits the transition the follow reads.
 * Absent — the legacy plain-property `entities.update` fallback.
 */
export type StageSubjectStatusOutcome =
  | { status: "written"; property: string; value: string; via?: "status_door" }
  | {
      status: "proposed";
      property: string;
      value: string;
      proposalId: string;
      via?: "status_door";
    }
  | {
      status: "skipped";
      reason:
        | "no_subject"
        | "no_status_property"
        | "stage_has_no_subject_status"
        | "stage_has_no_on_approved"
        | "already_set"
        | "subject_not_found"
        | "no_process"
        | "stage_not_found"
        | "subject_ahead";
    }
  | {
      status: "failed";
      reason: string;
      /** The compare-and-set found another status: a person's move won. */
      code?: "moved_meanwhile";
    };

/**
 * What an advance's reply says about the subject move (`subjectMove` on the
 * update doors): the outcome whenever the entered stage ASKED for one —
 * written, proposed, failed, or skipped with why (`no_status_property`,
 * `already_set`, `subject_not_found`). Absent when there was nothing to move:
 * no subject, no process, a stage the process does not declare, a stage with
 * no `subjectStatus`. So a move that did not happen is never silent, and a
 * stage that asks for none adds nothing to the reply.
 */
export function reportedSubjectMove(
  outcome: StageSubjectStatusOutcome | undefined
): StageSubjectStatusOutcome | undefined {
  if (!outcome) return undefined;
  if (outcome.status === "skipped" && NOTHING_TO_MOVE.has(outcome.reason))
    return undefined;
  return outcome;
}

const NOTHING_TO_MOVE: ReadonlySet<string> = new Set([
  "no_subject",
  "no_process",
  "stage_not_found",
  "stage_has_no_subject_status",
  "stage_has_no_on_approved",
]);

/**
 * The status values a process reaches only AFTER a point in its stages: the
 * `subjectStatus` and `onApproved` of every later point, minus any value an
 * earlier-or-same point also writes (a loop back to a shared status is not
 * "ahead"). A stage has two points, in order: ENTERED (its `subjectStatus`),
 * then APPROVED (its `onApproved`). `reached: false` (default) stands at the
 * stage's entry — its own `onApproved` is ahead; `reached: true` stands after
 * its approval. A subject already holding one of them is further along this
 * very process — moving it to the point's value would move it BACKWARDS.
 * Empty for an unknown stage. PURE.
 */
export function statusesAheadOfStage(
  stages: readonly (PlaybookStage | null | undefined)[],
  stageKey: string,
  opts: { reached?: boolean } = {}
): Set<string> {
  const at = stages.findIndex((s) => s?.key === stageKey);
  if (at < 0) return new Set();
  const entered = (s: PlaybookStage | null | undefined) =>
    typeof s?.subjectStatus === "string" && s.subjectStatus.trim()
      ? s.subjectStatus.trim()
      : null;
  // Every point in order: stage i entered (2i), stage i approved (2i + 1).
  const points: Array<string | null> = stages.flatMap((s) => [
    entered(s),
    stageOnApproved(s),
  ]);
  const here = 2 * at + (opts.reached ? 1 : 0);
  const upTo = new Set(
    points.slice(0, here + 1).filter((v): v is string => v !== null)
  );
  return new Set(
    points
      .slice(here + 1)
      .filter((v): v is string => v !== null && !upTo.has(v))
  );
}

/**
 * Write the entered stage's `subjectStatus` onto the session's subject, through
 * the governed entity-update door. See the header for every skip.
 */
export async function writeStageSubjectStatus(input: {
  session: {
    id: string;
    playbookId: string | null;
    subjectEntityId: string | null;
    workspaceId: string | null;
  };
  toStage: string;
  /** The human the advance is attributed to (the session owner). */
  userId: string;
  /** Set when an agent drove the advance — the write is governed as the agent. */
  agentUserId?: string | null;
  /**
   * The session was BORN into this stage ({@link writeBirthStageSubjectStatus}
   * sets it; an advance never does): a move out of done/lost proposes.
   */
  atSessionBirth?: boolean;
  /**
   * What the subject must hold for the move (the status door's
   * compare-and-set, strict for an agent): a gate pass sets it to the status
   * it just reached ({@link writeGatePassStatuses}).
   */
  expectedFrom?: string;
}): Promise<StageSubjectStatusOutcome> {
  const { session } = input;
  if (!session.subjectEntityId)
    return { status: "skipped", reason: "no_subject" };
  try {
    const proc = await loadSessionProcess({
      sessionId: session.id,
      playbookId: session.playbookId,
    });
    if (!proc) return { status: "skipped", reason: "no_process" };
    const stage = proc.stages.find((s) => s?.key === input.toStage);
    if (!stage) return { status: "skipped", reason: "stage_not_found" };
    const value =
      typeof stage.subjectStatus === "string" && stage.subjectStatus.trim()
        ? stage.subjectStatus.trim()
        : null;
    if (!value)
      return { status: "skipped", reason: "stage_has_no_subject_status" };
    // The stage asks for a value, but the process names no status property
    // and its subject kind declares no lifecycle (`loadSessionProcess`
    // resolves the declared one): nothing to write it on.
    if (!proc.statusProperty)
      return { status: "skipped", reason: "no_status_property" };

    const reasoning = `The process entered stage "${stage.name ?? stage.key}", which is "${value}".`;
    // BIRTH never moves a subject BACKWARDS: a run started on a thing that is
    // already further along this process (a post at Scripted when the run's
    // first stage is Brief) leaves it where it is. Writing the first stage's
    // value moved Video 01 from Scripted back to Briefed (pod, 9 Nov 2026),
    // and its "enters Briefed" activator then filed a second run for it.
    const notBackFrom = input.atSessionBirth
      ? statusesAheadOfStage(proc.stages, stage.key)
      : undefined;
    return await writeSubjectStatusValue({
      session,
      entityId: session.subjectEntityId,
      process: { ...proc, statusProperty: proc.statusProperty },
      value,
      reason: reasoning,
      actor: input.agentUserId
        ? {
            kind: "agent",
            userId: input.userId,
            agentUserId: input.agentUserId,
          }
        : { kind: "human", userId: input.userId },
      // A stage that pauses its subject: it waits on the stage (W4).
      pauseHold: {
        on: "thing",
        ref: `stage:${stage.key}`,
        reason: reasoning,
      },
      ...(input.atSessionBirth ? { atSessionBirth: true } : {}),
      ...(notBackFrom && notBackFrom.size > 0 ? { notBackFrom } : {}),
      ...(input.expectedFrom !== undefined
        ? { expectedFrom: input.expectedFrom }
        : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, sessionId: session.id, toStage: input.toStage },
      "stage subject-status write failed — the stage stands"
    );
    return { status: "failed", reason };
  }
}

/**
 * BIRTH: a session seeded INTO its first stage (`create-session.ts`) writes
 * that stage's `subjectStatus` by the rule an advance into it applies
 * (`advance-stage.ts`): an UNGATED stage writes it on entry, through
 * {@link writeStageSubjectStatus}; a GATED stage writes nothing — a stage held
 * by its gate is not agreed yet, and its value belongs to the gate's pass.
 * `undefined` when nothing was attempted (no subject, a gated stage); never
 * throws (a write that could not happen is `failed`, and the session stands).
 *
 * A birth that would take the subject OUT of a done or lost status is
 * PROPOSED, for anyone the governance engine decides (`atSessionBirth`, rung
 * 2.076): starting work on a finished thing may mean it regressed, so the
 * person confirms the reopen — never written directly, never skipped
 * (finding 2d84febb). The reply then says `proposed` with the proposal.
 */
export async function writeBirthStageSubjectStatus(
  input: Parameters<typeof writeStageSubjectStatus>[0]
): Promise<StageSubjectStatusOutcome | undefined> {
  const { session } = input;
  if (!session.subjectEntityId) return undefined;
  try {
    const proc = await loadSessionProcess({
      sessionId: session.id,
      playbookId: session.playbookId,
    });
    const stage = proc?.stages.find((s) => s?.key === input.toStage);
    if (stage && resolveStageGate(stage)) return undefined;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, sessionId: session.id, toStage: input.toStage },
      "birth stage subject-status not written — the session stands"
    );
    return { status: "failed", reason };
  }
  return writeStageSubjectStatus({ ...input, atSessionBirth: true });
}

/** Why a reached status is written: the two approval signals (D2). */
export type StageApprovalSignal = "output_approved" | "gate_passed";

/**
 * WHO APPROVED a stage's work — who its reached status moves as:
 *  - `person`: a person approved (a gate, a proposal, "I did this", an
 *    answer). Moves as them: a humanOnly value is theirs to write.
 *  - `agent`: no person did — an agent's write auto-approved by a rule, an
 *    evidenced claim, a recorded merge, a delivered child run. Moves as an
 *    agent (`agentUserId`, else unattributed) on `userId`'s behalf, governed:
 *    a humanOnly value, or one into done or lost, is proposed to the person.
 */
export type StageApprover =
  | { kind: "person"; userId: string }
  | { kind: "agent"; userId: string; agentUserId?: string | null };

export function approverActor(a: StageApprover): StatusMoveActor {
  return a.kind === "person"
    ? { kind: "human", userId: a.userId }
    : { kind: "agent", userId: a.userId, agentUserId: a.agentUserId ?? null };
}

/**
 * REACHED ON APPROVAL: write stage `stageKey`'s `onApproved` onto the
 * session's subject — its work was approved (`signal`). Through the same
 * door as the entered status ({@link writeSubjectStatusValue}), named with
 * the session. Never moves the subject back from a status the process puts
 * after this stage's approval, done and lost included (`subject_ahead`).
 * `userId` with no `agentUserId` is the APPROVING PERSON: a humanOnly value
 * is theirs to write, so it is written, never re-proposed. Never throws.
 */
export async function writeStageReachedStatus(input: {
  session: {
    id: string;
    playbookId: string | null;
    subjectEntityId: string | null;
    workspaceId: string | null;
  };
  /** The stage whose work was approved. */
  stageKey: string;
  signal: StageApprovalSignal;
  /** Who approved — see {@link StageApprover}. */
  approver: StageApprover;
  /**
   * Who MOVES it, when not the approver: the reactions reactor moves as the
   * `system` (D6) where no person's say is needed (see
   * `services/reactions/reach-stage-status-effect.ts`).
   */
  actor?: StatusMoveActor;
  /** The move that caused this one (a reaction's, reactions W2). */
  cause?: TransitionCause | null;
  /** The status the mover read (the door's compare-and-set). */
  expectedFrom?: string | null;
}): Promise<StageSubjectStatusOutcome> {
  const { session } = input;
  if (!session.subjectEntityId)
    return { status: "skipped", reason: "no_subject" };
  try {
    const proc = await loadSessionProcess({
      sessionId: session.id,
      playbookId: session.playbookId,
    });
    if (!proc) return { status: "skipped", reason: "no_process" };
    const stage = proc.stages.find((s) => s?.key === input.stageKey);
    if (!stage) return { status: "skipped", reason: "stage_not_found" };
    const value = stageOnApproved(stage);
    if (!value)
      return { status: "skipped", reason: "stage_has_no_on_approved" };
    if (!proc.statusProperty)
      return { status: "skipped", reason: "no_status_property" };
    const why =
      input.signal === "gate_passed"
        ? "the next stage's gate passed"
        : "its outputs were approved";
    const reasoning = `The work of stage "${stage.name ?? stage.key}" was approved (${why}), which is "${value}".`;
    const notBackFrom = statusesAheadOfStage(proc.stages, stage.key, {
      reached: true,
    });
    return await writeSubjectStatusValue({
      session,
      entityId: session.subjectEntityId,
      process: { ...proc, statusProperty: proc.statusProperty },
      value,
      reason: reasoning,
      actor: input.actor ?? approverActor(input.approver),
      ...(notBackFrom.size > 0 ? { notBackFrom, notBackFromStrict: true } : {}),
      ...(input.cause ? { cause: input.cause } : {}),
      ...(input.expectedFrom !== undefined && input.expectedFrom !== null
        ? { expectedFrom: input.expectedFrom }
        : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, sessionId: session.id, stageKey: input.stageKey },
      "stage reached-status write failed — the approval stands"
    );
    return { status: "failed", reason };
  }
}

/**
 * A GATE PASSED on `gatedStage` (approval signal 2): the stage LEFT
 * (`fromStage`, else the one declared just before the gated stage) reached
 * its `onApproved`, THEN the gated stage's `subjectStatus` is written — in
 * that order, both named with the session, so the subject's history reads
 * "Scripted, then In Draft". The entered write expects the reached value when
 * it was written (the door's compare-and-set). `reached` is absent when the
 * stage left declares no `onApproved` (or none was left). Never throws.
 */
export async function writeGatePassStatuses(input: {
  session: Parameters<typeof writeStageSubjectStatus>[0]["session"];
  gatedStage: string;
  /** The stage the run left to enter the gated one, when recorded. */
  fromStage?: string | null;
  userId: string;
  agentUserId?: string | null;
}): Promise<{
  reached?: StageSubjectStatusOutcome;
  entered: StageSubjectStatusOutcome;
}> {
  const left = await stageLeftForGate(
    input.session,
    input.gatedStage,
    input.fromStage
  );
  const reached = left
    ? reportedSubjectMove(
        await writeStageReachedStatus({
          session: input.session,
          stageKey: left,
          signal: "gate_passed",
          approver: input.agentUserId
            ? {
                kind: "agent",
                userId: input.userId,
                agentUserId: input.agentUserId,
              }
            : { kind: "person", userId: input.userId },
        })
      )
    : undefined;
  const entered = await writeStageSubjectStatus({
    session: input.session,
    toStage: input.gatedStage,
    userId: input.userId,
    agentUserId: input.agentUserId ?? null,
    ...(reached?.status === "written" ? { expectedFrom: reached.value } : {}),
  });
  return { ...(reached ? { reached } : {}), entered };
}

/** The stage a gate pass approves: the recorded `fromStage`, else the previous. */
async function stageLeftForGate(
  session: { id: string; playbookId: string | null },
  gatedStage: string,
  fromStage: string | null | undefined
): Promise<string | null> {
  if (typeof fromStage === "string" && fromStage && fromStage !== gatedStage)
    return fromStage;
  try {
    const proc = await loadSessionProcess({
      sessionId: session.id,
      playbookId: session.playbookId,
    });
    const at = proc?.stages.findIndex((s) => s?.key === gatedStage) ?? -1;
    return at > 0 ? (proc!.stages[at - 1]?.key ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * APPROVAL SIGNAL 1, the PLAN: a slot of the session was just settled
 * (approved, attested, answered, evidenced, merged, met by its ref). Which
 * stages does that approve? A stage that declares an `onApproved` and
 * outputs, every one of them now delivered ({@link stageOutputsApproved}).
 * The stages judged: the one the run stands on, and every EARLIER stage that
 * declares one of the `settled` slots — a run may move on before its slot
 * settles (a pull request merged after the run reached the next stage), and
 * the stage whose work it was still reaches its status. A later stage never:
 * its slots do not exist yet. In stage order, so the history reads as the
 * work did. Read only: the reactions reactor's built-in rule
 * `builtin:approved-output-reaches-status` plans with it and writes each one
 * through {@link writeStageReachedStatus} (decision D1: one engine).
 */
export async function stagesApprovedBySettledSlots(input: {
  sessionId: string;
  /** The slots that settled (key and/or label). */
  settled: readonly SettledSlot[];
}): Promise<{
  session: {
    id: string;
    playbookId: string | null;
    subjectEntityId: string;
    workspaceId: string | null;
    userId: string;
  };
  stages: Array<{ stageKey: string; stageName: string; value: string }>;
} | null> {
  const [row] = await db
    .select({
      id: focusSessions.id,
      playbookId: focusSessions.playbookId,
      subjectEntityId: focusSessions.subjectEntityId,
      workspaceId: focusSessions.workspaceId,
      userId: focusSessions.userId,
      currentStage: focusSessions.currentStage,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(eq(focusSessions.id, input.sessionId))
    .limit(1);
  if (!row?.subjectEntityId || !row.currentStage) return null;
  const proc = await loadSessionProcess({
    sessionId: row.id,
    playbookId: row.playbookId,
  });
  if (!proc) return null;
  const at = proc.stages.findIndex((s) => s?.key === row.currentStage);
  if (at < 0) return null;
  const slots: ExpectedOutput[] = Array.isArray(row.expectedOutputs)
    ? (row.expectedOutputs as ExpectedOutput[])
    : [];
  // A slot's move names it by its KEY (stamped, or derived from its label);
  // a stage declares it by label. Name each settled slot both ways, from the
  // slot as the session stores it.
  const keys = deriveSlotKeys(slots);
  const named = input.settled.flatMap((x) => {
    const at = x.key ? keys.indexOf(x.key) : -1;
    return at >= 0 ? [x, { key: x.key, label: slots[at]?.label ?? null }] : [x];
  });
  const declaring = new Set(stagesDeclaringSlots(proc.stages, named));
  const stages: Array<{ stageKey: string; stageName: string; value: string }> =
    [];
  for (const stage of proc.stages.slice(0, at + 1)) {
    const key = stage?.key;
    const value = stageOnApproved(stage);
    if (!key || !value) continue;
    if (key !== row.currentStage && !declaring.has(key)) continue;
    if (!stageOutputsApproved(proc.stages, key, slots)) continue;
    stages.push({ stageKey: key, stageName: stage.name ?? key, value });
  }
  const { currentStage: _c, expectedOutputs: _e, ...session } = row;
  return {
    session: { ...session, subjectEntityId: row.subjectEntityId },
    stages,
  };
}

/**
 * Where a reached status would land, read where its move would read it (the
 * role's facet, else the kind's declared lifecycle): the status the subject
 * holds NOW (the compare-and-set's belief), the value's category (done and
 * lost are proposed by a reaction, D3) and whether only a person may move a
 * thing into it (`humanOnly` on the lifecycle, or the process's own list).
 * Null when the subject is gone or declares no lifecycle. Read only.
 */
export async function readReachedMoveTarget(input: {
  session: {
    id: string;
    playbookId: string | null;
    workspaceId: string | null;
  };
  subjectEntityId: string;
  value: string;
}): Promise<{
  current: string | null;
  category: LifecycleCategory;
  humanOnly: boolean;
  /** The person's words: the thing's title and the value's label. */
  title: string;
  label: string;
} | null> {
  const proc = await loadSessionProcess({
    sessionId: input.session.id,
    playbookId: input.session.playbookId,
  });
  if (!proc) return null;
  const [subject] = await db
    .select({ workspaceId: entities.workspaceId, title: entities.title })
    .from(entities)
    .where(eq(entities.id, input.subjectEntityId))
    .limit(1);
  if (!subject) return null;
  const subjectProfile = proc.profileSlug
    ? await readSubjectProfile(proc.profileSlug, input.session.workspaceId)
    : null;
  const isRole = subjectProfile?.profileKind === "role";
  const target = await resolveStatusMoveTarget(db, {
    entityId: input.subjectEntityId,
    ...(isRole
      ? {
          role: proc.profileSlug,
          workspaceId: input.session.workspaceId ?? subject.workspaceId ?? null,
        }
      : {
          workspaceId: subject.workspaceId ?? input.session.workspaceId ?? null,
        }),
  });
  if (!target.ok) return null;
  const option = findLifecycleOption(target.target.lifecycle, input.value);
  if (!option) return null;
  const current = target.target.current;
  return {
    current: typeof current === "string" ? current : null,
    category: option.category,
    humanOnly:
      option.humanOnly === true || proc.humanOnlyStatuses.includes(input.value),
    title: subject.title?.trim() || "this",
    label: option.label?.trim() || input.value,
  };
}

/**
 * THE ONE WRITER of a process's status value onto ONE thing it works on (the
 * stage path above: the subject, on entering a stage, or at the session's
 * birth). A session's END moves nothing (decision 5e377b06). The rules:
 *  - a ROLE process moves the role's FACET through the status door, or nothing;
 *  - a thing already at the value is left alone (`already_set`);
 *  - a BIRTH move out of a done or lost status proposes (`atSessionBirth`);
 *  - a kind that DECLARES a lifecycle moves through `moveStatus` (its
 *    governance floor: an agent's move into done/lost proposes; a humanOnly
 *    option proposes for an agent) — the process's own `humanOnlyStatuses`
 *    force a proposal for anyone (OR-ed, never a downgrade);
 *  - a kind with NO lifecycle keeps the legacy governed `entities.update`.
 * Every move names the session (`sessionId`), so its transition does too.
 * Never throws: a write that could not happen is `failed`, with why.
 */
async function writeSubjectStatusValue(input: {
  session: { id: string; workspaceId: string | null };
  /** The thing to move: the session's subject, or one of its targets. */
  entityId: string;
  process: {
    profileSlug: string | null;
    statusProperty: string;
    humanOnlyStatuses: string[];
  };
  value: string;
  /** Shown on the move (and its proposal) as why. */
  reason: string;
  /** Who moves it: the person, or the agent (on the person's behalf). */
  actor: StatusMoveActor;
  /** The hold to record when the move pauses the thing (a stage's own). */
  pauseHold?: Hold;
  /**
   * A session BIRTH move (the session started into this stage): a move out
   * of done/lost proposes (`moveStatus.atSessionBirth`). Set ONLY by
   * {@link writeBirthStageSubjectStatus}.
   */
  atSessionBirth?: boolean;
  /**
   * Values the thing must not be moved back FROM (a birth's
   * {@link statusesAheadOfStage}): a thing already holding one is left where
   * it is, `skipped: subject_ahead`.
   */
  notBackFrom?: ReadonlySet<string>;
  /**
   * `notBackFrom` holds for EVERY status, done and lost included: a reached
   * status never reopens a thing (a birth's reopen is proposed instead).
   */
  notBackFromStrict?: boolean;
  /** The status door's compare-and-set belief (`moveStatus.expectedFrom`). */
  expectedFrom?: string;
  /** The move that caused this one (a reaction's): stamped on the transition. */
  cause?: TransitionCause;
}): Promise<StageSubjectStatusOutcome> {
  const { session, entityId, value, reason, actor } = input;
  const proc = input.process;
  try {
    const [subject] = await db
      .select({
        properties: entities.properties,
        workspaceId: entities.workspaceId,
      })
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);
    if (!subject) return { status: "skipped", reason: "subject_not_found" };

    // A ROLE subject: the facet's status, through the door, or nothing.
    const subjectProfile = proc.profileSlug
      ? await readSubjectProfile(proc.profileSlug, session.workspaceId)
      : null;
    const isRole = subjectProfile?.profileKind === "role";
    // The lens picks the role's facet when it is attached in several spaces:
    // the run's own space first. A kind moves in its own space.
    const roleWorkspaceId = session.workspaceId ?? subject.workspaceId ?? null;
    const wsId = subject.workspaceId ?? session.workspaceId ?? null;

    if (input.notBackFrom && input.notBackFrom.size > 0) {
      // The value the thing holds NOW, read where its move would read it: the
      // role's facet, the kind's declared lifecycle, else the plain property.
      const target = await resolveStatusMoveTarget(db, {
        entityId,
        ...(isRole
          ? { role: proc.profileSlug, workspaceId: roleWorkspaceId }
          : { workspaceId: wsId }),
      });
      const current = target.ok
        ? target.target.current
        : (subject.properties as Record<string, unknown> | null)?.[
            proc.statusProperty
          ];
      // A thing that is DONE or LOST is not "further along": starting work on
      // it is a reopen, which the status door proposes at birth
      // (`atSessionBirth`, finding 2d84febb). Only a thing still in progress
      // at a later stage is left where it is.
      const category = target.ok
        ? findLifecycleOption(target.target.lifecycle, target.target.current)
            ?.category
        : undefined;
      if (
        typeof current === "string" &&
        input.notBackFrom.has(current) &&
        (input.notBackFromStrict ||
          (category !== "done" && category !== "lost"))
      ) {
        return { status: "skipped", reason: "subject_ahead" };
      }
    }

    const humanOnly = proc.humanOnlyStatuses.includes(value);
    const moveInput = {
      entityId,
      property: proc.statusProperty,
      to: value,
      // No belief to defend: the process decides the value; the door's own
      // compare-and-set still guards the read→write window.
      actor,
      sessionId: session.id,
      reason,
      forcePropose: humanOnly || undefined,
      ...(input.pauseHold ? { pauseHold: input.pauseHold } : {}),
      ...(input.atSessionBirth ? { atSessionBirth: true } : {}),
      ...(input.expectedFrom !== undefined
        ? { expectedFrom: input.expectedFrom }
        : {}),
      ...(input.cause ? { cause: input.cause } : {}),
    };

    if (isRole) {
      const move = await moveStatus({
        ...moveInput,
        role: proc.profileSlug,
        workspaceId: roleWorkspaceId,
      });
      return fromMove(move, proc.statusProperty, value);
    }

    const current = (subject.properties as Record<string, unknown> | null)?.[
      proc.statusProperty
    ];
    if (current === value) return { status: "skipped", reason: "already_set" };

    // THE status door (work model L2) when the playbook's statusProperty IS
    // the subject kind's declared lifecycle: compare-and-set, the lifecycle
    // governance floor (a human-only / closing option proposes for an agent),
    // one transition event. The playbook's own `humanOnlyStatuses` still
    // force a proposal (OR-ed, never a downgrade).
    // A kind that DECLARES a lifecycle has one ladder: a playbook whose
    // statusProperty is another field is refused (NOT_THE_LIFECYCLE, with
    // guidance, via `fromMove`) — never written as a plain property beside it
    // (review arch F2). Only a kind with NO lifecycle takes the legacy path.
    const move = await moveStatus({ ...moveInput, workspaceId: wsId });
    const undeclared =
      move.status === "refused" && move.code === "NO_LIFECYCLE";
    if (!undeclared) return fromMove(move, proc.statusProperty, value);

    // The kind declares no lifecycle: `statusProperty` is a plain property,
    // written through the governed entity-update door as before —
    // `entities.update` as the session owner, attributed to the agent when one
    // drove the move, inside the session (its forceProposeWrites governance
    // applies).
    let workspaceRole = "owner";
    if (wsId) {
      const membership = await getWorkspaceMembership(db, wsId, actor.userId);
      if (membership) workspaceRole = membership.role;
    }
    const { entitiesRouter } = await import("../../routers/entities.js");
    const caller = entitiesRouter.createCaller({
      db,
      authenticated: true,
      userId: actor.userId,
      workspaceId: wsId,
      workspaceRole,
      sessionId: session.id,
    } as unknown as Context);
    const res = (await caller.update({
      id: entityId,
      properties: { [proc.statusProperty]: value },
      ...(actor.kind === "agent"
        ? {
            ...(actor.agentUserId ? { agentUserId: actor.agentUserId } : {}),
            source: "agent" as const,
          }
        : { source: "user" as const }),
      reasoning: reason,
      ...(humanOnly ? { forcePropose: true } : {}),
    })) as { status?: string; proposalId?: string };
    if (res?.status === "proposed" && res.proposalId) {
      return {
        status: "proposed",
        property: proc.statusProperty,
        value,
        proposalId: res.proposalId,
      };
    }
    return { status: "written", property: proc.statusProperty, value };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, sessionId: session.id, entityId, value },
      "process status write failed — what triggered it stands"
    );
    return { status: "failed", reason: why };
  }
}

/** The status door's answer → this write's outcome. */
function fromMove(
  move: MoveStatusResult,
  property: string,
  value: string
): StageSubjectStatusOutcome {
  switch (move.status) {
    case "moved":
      return { status: "written", property, value, via: "status_door" };
    case "unchanged":
      return { status: "skipped", reason: "already_set" };
    case "proposed":
      return {
        status: "proposed",
        property,
        value,
        proposalId: move.proposalId,
        via: "status_door",
      };
    case "conflict":
      return {
        status: "failed",
        reason: `the subject's status moved meanwhile (now "${move.actual ?? "none"}")`,
        code: "moved_meanwhile",
      };
    case "refused":
      return {
        status: "failed",
        reason:
          move.code === "NOT_THE_LIFECYCLE"
            ? `${move.reason}. This process moves "${property}"; point its statusProperty at the declared lifecycle instead of running a second status ladder.`
            : move.reason,
      };
    case "denied":
      return { status: "failed", reason: move.reason };
  }
}
