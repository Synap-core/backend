/**
 * "I lost my passkey": what the ONE recovery door shows (the recovery
 * ladder, founder, 6 Nov 2026; `CONSOLE_PAGES.presenceRecovery`), derived in
 * one place from `presence.recovery.status` (pure, so each state is tested).
 *
 *  - no request (or one cancelled): ask for a reset; a cancelled one says
 *    when, so a person who did not ask knows someone did and it was stopped;
 *  - waiting: when it can be finished, and Cancel (any signed-in device of
 *    theirs can cancel it until then);
 *  - ready: Finish, which clears every proof factor (needs a fresh sign-in
 *    at the pod);
 *  - done: add a first factor again (a passkey; then a second way in).
 *
 * A failed read is its own state with Try again, never "no request"; a
 * signed-out reader is sent to sign in, never shown a calm empty page.
 */
import type { PresenceRecoveryStatus } from "@synap-core/types/presence";

export interface PresenceRecoveryRead {
  status: PresenceRecoveryStatus;
  maturesAt: string | Date;
  cancelledAt: string | Date | null;
  completedAt: string | Date | null;
}

export type PresenceRecoveryView =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "failed"; detail: string | null }
  | { kind: "none"; cancelledAt: string | null }
  | { kind: "waiting"; maturesAt: string }
  | { kind: "ready" }
  | { kind: "done"; completedAt: string };

const iso = (d: string | Date): string =>
  typeof d === "string" ? d : d.toISOString();

export function presenceRecoveryView(
  read: {
    isLoading: boolean;
    error?: { message?: string; data?: { code?: string } | null } | null;
    data?: PresenceRecoveryRead | null;
  },
  now: number = Date.now()
): PresenceRecoveryView {
  if (read.error) {
    if (read.error.data?.code === "UNAUTHORIZED") return { kind: "signedOut" };
    return { kind: "failed", detail: read.error.message?.trim() || null };
  }
  if (read.isLoading || read.data === undefined) return { kind: "loading" };
  const r = read.data;
  if (!r) return { kind: "none", cancelledAt: null };
  if (r.status === "cancelled") {
    return {
      kind: "none",
      cancelledAt: r.cancelledAt ? iso(r.cancelledAt) : null,
    };
  }
  if (r.status === "completed") {
    return { kind: "done", completedAt: iso(r.completedAt ?? r.maturesAt) };
  }
  const maturesAt = iso(r.maturesAt);
  return Date.parse(maturesAt) <= now
    ? { kind: "ready" }
    : { kind: "waiting", maturesAt };
}

/** The pod refused Finish for a stale sign-in: the way on is to sign in again. */
export function needsFreshSignIn(err: unknown): boolean {
  const data = (err as { data?: { reasonCode?: unknown } | null } | null)?.data;
  return data?.reasonCode === "STEP_UP_REQUIRED";
}
