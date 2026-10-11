/**
 * reviveStaleSession — a write attributed to a STALE session brings it back.
 *
 * `stale` is the reapers' word for "quiet past its window", never an end: the
 * focus-session reaper stamps it on an idle session, and the playbook-run
 * reaper stamps it on a run an EXTERNAL agent holds (and on that run's
 * session) instead of failing it (D6, 2026-10-11). An external agent works on
 * its own clock, so its next write is the proof it is back — and must not land
 * in a session that still reads abandoned, under a run that still reads dead.
 *
 * Called from the ONE door every governed write passes,
 * `checkPermissionOrPropose` (`utils/permission-check.ts`), for the session the
 * write is attributed to. Not called for a lifecycle CLOSE: closing a stale
 * session ends it, and `completeFocusSession` already finishes its stale run
 * (`stale` is a LIVE run status).
 *
 * Session → `active` (with `updatedAt` = now: this IS activity). Its stale
 * playbook run(s) → `running`, so the run feed, the needs-you lens and the
 * reaper's next sweep all read it as worked again. Both writes are conditional
 * on the stale status AND on the session being the writer's own (`userId` —
 * the human an agent acts for), so a session that is not stale, or a handle
 * that names someone else's session, costs one indexed no-op UPDATE.
 */
import {
  db,
  and,
  eq,
  drizzleSql,
  focusSessions,
  playbookRuns,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { isTerminalSessionStatus } from "./session-statuses.js";

const logger = createLogger({ module: "focus-sessions/revive-stale-session" });

/** The Postgres uuid shape — a malformed handle is never sent to the column. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session a gated write is ATTRIBUTED to, for revival — or undefined.
 *
 *  - the write's own session handle (`ctx.sessionId`, verified at the door), else
 *  - the session the write is ABOUT (`focus_session` subject, `data.id`):
 *    `synap_update_session` names its session as the subject, not as `ctx`.
 *
 * Undefined for a lifecycle close (`data.status` terminal): closing ends the
 * session, it is not the agent coming back.
 */
export function sessionToReviveForWrite(write: {
  sessionId?: string | null;
  subjectType: string;
  data?: Record<string, unknown>;
}): string | undefined {
  const aboutSession = write.subjectType.startsWith("focus_session");
  if (
    aboutSession &&
    isTerminalSessionStatus(
      typeof write.data?.status === "string" ? write.data.status : null
    )
  ) {
    return undefined;
  }
  const candidate =
    write.sessionId ??
    (aboutSession && typeof write.data?.id === "string"
      ? write.data.id
      : undefined);
  return candidate && UUID_RE.test(candidate) ? candidate : undefined;
}

/**
 * The governance door's hook: revive the session a NON-DENIED write is
 * attributed to. Never throws — a failed revive must not fail the write it
 * rides on; it is logged loudly instead (the session then reads stale until
 * the next write, which is the pre-revive behaviour, never a lost write).
 */
export async function reviveSessionForWrite(write: {
  userId: string;
  sessionId?: string | null;
  subjectType: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  const sessionId = sessionToReviveForWrite(write);
  if (!sessionId) return;
  try {
    const result = await reviveStaleSession(sessionId, write.userId);
    if (result.sessionRevived) {
      logger.info(
        { sessionId, runsRevived: result.runsRevived },
        "stale session revived by a write attributed to it"
      );
    }
  } catch (err) {
    logger.error(
      { err, sessionId },
      "stale-session revive failed — the write proceeds, the session stays stale"
    );
  }
}

export interface ReviveStaleSessionResult {
  /** The session was stale and is `active` again. */
  sessionRevived: boolean;
  /** Stale playbook runs on that session flipped back to `running`. */
  runsRevived: number;
}

export async function reviveStaleSession(
  sessionId: string,
  userId: string
): Promise<ReviveStaleSessionResult> {
  const revived = await db
    .update(focusSessions)
    .set({ status: "active", updatedAt: drizzleSql`now()` })
    .where(
      and(
        eq(focusSessions.id, sessionId),
        eq(focusSessions.userId, userId),
        eq(focusSessions.status, "stale")
      )
    )
    .returning({ id: focusSessions.id });
  if (revived.length === 0) return { sessionRevived: false, runsRevived: 0 };

  const runs = await db
    .update(playbookRuns)
    .set({ status: "running" })
    .where(
      and(
        eq(playbookRuns.sessionId, sessionId),
        eq(playbookRuns.status, "stale")
      )
    )
    .returning({ id: playbookRuns.id });
  return { sessionRevived: true, runsRevived: runs.length };
}
