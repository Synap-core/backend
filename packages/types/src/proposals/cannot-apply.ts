/**
 * CANNOT APPLY YET — a request still to decide that cannot apply until the
 * PERSON (or the day) does something (plan 8032a127 D1 and D6). One predicate,
 * {@link cannotApplyYet}, and one sentence per reason,
 * {@link cannotApplyYetLine}, read by every surface so none keeps its own list.
 *
 * Two sources, both READ here, never written:
 *   - `data.held`, stored by the pod on a message it filed instead of sending
 *     (`services/channels/held-sends.ts`): not a LinkedIn connection yet
 *     (`not_connected`), no LinkedIn profile on file (`missing_field`), or the
 *     LinkedIn account's day is used up (`linkedin_limit`, until `until`). The
 *     pod re-reads the reach at every approval and releases a hold when they
 *     connect.
 *   - `setup`, derived by the pod on every read of an install request
 *     (`services/proposals/proposal-setup.ts`): `blocking` while a required
 *     key or connection is missing. Its form is the setup's own; this only
 *     says that it cannot apply yet.
 *
 * Where it shows (D6): Relay Home draws no card for a HELD request (the
 * person cannot act there); the browser's review shows the line, which names
 * the next step.
 *
 * Pure. Imports only this folder's words.
 */

import type { Locale } from "../i18n/index.js";
import { proposalsT } from "./copy.js";

export const CANNOT_APPLY_YET_REASONS = [
  "not_connected",
  "no_profile",
  "daily_limit",
  "needs_setup",
] as const;
export type CannotApplyYetReason = (typeof CANNOT_APPLY_YET_REASONS)[number];

/** The row fields the read uses; every one is on a display row. */
export interface CannotApplyYetRow {
  status?: string | null;
  data?: unknown;
  /** The pod's derived install setup (`capability.install` rows). */
  setup?: { blocking?: boolean | null } | null;
}

export interface CannotApplyYet {
  reason: CannotApplyYetReason;
  /**
   * A message the pod HOLDS (`data.held`): nobody can approve it into
   * sending now. False for an install's setup, which the person fills in on
   * the request itself.
   */
  held: boolean;
  /** `daily_limit`: when it can go (ISO). Null otherwise. */
  until: string | null;
}

const HELD_REASON: Readonly<Record<string, CannotApplyYetReason>> = {
  not_connected: "not_connected",
  missing_field: "no_profile",
  linkedin_limit: "daily_limit",
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Why this request cannot apply yet, or null when it can be decided now (or
 * is already decided). A held message is read only while pending, as the pod
 * reads it (`readHeld`): an unknown class reads as `not_connected`, a daily
 * limit past its `until` no longer holds. A blocking setup counts while the
 * request is still undecided (pending, or its approval failed).
 */
export function cannotApplyYet(
  row: CannotApplyYetRow,
  now: Date = new Date()
): CannotApplyYet | null {
  const status = row.status ?? "pending";
  if (status === "pending") {
    const held = record(record(row.data)?.held);
    if (
      held &&
      typeof held.reason === "string" &&
      typeof held.at === "string"
    ) {
      const reason: CannotApplyYetReason =
        HELD_REASON[String(held.errorClass)] ?? "not_connected";
      if (reason !== "daily_limit") return { reason, held: true, until: null };
      const until = typeof held.until === "string" ? held.until : null;
      const ends = until ? Date.parse(until) : NaN;
      if (until && Number.isFinite(ends) && ends > now.getTime())
        return { reason, held: true, until };
    }
  }
  if (
    (status === "pending" || status === "approval_failed") &&
    row.setup?.blocking === true
  ) {
    return { reason: "needs_setup", held: false, until: null };
  }
  return null;
}

/** The one sentence for a reason, naming the next step. */
export function cannotApplyYetLine(
  reason: CannotApplyYetReason,
  locale?: Locale
): string {
  return proposalsT(locale)(`proposals.cannotApplyYet.${reason}`);
}

/** The short label beside it ("Can’t apply yet"). */
export function cannotApplyYetLabel(locale?: Locale): string {
  return proposalsT(locale)("proposals.cannotApplyYet.label");
}
