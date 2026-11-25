/**
 * Self-healing installations (founder, 2026-11-09: "make the system
 * selfhealing, when the pod have it installed, but not the computer"): the
 * pod's approved desired state and what is really on the computer converge by
 * themselves, under the EXISTING approval, with no person in the loop until
 * the pod gives up.
 *
 * The loop is the reconciler that already exists (`nextJobFor`, run by
 * `reconcileComputer` at every lease): this module is only its ladder, the
 * rule that says when a job that failed is tried again. Every job it allows
 * runs the manifest snapshot the person approved (`installations.manifest`,
 * leased as is), never a newer one.
 *
 *   - F = the consecutive FAILED lifecycle jobs at the head of the
 *     installation's history (install, update, verify, remove); any job that
 *     finished done resets it.
 *   - after F failures the next try waits {@link SELF_HEAL_BACKOFF_SECONDS}[F-1];
 *   - at {@link SELF_HEAL_MAX_FAILURES} it stops, and the finish that got
 *     there sends ONE card (`self-heal-notice.ts`);
 *   - a job a person STOPPED is their call: nothing runs by itself after it.
 *
 * A person's own ask (a repair or a verify, `requestInstallation`) is a hint
 * that bypasses the ladder, as before: that is how they try again after the
 * card.
 */

import { and, db, desc, eq, inArray } from "@synap/database";
import {
  hostJobs,
  type HostJobKind,
  type HostJobStatus,
} from "@synap/database/schema";

/** The jobs that move an installation's lifecycle (a provider op or a verb does not). */
export const LIFECYCLE_JOB_KINDS = [
  "install",
  "update",
  "verify",
  "remove",
] as const satisfies readonly HostJobKind[];

/** Wait this long after the 1st, 2nd, 3rd and 4th consecutive failure. */
export const SELF_HEAL_BACKOFF_SECONDS = [
  60,
  5 * 60,
  30 * 60,
  2 * 60 * 60,
] as const;

/** After this many consecutive failures the pod stops and asks the person. */
export const SELF_HEAL_MAX_FAILURES = SELF_HEAL_BACKOFF_SECONDS.length + 1;

/** One past job of an installation, as the ladder reads it (newest first). */
export interface InstallationJobHistoryEntry {
  kind: HostJobKind;
  status: HostJobStatus;
  queuedAt: Date;
  finishedAt: Date | null;
}

/** The consecutive failed lifecycle jobs at the head of `history` (newest first). */
export function consecutiveFailures(
  history: readonly InstallationJobHistoryEntry[]
): number {
  let n = 0;
  for (const job of history) {
    if (job.status !== "failed") break;
    n += 1;
  }
  return n;
}

export type SelfHealGate =
  | { open: true; failures: number }
  | {
      open: false;
      failures: number;
      why: "stopped_by_person" | "gave_up" | "backing_off";
      /** backing_off: when the next try may run. */
      retryAt?: Date;
    };

/**
 * May the reconciler queue a job by itself now? Pure. Open when nothing
 * failed; closed after a person stopped the last job, at the cap, and until
 * the back-off after the last failure has passed.
 */
export function selfHealGate(
  history: readonly InstallationJobHistoryEntry[],
  now: Date
): SelfHealGate {
  const head = history[0];
  if (head?.status === "stopped") {
    return { open: false, failures: 0, why: "stopped_by_person" };
  }
  const failures = consecutiveFailures(history);
  if (failures === 0) return { open: true, failures };
  if (failures >= SELF_HEAL_MAX_FAILURES) {
    return { open: false, failures, why: "gave_up" };
  }
  const since = head!.finishedAt ?? head!.queuedAt;
  const retryAt = new Date(
    since.getTime() + SELF_HEAL_BACKOFF_SECONDS[failures - 1]! * 1000
  );
  return retryAt.getTime() <= now.getTime()
    ? { open: true, failures }
    : { open: false, failures, why: "backing_off", retryAt };
}

/** How many past jobs the ladder reads: enough to see the cap. */
const HISTORY_DEPTH = SELF_HEAL_MAX_FAILURES + 1;

/** The installation's recent lifecycle jobs, newest first. */
export async function loadInstallationJobHistory(
  installationId: string
): Promise<InstallationJobHistoryEntry[]> {
  return db
    .select({
      kind: hostJobs.kind,
      status: hostJobs.status,
      queuedAt: hostJobs.queuedAt,
      finishedAt: hostJobs.finishedAt,
    })
    .from(hostJobs)
    .where(
      and(
        eq(hostJobs.installationId, installationId),
        inArray(hostJobs.kind, [...LIFECYCLE_JOB_KINDS])
      )
    )
    .orderBy(desc(hostJobs.queuedAt), desc(hostJobs.id))
    .limit(HISTORY_DEPTH);
}
