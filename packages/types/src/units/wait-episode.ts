/**
 * WAIT EPISODES — one stretch of time a thing waited on one thing (status-first
 * PR-H, `status_wait_episode`, migration 0386). The status watcher opens one
 * when THE waiting-on collector first finds the wait and closes it on the first
 * tick that no longer finds it: the history behind "where the time went".
 *
 * One OPEN episode per (subject, facet, wait kind, ref): {@link waitEpisodeRefKey}
 * is the ref's identity in that key. A wait the pod cannot name (a source on a
 * session its holder may not read) has the empty key: one episode per kind.
 */
import type { HoldOn } from "../lifecycle/hold.js";
import type { TransitionSubjectType } from "../lifecycle/index.js";
import type { WaitingOnReason, WaitingOnRef } from "./goal.js";
import type { WaitKind } from "./wait-kind.js";

export interface WaitEpisode {
  id: string;
  subjectType: TransitionSubjectType;
  subjectId: string;
  /** The role's facet when the wait is on a role's lifecycle, else null. */
  facetId: string | null;
  waitKind: WaitKind;
  /** A hold's `on` when the wait is a pause, else null. */
  on: HoldOn | null;
  /** The coarse waiting-on reason; null for a wait that makes no mark (a park). */
  reason: WaitingOnReason | null;
  /** What is waited on, as the thing's holder reads it; null when unnamed. */
  ref: WaitingOnRef | null;
  /** ISO. The tick that first found the wait (no backfill: at most a tick late). */
  openedAt: string;
  /** ISO; null while the wait stands. */
  closedAt: string | null;
}

/** The ref's identity in an episode's key: its id, else its url, else its label. */
export function waitEpisodeRefKey(
  ref: Pick<WaitingOnRef, "id" | "url" | "label" | "kind"> | null | undefined
): string {
  if (!ref) return "";
  const id = ref.id?.trim() || ref.url?.trim() || ref.label?.trim() || "";
  return id ? `${ref.kind}:${id}` : "";
}
