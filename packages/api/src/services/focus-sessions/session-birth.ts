/**
 * The two birth rules of a session that need api services, each written once
 * and called by every door that births a session from a playbook (the direct
 * start `createFocusSession`, the run funnel `instantiateSessionRow`, and the
 * approved-proposal executor through that funnel). The row itself is written
 * by THE row writer, `insertFocusSessionRow` (`@synap/database`), which also
 * owns the definition snapshot (playbookId, stages, first stage, slot keys).
 *
 * 1. {@link withBirthStageSlots}: a session born INTO its first stage owes
 *    that stage's declared outputs from birth — the rule every later advance
 *    applies (`stage-slots.ts`).
 * 2. {@link writeSessionBirthSubjectMove}: that first stage's `subjectStatus`
 *    is written on the subject, by the advance's own governed writer
 *    (finding e100ddf6, backend#862; a reopen of a done/lost thing proposes,
 *    backend#886). Run AFTER the row is committed: a subject write that fails
 *    is reported, and never fails a session that already exists.
 */
import { createLogger } from "@synap-core/core";
import { firstStageKey } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { stageSlotsToAdd } from "./stage-slots.js";
// Types only, statically: the writer is loaded where it runs (below). A static
// import puts `move-status` → `permission-check` on the doors' graph and
// closes an import cycle through `permission-check` (see complete-session.ts).
import type { StageSubjectStatusOutcome } from "./stage-subject-status.js";

const logger = createLogger({ module: "focus-sessions/session-birth" });

/**
 * `slots` plus the first stage's declared outputs it does not carry yet
 * (matched by key and by label, sanitized through the one floor).
 */
export function withBirthStageSlots(
  playbook: { stages: unknown } | null | undefined,
  slots: ExpectedOutput[]
): ExpectedOutput[] {
  if (!playbook) return slots;
  return [
    ...slots,
    ...stageSlotsToAdd(playbook.stages, firstStageKey(playbook.stages), slots),
  ];
}

/**
 * Write the birth stage's subject status, as the reply reports it
 * (`reportedSubjectMove`: nothing to move ⇒ `undefined`). Never throws.
 */
export async function writeSessionBirthSubjectMove(input: {
  session: {
    id: string;
    playbookId: string | null;
    subjectEntityId: string | null;
    workspaceId: string | null;
    currentStage: string | null;
  };
  /** The person the move is attributed to (the session owner). */
  userId: string;
  /** The agent that started the session: the move is governed as it. */
  agentUserId: string | null;
}): Promise<StageSubjectStatusOutcome | undefined> {
  const { session } = input;
  if (!session.currentStage || !session.subjectEntityId) return undefined;
  try {
    const { writeBirthStageSubjectStatus, reportedSubjectMove } =
      await import("./stage-subject-status.js");
    return reportedSubjectMove(
      await writeBirthStageSubjectStatus({
        session: {
          id: session.id,
          playbookId: session.playbookId,
          subjectEntityId: session.subjectEntityId,
          workspaceId: session.workspaceId,
        },
        toStage: session.currentStage,
        userId: input.userId,
        agentUserId: input.agentUserId,
      })
    );
  } catch (err) {
    logger.warn(
      { err, sessionId: session.id },
      "birth stage subject-status not written — session kept"
    );
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
