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
  return sessionCloser(input);
}
