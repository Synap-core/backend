/**
 * REOPEN A CANCELLED SESSION — the person's undo of a cancel made by mistake
 * (founder, 2026-11-04, decision 3da00cda, finding 8748feab).
 *
 * A closed run stays closed (work model R8, `closedRunRefusal`), with ONE
 * exception: a PERSON may move a session that ended `cancelled` back to
 * `active`. An agent never may (refused with the reason, never proposed), and a
 * `closed` or `failed` session keeps its history for everyone. The doors decide
 * WHO (`closedRunRefusal(from, to, actor)`); this is the one place that decides
 * WHAT a reopen does, so no door writes the status itself (the mirror of the
 * close door, `completeFocusSession`, for terminal statuses).
 *
 * What the cancel did, and what the reopen does about it:
 *   - status `cancelled` → `active`, through the one status write
 *     (`setSessionStatus`, compare-and-set from `cancelled`), which owes the
 *     `cancelled → active` transition with the person as its actor;
 *   - `closedAt` → NULL: the session is open again;
 *   - the owed slots the cancel retired (`retiredReason: session_cancelled`)
 *     are owed again: the two stamps are cleared, as `ExpectedOutput.retiredAt`
 *     documents ("clearing these two fields puts the slot back on the board").
 *     A slot retired for any other reason stays retired;
 *   - the playbook run the cancel ended (`cancelled`) runs again (`running`,
 *     `completedAt` and `error` cleared), so its frozen definition governs the
 *     stages again and the next close closes it. Only when the session has no
 *     live run already. A cancelled child never settled its parent automation
 *     run (only a `failed` child does), so there is nothing to unsettle;
 *   - `metadata.run.reopened` records who reopened it and when, beside the
 *     cancel record, which stays as history;
 *   - one system line in the session's room names who reopened it.
 * What it does NOT undo, said in `notRestored`: the room questions the cancel
 * closed stay closed, the queued jobs it stopped stay stopped, the expired
 * capability runs stay expired, and the secret reads it revoked stay revoked.
 * The work goes on in the room; anything still needed is asked again.
 */
import {
  db,
  focusSessions,
  playbookRuns,
  users,
  eq,
  and,
  desc,
  drizzleSql,
  liveRunStatusWhere,
  setSessionStatus,
  workUnitActorOf,
  LifecycleConflictError,
  type FocusSession,
} from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "reopen-focus-session" });

/** What a reopen leaves as the cancel left it — said to the person. */
export const REOPEN_NOT_RESTORED = [
  "questions the cancel closed stay closed",
  "jobs it stopped stay stopped",
  "capability runs that expired stay expired",
] as const;

/**
 * The owed slots the CANCEL retired, owed again. Pure. A slot retired for
 * another reason (a person or agent withdrew it, `session_ended`, …) is left
 * as it is.
 */
export function unretireCancelledSlots(outputs: ExpectedOutput[]): {
  outputs: ExpectedOutput[];
  restored: number;
} {
  let restored = 0;
  const next = outputs.map((o) => {
    if (!o || typeof o !== "object") return o;
    if (o.retiredReason !== "session_cancelled") return o;
    restored++;
    const { retiredAt: _at, retiredReason: _reason, ...rest } = o;
    return rest as ExpectedOutput;
  });
  return { outputs: next, restored };
}

/** The room line: who reopened it, and what it does not bring back. */
export function sessionReopenedLine(input: {
  personName: string | null;
  restoredSlots: number;
  reopenedRun: boolean;
}): string {
  const who = input.personName?.trim() || "The person";
  const back: string[] = [];
  if (input.restoredSlots > 0) {
    back.push(`owed again: ${input.restoredSlots}`);
  }
  if (input.reopenedRun) back.push("its playbook run is running again");
  const restored = back.length > 0 ? ` ${back.join("; ")}.` : "";
  return `${who} reopened this session: the cancel is undone and the work goes on here.${restored} Not brought back: ${REOPEN_NOT_RESTORED.join(", ")}.`;
}

export interface ReopenCancelledSessionResult {
  session: FocusSession;
  restoredSlots: number;
  reopenedRunId: string | null;
  notRestored: readonly string[];
  warnings: string[];
}

/**
 * Reopen a session that ended `cancelled`. The caller is the PERSON (the door
 * checked it with `closedRunRefusal`). Owner-floored on `userId`. Returns
 * `null` when the session is not the person's; throws
 * `LifecycleConflictError` when it is no longer `cancelled`.
 */
export async function reopenCancelledSession(params: {
  sessionId: string;
  userId: string;
}): Promise<ReopenCancelledSessionResult | null> {
  const { sessionId, userId } = params;
  const now = new Date();

  const done = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        status: focusSessions.status,
        expectedOutputs: focusSessions.expectedOutputs,
      })
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
      )
      .for("update");
    if (!locked) return null;
    if (locked.status !== "cancelled") {
      throw new LifecycleConflictError("cancelled", locked.status);
    }

    const unretired = unretireCancelledSlots(
      Array.isArray(locked.expectedOutputs)
        ? (locked.expectedOutputs as ExpectedOutput[])
        : []
    );

    const reopened = { at: now.toISOString(), by: userId };
    const { rows } = await setSessionStatus(tx, {
      sessionId,
      from: "cancelled",
      to: "active",
      actor: workUnitActorOf(userId, null),
      reason: "reopened by the person",
      set: {
        closedAt: null,
        updatedAt: now,
        ...(unretired.restored > 0
          ? { expectedOutputs: unretired.outputs }
          : {}),
        metadata: drizzleSql`jsonb_set(
          coalesce(${focusSessions.metadata}, '{}'::jsonb),
          '{run}',
          coalesce(${focusSessions.metadata}->'run', '{}'::jsonb)
            || jsonb_build_object('reopened', ${JSON.stringify(reopened)}::jsonb),
          true
        )`,
      },
    });
    const [session] = rows;
    if (!session) {
      throw new LifecycleConflictError("cancelled", locked.status);
    }

    // The run the cancel ended runs again — unless one is already live.
    let reopenedRunId: string | null = null;
    const [live] = await tx
      .select({ id: playbookRuns.id })
      .from(playbookRuns)
      .where(
        and(
          eq(playbookRuns.sessionId, sessionId),
          liveRunStatusWhere(playbookRuns.status)
        )
      )
      .limit(1);
    if (!live) {
      const [cancelledRun] = await tx
        .select({ id: playbookRuns.id, status: playbookRuns.status })
        .from(playbookRuns)
        .where(eq(playbookRuns.sessionId, sessionId))
        .orderBy(desc(playbookRuns.startedAt))
        .limit(1);
      if (cancelledRun?.status === "cancelled") {
        await tx
          .update(playbookRuns)
          .set({ status: "running", completedAt: null, error: null })
          .where(eq(playbookRuns.id, cancelledRun.id));
        reopenedRunId = cancelledRun.id;
      }
    }

    return { session, restoredSlots: unretired.restored, reopenedRunId };
  });
  if (!done) return null;

  // The room line, after the commit: a failed post never undoes the reopen,
  // and is said in the warnings.
  const warnings: string[] = [];
  if (done.session.channelId) {
    try {
      const [person] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const { postChannelMessage } =
        await import("../messaging/post-message.js");
      await postChannelMessage({
        channelId: done.session.channelId,
        content: sessionReopenedLine({
          personName: person?.name ?? null,
          restoredSlots: done.restoredSlots,
          reopenedRun: done.reopenedRunId !== null,
        }),
        role: "system",
        triggerAI: false,
        userId,
      });
    } catch (err) {
      logger.warn(
        { err, sessionId },
        "the reopen line could not be posted in the room"
      );
      warnings.push(
        "The session is reopened, but the line saying so could not be posted in its room."
      );
    }
  }

  return { ...done, notRestored: REOPEN_NOT_RESTORED, warnings };
}
