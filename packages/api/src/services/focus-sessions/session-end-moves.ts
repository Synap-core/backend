/**
 * SESSION END → STATUS: a session's end moves the things it worked on.
 *
 * A playbook's process may declare `subjectProfile.onEnd` — per terminal
 * status (`closed` / `cancelled` / `failed`), the status of the subject's
 * lifecycle its things move to when the session ENDS that way (e.g. a "Fix a
 * finding" process: `{ cancelled: "open", failed: "open" }`). The one close
 * door (`complete-session.ts`) applies it, after the close commits, to:
 *  - the session's SUBJECT, and
 *  - every worker TARGET still open at the close (the ids the close's own
 *    `skipped` stamp just settled). A target the session already settled
 *    (done, failed, skipped by someone else's move) is left alone: its result
 *    says what happened to it.
 *
 * NEVER OUT OF DONE OR LOST: an end move is cleanup of work that stopped. A
 * subject or target whose status is already in a done or lost category
 * (another session verified it, a person closed it) is left alone and
 * reported `skipped: already_settled` — read from the thing's CURRENT status
 * at the close, never assumed (finding 8f1c774f: a stale session cancelled
 * after another verified its finding moved it back to "open").
 *
 * Each move goes through THE writer the stage path uses
 * (`writeSubjectStatusValue`, stage-subject-status.ts): the status door as
 * the session, governed like any write of the closer (its rules: an "ask
 * first" agent's move proposes), a humanOnly value proposing for an agent, the
 * process's own `humanOnlyStatuses` proposing for anyone, a role process
 * moving the facet, a thing already there left alone. Unlike a stage move, an
 * end move skips the done/lost default floor: the session having to END is the
 * guardrail (founder, 2026-11-05; governance `lifecycleMove.atSessionEnd`). A move that could not happen is reported,
 * never thrown: the session has ended, and a failed move must not undo that.
 *
 * NOT here, on purpose: `stale` (the reaper's mark, not an end — pod
 * knowledge b2c210d9) never reaches the close door, so it moves nothing.
 * A terminal status the process gives no entry moves nothing.
 *
 * The process is read by the close door BEFORE it settles the run
 * (`loadSessionProcess` reads a LIVE run's frozen snapshot first), so the
 * frozen `onEnd` is the one applied, not a later edit of the playbook.
 */
import type { StatusMoveActor } from "@synap/database";
import type { SessionProcess } from "@synap/jobs/utils/session-process.js";
import {
  writeSubjectStatusValue,
  type StageSubjectStatusOutcome,
} from "./stage-subject-status.js";

export type SessionEndStatus = "closed" | "cancelled" | "failed";

/** One thing the end tried to move, and what became of it. */
export interface SessionEndMove {
  entityId: string;
  /** The session's subject, or a target still open at the close. */
  as: "subject" | "target";
  outcome: StageSubjectStatusOutcome;
}

/** What the close's end moves did, as the close result reports it. */
export interface SessionEndMovesRecord {
  /** The terminal status the session ended in. */
  status: SessionEndStatus;
  /** The value `onEnd[status]` names. */
  value: string;
  moves: SessionEndMove[];
}

/**
 * Who moves the things at the end: the closer. An agent's close moves as the
 * agent; a person's (or a person's approval of an agent's proposed close) as
 * the person. An AUTOMATIC close (the system: a reaper, a run's end) moves as
 * an unattributed agent — governed and strict compare-and-set like any AI
 * write, never ungoverned server code: nobody chose this move at this moment.
 */
export function endMoveActor(input: {
  userId: string;
  agentUserId?: string | null;
  closerKind?: StatusMoveActor["kind"];
}): StatusMoveActor {
  if (input.agentUserId) {
    return {
      kind: "agent",
      userId: input.userId,
      agentUserId: input.agentUserId,
    };
  }
  if (input.closerKind === "system" || input.closerKind === "agent") {
    return { kind: "agent", userId: input.userId, agentUserId: null };
  }
  return { kind: "human", userId: input.userId };
}

/**
 * Apply `onEnd[status]` to the session's subject and its still-open targets.
 * `undefined` when the process says nothing for this end (no process, no
 * entry, or nothing to move). A process that names an end value but has no
 * status property to write it on (it names none and its subject kind declares
 * no lifecycle; `loadSessionProcess` resolves the declared one) reports each
 * thing `skipped: no_status_property`, never a silent nothing.
 */
export async function applySessionEndMoves(input: {
  session: {
    id: string;
    workspaceId: string | null;
    subjectEntityId: string | null;
  };
  process: SessionProcess | null;
  status: SessionEndStatus;
  /** Targets the close found still open (and stamped). */
  openTargets: readonly string[];
  actor: StatusMoveActor;
}): Promise<SessionEndMovesRecord | undefined> {
  const { session, process: proc, status } = input;
  const value = proc?.onEnd?.[status];
  if (!proc || !value) return undefined;
  const things: Array<{ entityId: string; as: SessionEndMove["as"] }> = [];
  if (session.subjectEntityId) {
    things.push({ entityId: session.subjectEntityId, as: "subject" });
  }
  for (const id of new Set(input.openTargets)) {
    if (id !== session.subjectEntityId)
      things.push({ entityId: id, as: "target" });
  }
  if (things.length === 0) return undefined;
  const statusProperty = proc.statusProperty;
  if (!statusProperty) {
    return {
      status,
      value,
      moves: things.map((thing) => ({
        ...thing,
        outcome: { status: "skipped", reason: "no_status_property" },
      })),
    };
  }

  const reason = `The session ended ${status}; its process moves what it worked on to "${value}".`;
  const moves: SessionEndMove[] = [];
  // One at a time: each is its own governed move with its own transition.
  for (const thing of things) {
    const outcome = await writeSubjectStatusValue({
      session,
      entityId: thing.entityId,
      process: {
        profileSlug: proc.profileSlug,
        statusProperty,
        humanOnlyStatuses: proc.humanOnlyStatuses,
      },
      value,
      reason,
      actor: input.actor,
      // The session's END is the guardrail: the move is governed like any
      // write of the closer, without the done/lost default floor (founder,
      // 2026-11-05, plan b38e5e64 §7.2) — and never takes a thing out of
      // done or lost (`already_settled`, the writer's own check).
      atSessionEnd: true,
    });
    moves.push({ ...thing, outcome });
  }
  return { status, value, moves };
}
