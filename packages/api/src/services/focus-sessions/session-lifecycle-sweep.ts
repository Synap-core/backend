/**
 * THE SESSION LIFECYCLE SWEEP (plan d679e92c C6, founder 2026-10-31) — what
 * the hourly focus-session reaper does with work that is DONE, work that waits
 * on a merge, work nobody came back to, and runs whose own run has ended.
 *
 * Measured on the founder's pod (27–31 Oct): 101 of 430 work sessions went
 * stale instead of closing, 17 of them with every outcome met; 106 of 351 ended
 * work sessions still held an open outcome; 825 of 1,852 sessions were runs
 * (610 CRM automation firings) the work reaper staled like abandoned work.
 *
 * NOT A SECOND REAPER: it rides the existing reaper's tick through the
 * `registerSessionLifecycleSweeper` slot (`@synap/jobs`
 * `focus-session-reaper.ts`), because the rules it needs live here and jobs
 * cannot import this package — the session kind (`sessionKindWhere`), THE
 * "done" rule (`attachNextMove` → `deriveNextMove`, `ready_to_close`) and the
 * one close door (`completeFocusSession`). It writes through the same doors
 * as every other mover: `setSessionStatus` for the hold, `completeFocusSession`
 * for every close. No raw status write.
 *
 * The four moves, each its own batch, each failure its own:
 *  1. A WORK session whose declared outcomes are all met, whose required
 *     criteria pass and that owes nothing (`ready_to_close`) is CLOSED — after
 *     {@link MET_CLOSE_QUIET_HOURS} of quiet, so the agent that met the last
 *     outcome gets to close it itself, with its own summary.
 *  2. A WORK session whose only outstanding outcomes are open pull requests is
 *     HELD "waiting on merge" (paused, `until: pr:<repo>#<n>`) when it would
 *     otherwise go stale. The merge resumes it (`hold-resume.ts`), the merge
 *     sweep completes the outcome, and move 1 closes it. The reaper's stale
 *     sweep never stales such a session (`onlyOpenPullRequestsWhere`).
 *  3. An AGENT's WORK session stale for {@link LONG_STALE_DAYS} days, that owes
 *     the person nothing and that no person ever wrote on, is CANCELLED with a
 *     reason. `cancelled`, not `closed`: it did not deliver, and a session that
 *     waited on it must re-plan (a cancelled blocker holds, marked dropped).
 *  4. A RUN (automation run, playbook run, capture/import intake) is closed
 *     when its OWN run has ended: the automation run or every playbook run is
 *     terminal, or the intake is idle with nothing left to review (the receipt
 *     rule). The work reaper never stales a run (`runSessionWhere`, below).
 *
 * Nothing here closes a session that owes the person something: every
 * selection carries the owed / waiting-on-person predicate the needs-you tray
 * counts with.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  asc,
  eq,
  inArray,
  drizzleSql,
  focusSessions,
  owedSlotWhere,
  focusSessionWaitsOnPersonWhere,
  onlyOpenPullRequestsWhere,
  outstandingSlotExistsIn,
  personTouchedSubjectIds,
  setSessionStatus,
  RECEIPT_IDLE_WINDOW_HOURS,
} from "@synap/database";
import type { SQL } from "@synap/database";
import { parsePullRequestRef, type PullRequestRef } from "@synap-core/types";
import { holdDevMovesRef, type Hold } from "@synap-core/types/lifecycle";
import { workClockIn } from "@synap-core/types/work-clock";
import { isDeliverableOutstanding } from "@synap-core/types/units";
import type { ExpectedOutput } from "@synap/playbooks";
import { sessionKindWhere } from "./session-kind.js";
import { attachNextMove } from "./session-path-sections.js";
import { completeFocusSession } from "./complete-session.js";

const logger = createLogger({ module: "session-lifecycle-sweep" });

/** Quiet time before a met session is closed for its agent. */
export const MET_CLOSE_QUIET_HOURS = 1;
/** Days a stale, unowed, untouched agent session waits before it is cancelled. */
export const LONG_STALE_DAYS = 7;
/** The reaper's own idle clock — when a session would go stale. */
const STALE_HOURS = workClockIn("stale", "hours");
/** Most sessions each move handles per tick (each runs a full door). */
const BATCH = 200;

/** Statuses an open session stands in that these moves may end. */
const OPEN = ["active", "paused", "stale"] as const;

/**
 * SQL: a RUN session — the session kind's own predicate, NULL-safe. `NOT` of
 * a NULL is NULL, and a row with a NULL `origin` would vanish from every sweep
 * that negates it, so the reaper negates THIS (coalesced) form.
 */
export function runSessionWhere(): SQL {
  return drizzleSql`coalesce((${sessionKindWhere("run")}), false)` as SQL;
}

const quietFor = (hours: number) =>
  drizzleSql`${focusSessions.updatedAt} < now() - (${hours}::int * interval '1 hour')`;

const nothingOwed = () =>
  and(
    drizzleSql`NOT ${owedSlotWhere()}`,
    drizzleSql`NOT ${focusSessionWaitsOnPersonWhere()}`
  )!;

// ── 1. Met → closed ────────────────────────────────────────────────────────

/**
 * SQL prefilter for move 1: a work session that declared outcomes and has none
 * outstanding. The verdict is THE next-move rule's (`ready_to_close`), which
 * also checks the criteria, open sub-sessions, unread messages and pending
 * proposals; this only keeps the scan small.
 */
export function metWorkSessionWhere(): SQL {
  return and(
    sessionKindWhere("work"),
    inArray(focusSessions.status, [...OPEN]),
    quietFor(MET_CLOSE_QUIET_HOURS),
    drizzleSql`jsonb_typeof(${focusSessions.expectedOutputs}) = 'array' AND jsonb_array_length(${focusSessions.expectedOutputs}) > 0`,
    drizzleSql`NOT ${outstandingSlotExistsIn(focusSessions.expectedOutputs)}`,
    nothingOwed()
  ) as SQL;
}

export async function closeMetWorkSessions(): Promise<number> {
  const rows = await db
    .select()
    .from(focusSessions)
    .where(metWorkSessionWhere())
    // SESSION-KIND-LENS-EXEMPT: a reaper batch, never a page of session rows; the WHERE narrows to `work`.
    .orderBy(asc(focusSessions.updatedAt), asc(focusSessions.id))
    .limit(BATCH);
  let closed = 0;
  const byUser = new Map<string, typeof rows>();
  for (const r of rows) {
    byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
  }
  for (const [userId, own] of byUser) {
    const moved = await attachNextMove(own, {
      userId,
      logContext: { door: "session-lifecycle-sweep" },
    });
    for (const r of moved) {
      if (r.nextMove.kind !== "ready_to_close") continue;
      try {
        await completeFocusSession({
          sessionId: r.id,
          userId,
          terminalStatus: "closed",
          summary:
            "Closed automatically: every outcome it declared is met, and nothing is owed or waiting for review.",
          actor: { kind: "system", userId },
        });
        closed++;
      } catch (err) {
        logger.error(
          { err, sessionId: r.id },
          "met-session close failed — will retry next tick"
        );
      }
    }
  }
  return closed;
}

// ── 2. Only an open PR left → held "waiting on merge" ──────────────────────

/** SQL: an active work session about to go stale whose only open work is PRs. */
export function waitingOnMergeCandidateWhere(): SQL {
  return and(
    sessionKindWhere("work"),
    eq(focusSessions.status, "active"),
    quietFor(STALE_HOURS),
    onlyOpenPullRequestsWhere(),
    nothingOwed()
  ) as SQL;
}

/**
 * The first outstanding pull request a session's outcomes name, if any —
 * outstanding by THE deliverable rule (`isDeliverableOutstanding`), the rule
 * `onlyOpenPullRequestsWhere` mirrors in SQL.
 */
export function firstOpenPullRequest(
  expectedOutputs: unknown
): PullRequestRef | null {
  if (!Array.isArray(expectedOutputs)) return null;
  for (const slot of expectedOutputs as ExpectedOutput[]) {
    if (!slot || slot.kind !== "pull_request") continue;
    if (!isDeliverableOutstanding(slot)) continue;
    const url = (slot.ref as { url?: unknown } | undefined)?.url;
    if (typeof url !== "string") continue;
    const pr = parsePullRequestRef(url);
    if (pr) return pr;
  }
  return null;
}

/** The hold a session waiting on `pr` records: the merge resumes it. */
export function waitingOnMergeHold(pr: PullRequestRef): Hold {
  const ref = holdDevMovesRef({ kind: "pr", repo: pr.repo, number: pr.number });
  return {
    on: "external",
    ref,
    reason: `Waiting on merge: ${pr.repo}#${pr.number} is the only open outcome.`,
    until: { moves: ref },
  };
}

export async function holdSessionsWaitingOnMerge(): Promise<number> {
  const rows = await db
    .select({
      id: focusSessions.id,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(waitingOnMergeCandidateWhere())
    .orderBy(asc(focusSessions.updatedAt), asc(focusSessions.id))
    .limit(BATCH);
  let held = 0;
  for (const row of rows) {
    const pr = firstOpenPullRequest(row.expectedOutputs);
    if (!pr) continue;
    try {
      const hold = waitingOnMergeHold(pr);
      // The compare-and-set re-checks the rule under the row lock; the reaper
      // leaves `updatedAt` alone (it is the last-real-activity signal).
      const { rows: moved } = await setSessionStatus(db, {
        sessionId: row.id,
        where: waitingOnMergeCandidateWhere(),
        from: ["active"],
        to: "paused",
        actor: { kind: "system" },
        reason: hold.reason ?? null,
        hold,
      });
      if (moved.length > 0) held++;
    } catch (err) {
      logger.error(
        { err, sessionId: row.id },
        "waiting-on-merge hold failed — will retry next tick"
      );
    }
  }
  return held;
}

// ── 3. Stale for a week, unowed, untouched → cancelled ─────────────────────

export function longStaleWorkSessionWhere(): SQL {
  return and(
    sessionKindWhere("work"),
    eq(focusSessions.status, "stale"),
    eq(focusSessions.origin, "agent"),
    // `updatedAt` is the last real activity (the stale write leaves it): the
    // session went stale STALE_HOURS after it, and has been stale a week since.
    drizzleSql`${focusSessions.updatedAt} < now() - (${STALE_HOURS}::int * interval '1 hour') - (${LONG_STALE_DAYS}::int * interval '1 day')`,
    drizzleSql`NOT ${onlyOpenPullRequestsWhere()}`,
    nothingOwed()
  ) as SQL;
}

export async function cancelLongStaleWorkSessions(): Promise<number> {
  const rows = await db
    .select({ id: focusSessions.id, userId: focusSessions.userId })
    .from(focusSessions)
    .where(longStaleWorkSessionWhere())
    .orderBy(asc(focusSessions.updatedAt), asc(focusSessions.id))
    .limit(BATCH);
  if (rows.length === 0) return 0;
  // A session a person ever wrote on is theirs too: left as it is. A failed
  // read cancels nothing (it throws).
  const touched = await personTouchedSubjectIds(
    db,
    "focus_session",
    rows.map((r) => r.id)
  );
  const reason = `Stale for ${LONG_STALE_DAYS} days, with nothing owed to you and nothing you wrote on it.`;
  let cancelled = 0;
  for (const row of rows) {
    if (touched.has(row.id)) continue;
    try {
      await completeFocusSession({
        sessionId: row.id,
        userId: row.userId,
        terminalStatus: "cancelled",
        cancelReason: reason,
        summary: `Closed automatically: ${reason}`,
        actor: { kind: "system", userId: row.userId },
      });
      cancelled++;
    } catch (err) {
      logger.error(
        { err, sessionId: row.id },
        "long-stale cancel failed — will retry next tick"
      );
    }
  }
  return cancelled;
}

// ── 4. A run whose own run ended → closed ──────────────────────────────────

/** The automation run statuses after which nothing more runs. */
const AUTOMATION_RUN_ENDED = [
  "completed",
  "failed",
  "cancelled",
  "skipped",
  "blocked_by_policy",
] as const;
/** The playbook run statuses after which nothing more runs. */
const PLAYBOOK_RUN_ENDED = ["completed", "failed", "cancelled"] as const;

const sqlList = (values: readonly string[]) =>
  drizzleSql.raw(values.map((v) => `'${v}'`).join(", "));

/** SQL: a run session whose own run has ended (see the header, move 4). */
export function endedRunSessionWhere(): SQL {
  const automationEnded = drizzleSql`EXISTS (
    SELECT 1 FROM automation_runs ar
    WHERE ar.id::text = ${focusSessions.metadata} ->> 'automationRunId'
      AND ar.status IN (${sqlList(AUTOMATION_RUN_ENDED)})
  )`;
  const playbookEnded = drizzleSql`(EXISTS (
    SELECT 1 FROM playbook_runs pr WHERE pr.session_id = ${focusSessions.id}
  ) AND NOT EXISTS (
    SELECT 1 FROM playbook_runs pr
    WHERE pr.session_id = ${focusSessions.id}
      AND pr.status NOT IN (${sqlList(PLAYBOOK_RUN_ENDED)})
  ))`;
  // An intake has no run row: it is done like a receipt — idle, nothing
  // pending, no proposal filed lately.
  const intakeEnded = drizzleSql`(${focusSessions.metadata} ? 'intake'
    AND ${quietFor(RECEIPT_IDLE_WINDOW_HOURS)}
    AND NOT EXISTS (
      SELECT 1 FROM proposals p
      WHERE p.session_id = ${focusSessions.id}
        AND (p.status = 'pending' OR p.created_at > now() - (${RECEIPT_IDLE_WINDOW_HOURS}::int * interval '1 hour'))
    ))`;
  return and(
    runSessionWhere(),
    inArray(focusSessions.status, [...OPEN]),
    drizzleSql`(${automationEnded} OR ${playbookEnded} OR ${intakeEnded})`,
    nothingOwed()
  ) as SQL;
}

export async function closeEndedRunSessions(): Promise<number> {
  const rows = await db
    .select({ id: focusSessions.id, userId: focusSessions.userId })
    .from(focusSessions)
    .where(endedRunSessionWhere())
    .orderBy(asc(focusSessions.updatedAt), asc(focusSessions.id))
    .limit(BATCH);
  let closed = 0;
  for (const row of rows) {
    try {
      await completeFocusSession({
        sessionId: row.id,
        userId: row.userId,
        terminalStatus: "closed",
        summary: "Closed automatically: its run has ended.",
        actor: { kind: "system", userId: row.userId },
      });
      closed++;
    } catch (err) {
      logger.error(
        { err, sessionId: row.id },
        "ended-run close failed — will retry next tick"
      );
    }
  }
  return closed;
}

// ── The tick ───────────────────────────────────────────────────────────────

export interface SessionLifecycleSweepResult {
  metClosed: number;
  heldOnMerge: number;
  longStaleCancelled: number;
  runsClosed: number;
  failed: string[];
}

/** One tick: every move, each failure its own (logged, never stops the rest). */
export async function sweepSessionLifecycle(): Promise<SessionLifecycleSweepResult> {
  const result: SessionLifecycleSweepResult = {
    metClosed: 0,
    heldOnMerge: 0,
    longStaleCancelled: 0,
    runsClosed: 0,
    failed: [],
  };
  const step = async (
    name: string,
    run: () => Promise<number>,
    set: (n: number) => void
  ) => {
    try {
      set(await run());
    } catch (err) {
      result.failed.push(name);
      logger.error({ err, step: name }, "session lifecycle step failed");
    }
  };
  await step("runs", closeEndedRunSessions, (n) => (result.runsClosed = n));
  await step("met", closeMetWorkSessions, (n) => (result.metClosed = n));
  await step(
    "merge-hold",
    holdSessionsWaitingOnMerge,
    (n) => (result.heldOnMerge = n)
  );
  await step(
    "long-stale",
    cancelLongStaleWorkSessions,
    (n) => (result.longStaleCancelled = n)
  );
  return result;
}
