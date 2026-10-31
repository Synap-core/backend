/**
 * THE status mark of a tool — one derivation, read by the Tools list row, its
 * gallery card and the tool's own page (`/open/capability/:id`,
 * `/open/skill/:id`). Two pills used to answer the same question and
 * disagree (the list's `capabilityPill` said "Healthy" where the page's
 * `capabilityStatusPill` said "Actions off"); this file replaced both.
 *
 * A capability's mark reads two facts:
 *   • its card's state (`capabilities.catalog`): can it run at all (an
 *     account, the pod offering it, its access to the service: the tool rows
 *     in `toolsOff`) and are its actions on — the verb's and the tool row's
 *     `approved` are both what the execution gate reads (decision D5). Until
 *     2026-10-30 only the verbs were read, so Hetzner Cloud read "On" with
 *     every run refused (its `hetzner_cloud` row was off);
 *   • its run health (`capabilities.compositions`): failed or stuck runs.
 * Worst first: it cannot run at all, then it is failing now, then actions are
 * off (every call to one is refused), then stuck runs, then On. A read that
 * failed leaves its half unknown, never "fine".
 *
 * A skill's (and a standalone integration's) mark is its `approved`: on or
 * off. Nothing else is known about it (an instruction is read by agents, and
 * the pod records no read of it).
 */

import type { AppRouter } from "@synap-core/api-types";
import type { inferRouterOutputs } from "@trpc/server";
import type { StatusKind } from "../../components/status-pill";
import { toolsT } from "./copy";

/** A catalog card's state, typed off the router so a new state fails here. */
export type CapabilityCardStatus =
  inferRouterOutputs<AppRouter>["capabilities"]["catalog"][number]["status"];

export interface RunHealth {
  status: "ok" | "degraded" | "failed" | "unknown";
  failedRuns: number;
  stuckRuns: number;
}

export interface StatusMark {
  kind: StatusKind;
  label: string;
}

/** What can stop it before any run: no account, not offered, not installed. */
function cannotRun(status: CapabilityCardStatus): StatusMark | null {
  const t = toolsT();
  switch (status) {
    case "needs_connection":
      return { kind: "down", label: t("status.needsAccount") };
    case "unavailable":
      return { kind: "unknown", label: t("status.notOffered") };
    case "available":
      return { kind: "unknown", label: t("status.notInstalled") };
    case "ready":
    case "partial":
    case "connected":
    case "draft":
      return null;
  }
}

/**
 * Actions turned off. A container whose card has no action at all is never
 * "Actions off" (the pod calls it `draft` because none is on, but there is
 * nothing to turn on).
 */
function actionsOff(
  status: CapabilityCardStatus,
  verbCount: number
): StatusMark | null {
  const t = toolsT();
  if (status === "partial")
    return { kind: "stale", label: t("status.someOff") };
  if ((status === "connected" || status === "draft") && verbCount > 0)
    return { kind: "stale", label: t("status.actionsOff") };
  return null;
}

/**
 * A capability's one mark. `card` is null when the catalog read failed or has
 * not answered; `health` is null when the compositions read did not.
 */
export function capabilityStatus(input: {
  card: {
    status: CapabilityCardStatus;
    verbs: readonly unknown[];
    toolsOff?: readonly unknown[];
  } | null;
  health: RunHealth | null;
}): StatusMark {
  const t = toolsT();
  const { card, health } = input;
  const blocked = card ? cannotRun(card.status) : null;
  if (blocked) return blocked;
  // Its access to the service is off: every run is refused, as surely as with
  // no account.
  if (card?.toolsOff && card.toolsOff.length > 0)
    return { kind: "down", label: t("status.accessOff") };
  if (health?.status === "failed")
    return {
      kind: "down",
      label: t("status.failedRuns", { n: health.failedRuns }),
    };
  const off = card ? actionsOff(card.status, card.verbs.length) : null;
  if (off) return off;
  if (health?.status === "degraded")
    return {
      kind: "stale",
      label: t("status.stuckRuns", { n: health.stuckRuns }),
    };
  // On only when the card says so: an unread card is never "On".
  if (card) return { kind: "healthy", label: t("status.on") };
  return { kind: "unknown", label: t("status.unknown") };
}

/**
 * A skill's or an integration's one mark: turned on (`approved`, the flag
 * the run gate reads for both rows) or not.
 */
export function approvedStatus(row: { approved: boolean }): StatusMark {
  const t = toolsT();
  return row.approved
    ? { kind: "healthy", label: t("status.on") }
    : { kind: "stale", label: t("status.off") };
}

/** How much a mark needs a look: down first, then stale, then the rest. */
export function statusRank(mark: StatusMark): number {
  return mark.kind === "down" ? 0 : mark.kind === "stale" ? 1 : 2;
}
