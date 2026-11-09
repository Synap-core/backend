/**
 * "Add this device", the side of a device the person ALREADY uses: the new
 * devices asking (`presence.deviceLink.pending`), and what each answer
 * leaves behind. Pure, so each state is tested; `DeviceLinkRequests.tsx`
 * draws it.
 *
 *  - a FAILED read is its own state, never "nobody asks": the Security page
 *    shows it with Try again; the banner on every other page shows nothing
 *    (a nudge, not the door);
 *  - a request past its time is not offered, even before the next read;
 *  - picking a number: the pod declines the request when it is not the one
 *    the new device shows (MISMATCH), says when it no longer waits (GONE),
 *    or approves; a person who closes the passkey dialog approved nothing,
 *    and nothing is said.
 */
import {
  PRESENCE_DEVICE_LINK_GONE,
  PRESENCE_DEVICE_LINK_MISMATCH,
  PRESENCE_DEVICE_LINK_SELF,
} from "@synap-core/types/presence";
import type { QueryLike } from "../../../proposal/[id]/proposal-session-model";
import { reasonCodeOf } from "./link-model";

/** How often a device the person uses looks for new devices asking. */
export const DEVICE_LINK_PENDING_POLL_MS = 10_000;

/** One request, as `presence.deviceLink.pending` answers it. */
export interface PendingDeviceLink {
  id: string;
  label: string;
  expiresAt: string;
  choices: readonly string[];
}

export interface PendingRow {
  id: string;
  label: string;
  /** Whole minutes left, rounded up (at least 1). */
  minutesLeft: number;
  choices: readonly string[];
}

export type RequestsView =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; rows: PendingRow[] };

export function requestsView(
  read: QueryLike<readonly PendingDeviceLink[]>,
  now: number
): RequestsView {
  // A read that failed after a good one still failed: never show stale rows
  // as if they were current.
  if (read.error != null) return { kind: "failed" };
  if (read.isLoading || !read.data) return { kind: "loading" };
  const rows = read.data.flatMap((r) => {
    const ms = Date.parse(r.expiresAt) - now;
    if (!Number.isFinite(ms) || ms <= 0) return [];
    return [
      {
        id: r.id,
        label: r.label,
        minutesLeft: Math.max(1, Math.ceil(ms / 60_000)),
        choices: r.choices,
      },
    ];
  });
  return { kind: "ready", rows };
}

/** Where the requests are drawn: every admin page (banner) or Security (page). */
export type RequestsPlacement = "banner" | "page";

/** What to draw: the rows, the failed read (Security only), or nothing. */
export function requestsShown(
  view: RequestsView,
  placement: RequestsPlacement
): "rows" | "failed" | null {
  if (view.kind === "failed") return placement === "page" ? "failed" : null;
  if (view.kind === "ready" && view.rows.length > 0) return "rows";
  return null;
}

/** What an answer left behind, said once under the requests. */
export type RequestReceipt =
  | "approved"
  | "declined"
  | "mismatch"
  | "gone"
  | "self"
  | "failed"
  | "declineFailed";

/**
 * The receipt of picking a number: approved, or why not. `declined`: the
 * person closed the passkey dialog (`PresenceDeclined`): nothing was
 * approved and nothing is said (null).
 */
export function approveReceipt(
  outcome: { ok: true } | { ok: false; error: unknown; declined: boolean }
): RequestReceipt | null {
  if (outcome.ok) return "approved";
  if (outcome.declined) return null;
  switch (reasonCodeOf(outcome.error)) {
    case PRESENCE_DEVICE_LINK_MISMATCH:
      return "mismatch";
    case PRESENCE_DEVICE_LINK_GONE:
      return "gone";
    case PRESENCE_DEVICE_LINK_SELF:
      return "self";
    default:
      return "failed";
  }
}

/** The receipt of "Not me". Declining twice is fine (the pod is idempotent). */
export function declineReceipt(
  outcome: { ok: true } | { ok: false; error: unknown }
): RequestReceipt {
  if (outcome.ok) return "declined";
  return reasonCodeOf(outcome.error) === PRESENCE_DEVICE_LINK_GONE
    ? "gone"
    : "declineFailed";
}

/** A receipt that is a failure (alert) rather than news (status). */
export function receiptIsFailure(receipt: RequestReceipt): boolean {
  return receipt === "failed" || receipt === "declineFailed";
}
