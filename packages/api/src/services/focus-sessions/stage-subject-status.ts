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
 *  - no subject, no `statusProperty`, or the stage declares no `subjectStatus`;
 *  - the subject ALREADY holds the value — this is also the LOOP GUARD: the
 *    reverse half (a subject entering a status advances the run,
 *    `jobs/src/utils/subject-stage-sync.ts`) advances through the ONE advance
 *    door, which calls back here; the subject already holds the value it just
 *    entered, so nothing is written and nothing re-fires;
 *  - the stage is held by its gate (`paused`) — entering a gated stage is not
 *    agreed yet; the stage-gate approval writes it (`applyApprovedStageStatus`).
 *
 * A value listed in `subjectProfile.humanOnlyStatuses` is written with
 * `forcePropose`: whoever drove the advance, a person decides it.
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
} from "@synap/database";
// The ONE reader of a session's process definition — shared with the reverse
// half in @synap/jobs (`process-sync.ts`).
import { loadSessionProcess } from "@synap/jobs/utils/session-process.js";
import type { Context } from "../../types/context.js";

const logger = createLogger({ module: "focus-sessions/stage-subject-status" });

export type StageSubjectStatusOutcome =
  | { status: "written"; property: string; value: string }
  | { status: "proposed"; property: string; value: string; proposalId: string }
  | {
      status: "skipped";
      reason:
        | "no_subject"
        | "no_status_property"
        | "stage_has_no_subject_status"
        | "already_set"
        | "subject_not_found"
        | "stage_not_found";
    }
  | { status: "failed"; reason: string };

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
  if (!session.subjectEntityId) return { status: "skipped", reason: "no_subject" };
  try {
    const proc = await loadSessionProcess({
      sessionId: session.id,
      playbookId: session.playbookId,
    });
    if (!proc) return { status: "skipped", reason: "stage_not_found" };
    if (!proc.statusProperty)
      return { status: "skipped", reason: "no_status_property" };
    const stage = proc.stages.find((s) => s?.key === input.toStage);
    if (!stage) return { status: "skipped", reason: "stage_not_found" };
    const value =
      typeof stage.subjectStatus === "string" && stage.subjectStatus.trim()
        ? stage.subjectStatus.trim()
        : null;
    if (!value)
      return { status: "skipped", reason: "stage_has_no_subject_status" };

    const [subject] = await db
      .select({ properties: entities.properties, workspaceId: entities.workspaceId })
      .from(entities)
      .where(eq(entities.id, session.subjectEntityId))
      .limit(1);
    if (!subject) return { status: "skipped", reason: "subject_not_found" };
    const current = (subject.properties as Record<string, unknown> | null)?.[
      proc.statusProperty
    ];
    if (current === value) return { status: "skipped", reason: "already_set" };

    // THE governed door: `entities.update` as the session owner, attributed to
    // the agent when one drove the advance, inside the session (its
    // forceProposeWrites governance applies).
    const wsId = subject.workspaceId ?? session.workspaceId ?? null;
    let workspaceRole = "owner";
    if (wsId) {
      const membership = await getWorkspaceMembership(db, wsId, input.userId);
      if (membership) workspaceRole = membership.role;
    }
    const { entitiesRouter } = await import("../../routers/entities.js");
    const caller = entitiesRouter.createCaller({
      db,
      authenticated: true,
      userId: input.userId,
      workspaceId: wsId,
      workspaceRole,
      sessionId: session.id,
    } as unknown as Context);
    const res = (await caller.update({
      id: session.subjectEntityId,
      properties: { [proc.statusProperty]: value },
      ...(input.agentUserId
        ? { agentUserId: input.agentUserId, source: "agent" as const }
        : { source: "user" as const }),
      reasoning: `The process entered stage "${stage.name ?? stage.key}", which is "${value}".`,
      ...(proc.humanOnlyStatuses.includes(value) ? { forcePropose: true } : {}),
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
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, sessionId: session.id, toStage: input.toStage },
      "stage subject-status write failed — the stage stands"
    );
    return { status: "failed", reason };
  }
}
