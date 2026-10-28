/**
 * The IoC slot that reaches the ONE session-close door (`completeFocusSession`,
 * @synap/api) from @synap/jobs.
 *
 * ── WHY A SLOT AND NOT AN IMPORT ────────────────────────────────────────────
 * `@synap/api` depends on `@synap/jobs` (api/package.json), so jobs can never
 * statically import api — the same circular dep documented on
 * `registerCapabilityExecutor` / `registerPlaybookRunner`
 * (workers/capability-dispatch.ts). apps/api is the one place that may import
 * both and fills this slot at boot. No HTTP, no shared secret.
 *
 * ── WHY IT EXISTS AT ALL ────────────────────────────────────────────────────
 * `@synap-core/types/focus-sessions` states the invariant: every terminal
 * status MUST go through `completeFocusSession` (review pack + running-run
 * close + session-bound ephemeral expiry + BOTH halves of the close event).
 * Three workers here stamped `status:'closed'` with a raw UPDATE and skipped
 * all four — the dual-path defect, with live proof (session `1ee3e34c` closed
 * while still owning four pending proposals).
 *
 * Copying the door's logic into jobs would BE that defect a fourth time, so
 * this is the inversion instead.
 */

import { db, and, eq, focusSessions, owedSlotWhere } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "session-close" });

/** Structural mirror of api's `CompleteFocusSessionResult` (no import — cycle). */
export interface SessionCloseResult {
  session: { id: string; status: string };
  counts: {
    pending: number;
    unfinishedOutputs: number;
    expiredEphemerals: number;
  };
  warnings: string[];
}

export interface SessionCloseInput {
  sessionId: string;
  /** The session OWNER's user id — the door scopes its read on it. */
  userId: string;
  summary?: string;
  terminalStatus?: "closed" | "cancelled" | "failed";
}

/** `null` ⇒ no session matched `{ sessionId, userId }`. */
export type SessionCloser = (
  input: SessionCloseInput
) => Promise<SessionCloseResult | null>;

let sessionCloser: SessionCloser | null = null;

export function registerSessionCloser(fn: SessionCloser): void {
  sessionCloser = fn;
}

/**
 * Close a focus session through the ONE door.
 *
 * Intentionally THROWS if the slot is unregistered — the same choice
 * `dispatchViaCapabilityRouter` makes, and for a stronger reason here: a close
 * that silently vanishes is precisely the defect this module exists to end. A
 * throw surfaces as a reaper failure (pg-boss retries) rather than a no-op that
 * leaves the session both un-closed and un-reported.
 */
export async function closeSessionViaDoor(
  input: SessionCloseInput
): Promise<SessionCloseResult | null> {
  if (!sessionCloser) {
    throw new Error(
      "Session closer not registered — apps/api must call registerSessionCloser() at boot"
    );
  }
  // W2 calm: every caller of this door is an AUTOMATIC close (the three
  // reapers and the executor's end-of-run close). None may close a session
  // that still owes the person something — the session stays open (status
  // unchanged) so the ask stays live where the person will answer it. A
  // person's own close goes through the api door directly, never through here.
  if (await sessionOwesHuman(input.sessionId)) {
    logger.info(
      { sessionId: input.sessionId },
      "Automatic close skipped — the session still owes the person an open slot"
    );
    return null;
  }
  return sessionCloser(input);
}

/**
 * Does this session still owe the person an open slot? THE owed predicate
 * (`owedSlotWhere`, @synap/database) — the same one the needs-you tray
 * counts with, so a session is never closed while the tray still shows it.
 */
export async function sessionOwesHuman(sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(and(eq(focusSessions.id, sessionId), owedSlotWhere()))
    .limit(1);
  return !!row;
}

// ─── A session that stopped on its own asks (decision E1) ───────────────────

/** Structural mirror of api's `StaleStoppedSessionResult` (no import — cycle). */
export interface StoppedSessionStaleResult {
  sessionId: string;
  retiredSlots: number;
  closedQuestions: number;
}

/**
 * The door that stales a session no agent moved for 7 days whose only owed
 * items are its agent's confirm / choose asks, retiring them `session_ended`
 * (api `staleStoppedSession`). `null` ⇒ the session no longer matches.
 */
export type StoppedSessionStaler = (input: {
  sessionId: string;
}) => Promise<StoppedSessionStaleResult | null>;

let stoppedSessionStaler: StoppedSessionStaler | null = null;

export function registerStoppedSessionStaler(fn: StoppedSessionStaler): void {
  stoppedSessionStaler = fn;
}

/**
 * Stale a session that STOPPED ON ITS ASKS through the ONE door. This is the
 * one exception to "never reap a session that owes the person" above, and it
 * is narrow by construction: only asks the agent posed to go on end with it —
 * an act, a form, a provide or plain work keeps the session as it is
 * (`sessionStoppedOnItsAsksWhere`, @synap/database). THROWS when the slot is
 * unregistered, like `closeSessionViaDoor`: a stale that silently vanishes
 * would leave the asks in needs-you forever, the defect this exists to end.
 */
export async function staleStoppedSessionViaDoor(input: {
  sessionId: string;
}): Promise<StoppedSessionStaleResult | null> {
  if (!stoppedSessionStaler) {
    throw new Error(
      "Stopped-session staler not registered — apps/api must call registerStoppedSessionStaler() at boot"
    );
  }
  return stoppedSessionStaler(input);
}
