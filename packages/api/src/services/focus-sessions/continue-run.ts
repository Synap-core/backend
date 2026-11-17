/**
 * CONTINUE AT <STAGE> — the person's door for a run that ended or stopped
 * before its last declared stage (plan 7d71ddcc W4, founder decision D4: the
 * run says "Stopped at Script", and whether it goes on is the person's).
 *
 * WHAT IT DOES. The SAME session resumes at the stage it stands on
 * (`focus_sessions.current_stage`, where the run stopped), with a NEW run
 * turn: a new `playbook_runs` row on the session, dispatched through the one
 * run dispatch (`dispatchRunOnSession`, shared with a run that starts at once
 * and a held run the person accepts). The stage runner enters the stage again
 * (`enterStage`, a new attempt in the stage ledger). The stopped run keeps its
 * verdict: a finished run's status is never overwritten (plan §4.3), and this
 * door writes no run status itself (the run status writers are `setRunStatus`'s,
 * lane A); the new row is born `running` and its result is recorded by the one
 * result write (`recordExecutorResult`).
 *
 * AN ENDED SESSION IS REOPENED FOR IT. A run that stopped with stages left
 * usually closed its session (`closed` by the sweep, `failed` by the turn end
 * with no person in the loop). A closed run stays closed for every other move
 * (`closedRunRefusal`, decision 3da00cda); this door is its second exception,
 * beside the person's reopen of a cancelled run (`reopen-session.ts`), and it
 * is as narrow: a PERSON, a run with stages left, nothing live on it. The
 * session moves back to `active` through the one status write
 * (`setSessionStatus`, compare-and-set from the status read), which owes the
 * transition with the person as its actor. A `cancelled` session is not
 * continued here: the person stopped it, and their undo is the reopen door
 * (the next move says so, `stopped_early` excludes a cancel).
 *
 * WHY NOT A NEW SESSION. The CS "Continue" started a new run of the recipe:
 * the room, the outputs and the stage ledger stayed behind on the old session
 * and the new run started again at the first stage. Resuming the same session
 * keeps all three, and the stage it resumes at is the one it stopped on.
 *
 * ONE LIVE RUN PER OBJECT (0427). When another run of the same playbook is
 * live on the same object for this person, nothing is written and the answer
 * names it (`findLiveRunOfSubject`); a race the read misses is refused by the
 * index on the status write, answered the same way.
 *
 * NOT RESTORED, said to the person: the owed slots the close retired stay
 * retired (the new turn asks again what it still needs), and the room
 * questions the close answered stay answered.
 */
import {
  and,
  db,
  desc,
  drizzleSql,
  eq,
  focusSessions,
  LifecycleConflictError,
  playbookRuns,
  setSessionStatus,
  uniqueViolationConstraint,
  users,
  workUnitActorOf,
  isLiveRunStatus,
  type FocusSession,
} from "@synap/database";
import { ONE_LIVE_RUN_INDEX } from "@synap/database/schema";
import type { PlaybookRun } from "@synap/database/schema";
import {
  isTerminalSessionStatus,
  type SessionStatus,
} from "@synap-core/types/focus-sessions";
import { createLogger } from "@synap-core/core";
import {
  stagesLeft,
  stagesLeftWords,
  stoppedWhere,
  type StagesLeft,
} from "../runs/stages-left.js";

const logger = createLogger({ module: "continue-run" });

/** The run statuses a run ENDED in (not live, not a draft, not cancelled). */
const ENDED_RUN_STATUSES = ["completed", "failed"] as const;

/** What the Continue predicate reads, from the session and its newest run. */
export interface ContinueFacts {
  status: string;
  playbookId: string | null;
  stages: unknown;
  currentStage: string | null;
  /** The newest run's status; `null` = the session has no run. */
  runStatus: string | null;
}

/**
 * Where the run STOPPED: it follows a playbook, has declared stages left, and
 * it ended before the last one — its newest run ended (`completed` or
 * `failed`), or its session ended (`closed`, `failed`). A cancel is the
 * person's stop, never "stopped early". PURE. `null` = it did not stop early.
 */
export function stoppedEarly(f: ContinueFacts): StagesLeft | null {
  if (!f.playbookId) return null;
  if (f.status === "cancelled" || f.runStatus === "cancelled") return null;
  const left = stagesLeft(f.stages, f.currentStage);
  if (!left) return null;
  const runEnded = (ENDED_RUN_STATUSES as readonly string[]).includes(
    f.runStatus ?? ""
  );
  return runEnded || isTerminalSessionStatus(f.status) ? left : null;
}

/**
 * THE Continue predicate, read by `statusOf` (`include: ["work"]` →
 * `continue`) and by the door, so the button and the door cannot disagree:
 * it stopped early ({@link stoppedEarly}) and nothing is live on it (no live
 * run, no run still `proposed`). PURE.
 */
export function continueAt(f: ContinueFacts): StagesLeft | null {
  const left = stoppedEarly(f);
  if (!left) return null;
  if (isLiveRunStatus(f.runStatus) || f.runStatus === "proposed") return null;
  return left;
}

/** "Continue at Script", or "Continue before Brief". */
export function continueLabel(left: StagesLeft): string {
  return `Continue ${stoppedWhere(left)}`;
}

/** The room line: who continued it, and from where. */
export function continuedLine(input: {
  personName: string | null;
  left: StagesLeft;
  reopenedFrom: string | null;
}): string {
  const who = input.personName?.trim() || "The person";
  const reopened = input.reopenedFrom
    ? ` The session was ${input.reopenedFrom} and is open again.`
    : "";
  return (
    `${who} continued this run ${stoppedWhere(input.left)}, with ${stagesLeftWords(input.left)}: ` +
    `${input.left.left.map((s) => s.name).join(", ")}.${reopened} ` +
    "Pick up from where it stopped; do not start over. Finish the current stage, " +
    "then move the run to its next stage (update_run), until its last stage is done."
  );
}

export type ContinueRunResult =
  | {
      ok: true;
      sessionId: string;
      /** The new run's id. */
      runId: string;
      /** Its status after dispatch (`running`, or `failed` when it could not start). */
      runStatus: string;
      at: { key: string; name: string } | null;
      /** The session was ended and is open again (its status before). */
      reopenedFrom: string | null;
      warnings: string[];
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "person_only"
        | "nothing_to_continue"
        | "already_running"
        | "conflict";
      message: string;
      liveSessionId?: string;
    };

/** The newest run of a session, or null. */
async function newestRun(sessionId: string): Promise<PlaybookRun | null> {
  const [run] = await db
    .select()
    .from(playbookRuns)
    .where(eq(playbookRuns.sessionId, sessionId))
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  return (run as PlaybookRun | undefined) ?? null;
}

/**
 * Continue a stopped run at its stage. The caller is the person who owns the
 * session (owner-floored on `userId`); an agent key is refused by name: the
 * stop is in the person's Needs you, and going on is theirs to decide.
 */
export async function continueStoppedRun(params: {
  sessionId: string;
  userId: string;
  agentUserId?: string | null;
}): Promise<ContinueRunResult> {
  const { sessionId, userId } = params;
  if (params.agentUserId) {
    return {
      ok: false,
      reason: "person_only",
      message:
        "Only a person continues a run that stopped before its last stage: it waits in their Needs you. Tell them it can go on.",
    };
  }
  const [row] = await db
    .select()
    .from(focusSessions)
    .where(
      and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
    )
    .limit(1);
  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      message: `Focus session ${sessionId} not found`,
    };
  }
  const session = row as FocusSession;
  const run = await newestRun(sessionId);
  const left = continueAt({
    status: session.status,
    playbookId: session.playbookId ?? null,
    stages: session.stages,
    currentStage: session.currentStage ?? null,
    runStatus: run?.status ?? null,
  });
  if (!left || !run || !session.playbookId || !session.channelId) {
    return {
      ok: false,
      reason: "nothing_to_continue",
      message:
        run && isLiveRunStatus(run.status)
          ? "This run is still going: nothing to continue."
          : "This session has no run that stopped before its last stage, so there is nothing to continue.",
    };
  }

  // ONE LIVE RUN PER OBJECT: another live run of this playbook on the object.
  if (session.subjectEntityId) {
    const { findLiveRunOfSubject } =
      await import("../playbooks/live-run-of-subject.js");
    const live = await findLiveRunOfSubject({
      playbookId: session.playbookId,
      subjectId: session.subjectEntityId,
      userId,
    });
    if (live && live.session.id !== sessionId) {
      return alreadyRunning(live.session.id);
    }
  }

  // Resolved BEFORE anything is written: a playbook that can no longer run
  // (retired, gone) throws here and the session stays as it was.
  const plan = await planContinuation(session, run);

  // An ended session opens again, compare-and-set from the status read.
  let reopenedFrom: string | null = null;
  if (isTerminalSessionStatus(session.status)) {
    const now = new Date();
    const continued = {
      at: now.toISOString(),
      by: userId,
      stage: left.at?.key ?? null,
      fromRunId: run.id,
    };
    try {
      const { rows } = await setSessionStatus(db, {
        sessionId,
        from: session.status as SessionStatus,
        to: "active",
        actor: workUnitActorOf(userId, null),
        reason: `continued ${stoppedWhere(left)} by the person`,
        set: {
          closedAt: null,
          updatedAt: now,
          metadata: drizzleSql`jsonb_set(
            coalesce(${focusSessions.metadata}, '{}'::jsonb),
            '{run}',
            coalesce(${focusSessions.metadata}->'run', '{}'::jsonb)
              || jsonb_build_object('continued', ${JSON.stringify(continued)}::jsonb),
            true
          )`,
        },
      });
      if (rows.length === 0) {
        return {
          ok: false,
          reason: "conflict",
          message:
            "This session moved while you continued it. Look at where it stands now, then try again.",
        };
      }
    } catch (err) {
      if (uniqueViolationConstraint(err) === ONE_LIVE_RUN_INDEX) {
        return alreadyRunning(null);
      }
      if (err instanceof LifecycleConflictError) {
        return {
          ok: false,
          reason: "conflict",
          message:
            "This session moved while you continued it. Look at where it stands now, then try again.",
        };
      }
      throw err;
    }
    reopenedFrom = session.status;
  }

  const warnings: string[] = [];
  // The room line FIRST: the new turn reads it (where to pick up), as the
  // automatic continuation's notice does. A failed post is said, never fatal.
  if (session.channelId) {
    try {
      const [person] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const { postChannelMessage } =
        await import("../messaging/post-message.js");
      await postChannelMessage({
        channelId: session.channelId,
        content: continuedLine({
          personName: person?.name ?? null,
          left,
          reopenedFrom,
        }),
        role: "system",
        triggerAI: false,
        userId,
        idempotencyKey: `run-continued:${run.id}`,
      });
    } catch (err) {
      logger.warn(
        { err, sessionId },
        "continue: the room line could not be posted"
      );
      warnings.push(
        "The run continues, but the line saying so could not be posted in its room."
      );
    }
  }

  const next = await plan.dispatch();
  return {
    ok: true,
    sessionId,
    runId: next.id,
    runStatus: next.status,
    at: left.at,
    reopenedFrom,
    warnings,
  };
}

function alreadyRunning(liveSessionId: string | null): ContinueRunResult {
  return {
    ok: false,
    reason: "already_running",
    message:
      "Another run of this playbook is live on this record" +
      (liveSessionId ? ` (session ${liveSessionId})` : "") +
      ". Keep working in that run, or end it first, then continue this one.",
    ...(liveSessionId ? { liveSessionId } : {}),
  };
}

/** The input the stopped run carried, without what the dispatch stamps itself. */
function carriedParams(input: unknown): {
  params: Record<string, unknown>;
  stageRunners?: Record<string, unknown>;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { params: {} };
  }
  const {
    runId: _runId,
    agentUserId: _agent,
    stageRunners,
    ...params
  } = input as Record<string, unknown>;
  return {
    params,
    ...(stageRunners &&
    typeof stageRunners === "object" &&
    !Array.isArray(stageRunners)
      ? { stageRunners: stageRunners as Record<string, unknown> }
      : {}),
  };
}

/**
 * The new run turn, through THE dispatch: the playbook as it is now, the
 * person's run choice (as an accepted draft resolves it), the stopped run's
 * params and step runners. Resolved first; dispatched once the session is
 * open again.
 */
async function planContinuation(
  session: FocusSession,
  stopped: PlaybookRun
): Promise<{ dispatch: () => Promise<PlaybookRun> }> {
  const [
    { resolveRunnablePlaybook },
    { resolveRunChoice, dispatchRunOnSession },
  ] = await Promise.all([
    import("../playbooks/playbook-lifecycle.js"),
    import("../playbooks/run-playbook.js"),
  ]);
  const playbook = await resolveRunnablePlaybook({
    playbookId: session.playbookId!,
    workspaceId: session.workspaceId ?? "",
  });
  const { handOff, runOn, persona } = await resolveRunChoice({
    userId: session.userId,
    handToAgentId: null,
    playbook,
  });
  const carried = carriedParams(stopped.input);
  type StageRunners = Parameters<
    typeof dispatchRunOnSession
  >[0]["stageRunners"];
  return {
    dispatch: () =>
      dispatchRunOnSession({
        playbook,
        sessionId: session.id,
        channelId: session.channelId!,
        actorId: session.userId,
        workspaceId: session.workspaceId ?? null,
        params: carried.params,
        subjectId: session.subjectEntityId ?? null,
        agentType: persona ?? null,
        handOff,
        runOn,
        ...(carried.stageRunners
          ? { stageRunners: carried.stageRunners as StageRunners }
          : {}),
      }),
  };
}
