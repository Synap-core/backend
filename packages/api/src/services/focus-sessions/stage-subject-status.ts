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
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  entities,
  eq,
  getWorkspaceMembership,
  type StatusMoveActor,
} from "@synap/database";
import type { Hold } from "@synap-core/types/lifecycle";
// The ONE reader of a session's process definition — shared with the reverse
// half in @synap/jobs (`process-sync.ts`).
import { loadSessionProcess } from "@synap/jobs/utils/session-process.js";
import type { Context } from "../../types/context.js";
import { moveStatus, type MoveStatusResult } from "../lifecycle/move-status.js";
import { readSubjectProfile } from "../playbooks/playbook-activators.js";

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
        | "already_set"
        | "subject_not_found"
        | "no_process"
        | "stage_not_found";
    }
  | { status: "failed"; reason: string };

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
]);

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
 * THE ONE WRITER of a process's status value onto ONE thing it works on — the
 * stage path above (the subject, on entering a stage) and the END path
 * (`session-end-moves.ts`: the subject and every target still open, on the
 * session's close) both write through here, so the two can never disagree on
 * the rules:
 *  - a ROLE process moves the role's FACET through the status door, or nothing;
 *  - a thing already at the value is left alone (`already_set`);
 *  - a kind that DECLARES a lifecycle moves through `moveStatus` (its
 *    governance floor: an agent's move into done/lost proposes; a humanOnly
 *    option proposes for an agent) — the process's own `humanOnlyStatuses`
 *    force a proposal for anyone (OR-ed, never a downgrade);
 *  - a kind with NO lifecycle keeps the legacy governed `entities.update`.
 * Every move names the session (`sessionId`), so its transition does too.
 * Never throws: a write that could not happen is `failed`, with why.
 */
export async function writeSubjectStatusValue(input: {
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
   * A session END move (session-end-moves.ts): governed like any write of the
   * closer, without the done/lost default floor (`moveStatus.atSessionEnd`).
   * A stage move never sets it.
   */
  atSessionEnd?: boolean;
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
      ...(input.atSessionEnd ? { atSessionEnd: true } : {}),
    };

    // A ROLE subject: the facet's status, through the door, or nothing.
    const subjectProfile = proc.profileSlug
      ? await readSubjectProfile(proc.profileSlug, session.workspaceId)
      : null;
    if (subjectProfile?.profileKind === "role") {
      const move = await moveStatus({
        ...moveInput,
        role: proc.profileSlug,
        // The lens picks the role's facet when it is attached in several
        // spaces: the run's own space first.
        workspaceId: session.workspaceId ?? subject.workspaceId ?? null,
      });
      return fromMove(move, proc.statusProperty, value);
    }

    const current = (subject.properties as Record<string, unknown> | null)?.[
      proc.statusProperty
    ];
    if (current === value) return { status: "skipped", reason: "already_set" };

    const wsId = subject.workspaceId ?? session.workspaceId ?? null;

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
